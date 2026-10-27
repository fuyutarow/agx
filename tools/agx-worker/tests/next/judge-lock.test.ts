import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import {
  acquireWorkspaceLock,
  type WorkspaceLockWaitClock,
} from "../../src/next/store.ts";
import { judgeRun } from "../../src/next/run.ts";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../../src/next/cli.ts");
const store = resolve(import.meta.dir, "../../src/next/store.ts");
const logRecordSchema = jsonOf(
  z.object({ kind: z.enum(["started", "judged", "ended"]) }),
);

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(ended: boolean) {
  const root = await mkdtemp(join(tmpdir(), "agx-judge-lock-"));
  roots.push(root);
  const id = "judge-lock-fixture";
  const records = join(root, "records.jsonl");
  const started = {
    kind: "started",
    id,
    at: "2026-10-27T00:00:00Z",
    ticket: "fixture",
    writes: [],
    cwd: root,
    workspace: root,
    row: "fixture",
    dispatcher_session: null,
    vendor_session: null,
    pid: process.pid,
  };
  const events: Record<string, unknown>[] = [started];
  if (ended)
    events.push({
      kind: "ended",
      id,
      at: "2026-10-27T00:01:00Z",
      exit: 0,
      report_path: null,
      vendor_session: null,
      verify: [],
    });
  await writeFile(
    records,
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
  return { root, id, records };
}

function launchJudge(root: string, id: string, timeout = 5_000) {
  const child = Bun.spawn([process.execPath, cli, "judge", id, "accept"], {
    env: { ...process.env, AGX_STATE_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  return {
    child,
    result: Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]).then(([stdout, stderr, exit]) => ({ stdout, stderr, exit })),
  };
}

async function readLine(
  stream: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return undefined;
    text += decoder.decode(value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) {
      reader.releaseLock();
      return text.slice(0, newline);
    }
  }
}

async function holdPublicationLock(root: string) {
  const script = join(root, "judge-lock-holder.ts");
  await writeFile(
    script,
    `import { join } from "node:path";
import { acquireWorkspaceLock } from ${JSON.stringify(store)};
const root = process.argv[2];
if (root === undefined) throw new Error("missing lock fixture root");
const lock = await acquireWorkspaceLock(join(root, "current-runs.json"), root);
if (!lock.ok) throw new Error(lock.error);
const released = new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
process.stdout.write(String(process.pid) + "\\n");
await released;
await lock.release();
`,
  );
  const child = Bun.spawn([process.execPath, script, root], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  const pidText = await readLine(child.stdout);
  const pid = Number(pidText);
  expect(pidText).toBeDefined();
  expect(Number.isInteger(pid)).toBe(true);
  let released = false;
  return {
    child,
    pid,
    release: async () => {
      if (released) return;
      released = true;
      await child.stdin.write("release");
      await child.stdin.end();
      await child.exited;
    },
  };
}

function virtualClock(
  pollIntervalMs: number,
  onAdvance?: (now: number) => Promise<void>,
) {
  let now = 0;
  const clock: WorkspaceLockWaitClock = {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
      await onAdvance?.(now);
    },
    pollIntervalMs,
  };
  return { clock, elapsed: () => now };
}

function capturedJudge(
  root: string,
  id: string,
  clock: WorkspaceLockWaitClock,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = judgeRun(
    { id, decision: "accept" },
    {
      root,
      lockWaitClock: clock,
      writeStdout: (line) => {
        stdout.push(line);
      },
      onLockFailure: (message, exitCode) => {
        stderr.push(`agx: ${message}\n`);
        return exitCode;
      },
    },
  );
  return {
    result,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

describe("worker contract: judge lock", () => {
  test("waits for a 2 s publication lock held by another process", async () => {
    const { root, id } = await fixture(true);
    const holder = await holdPublicationLock(root);
    await using _holder = { [Symbol.asyncDispose]: holder.release };
    const contention = await acquireWorkspaceLock(
      join(root, "current-runs.json"),
      root,
    );
    expect(contention.ok).toBe(false);
    if (contention.ok) await contention.release();
    let holderReleased = false;
    const clock = virtualClock(500, async (now) => {
      if (now >= 2000 && !holderReleased) {
        holderReleased = true;
        await holder.release();
      }
    });
    const started = clock.elapsed();
    const result = capturedJudge(root, id, clock.clock);
    const exit = await result.result;
    const elapsed = clock.elapsed() - started;
    expect(exit).toBe(0);
    expect(result.stderr()).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(10_000);
    expect(result.stdout()).toContain('"verdict":"accept"');
  });

  test("fails after the bound with the lock holder pid and command", async () => {
    const { root, records } = await fixture(true);
    const original = await readFile(records, "utf8");
    const holder = await holdPublicationLock(root);
    await using _holder = { [Symbol.asyncDispose]: holder.release };
    const contention = await acquireWorkspaceLock(
      join(root, "current-runs.json"),
      root,
    );
    expect(contention.ok).toBe(false);
    if (contention.ok) await contention.release();
    const clock = virtualClock(5000);
    const result = capturedJudge(root, "judge-lock-fixture", clock.clock);
    expect(await result.result).toBe(2);
    expect(result.stdout()).toBe("");
    expect(result.stderr()).toContain("stayed busy past 30000ms");
    expect(result.stderr()).toContain(`holder pid=${holder.pid}`);
    expect(result.stderr()).toContain("judge-lock-holder.ts");
    expect(await readFile(records, "utf8")).toBe(original);
  });

  test("records against the run id before its end is published", async () => {
    const { root, id, records } = await fixture(false);
    const noticeAt = performance.now();
    const result = await launchJudge(root, id).result;
    const judgedAt = performance.now();
    expect(result.exit).toBe(0);
    expect(judgedAt - noticeAt).toBeLessThan(1000);
    appendFileSync(
      records,
      `${JSON.stringify({ kind: "ended", id, at: "2026-10-27T00:01:00Z", exit: 0, report_path: null, vendor_session: null, verify: [] })}\n`,
    );
    const log = (await readFile(records, "utf8")).trimEnd().split("\n");
    expect(
      log.flatMap((line) => {
        const record = logRecordSchema.safeParse(line);
        return record.success ? [record.data.kind] : [];
      }),
    ).toEqual([
      "started",
      "judged",
      "ended",
    ]);
    const { foldedRuns } = await import("../../src/next/store.ts");
    expect((await foldedRuns(root)).find((run) => run.id === id)).toMatchObject(
      {
        state: "ended",
        judgment: { decision: "accept" },
      },
    );
  });
});
