import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

setDefaultTimeout(40_000);

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
      outcome: "ok",
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

function launchJudge(root: string, id: string, extra: string[] = [], timeout = 5_000) {
  const child = Bun.spawn(
    [process.execPath, cli, "judge", id, "accept", ...extra],
    {
      env: { ...subprocessEnvironment(), AGX_STATE_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    },
  );
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

async function writeHolder(root: string) {
  const script = join(root, "judge-lock-holder.ts");
  await writeFile(
    script,
    `import { join } from "node:path";
import { acquireWorkspaceLock } from ${JSON.stringify(store)};
const root = process.argv[2];
if (root === undefined) throw new Error("missing lock fixture root");
const lock = await acquireWorkspaceLock(join(root, "current-runs.json"), root);
if (!lock.ok) throw new Error(lock.error);
const released = new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
  process.stdin.once("end", () => resolve());
});
process.stdout.write(String(process.pid) + "\\n");
await released;
await lock.release();
`,
  );
  return script;
}

async function holdPublicationLock(root: string) {
  const script = await writeHolder(root);
  const child = Bun.spawn([process.execPath, script, root], {
    env: subprocessEnvironment(),
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
  test("worker contract: judge lock holder exits when its test process dies", async () => {
    const { root } = await fixture(true);
    const script = await writeHolder(root);
    const parentScript = join(root, "holder-parent.ts");
    await writeFile(
      parentScript,
      `
const child = Bun.spawn([process.execPath, process.argv[2], process.argv[3]], {
  stdin: "pipe", stdout: "inherit", stderr: "inherit",
});
await child.exited;
`,
    );
    const parent = Bun.spawn([process.execPath, parentScript, script, root], {
      env: subprocessEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    let pid: number | undefined;
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        parent.kill();
        const cleanupPid = pid;
        if (
          cleanupPid !== undefined &&
          Number.isInteger(cleanupPid) &&
          cleanupPid > 0
        )
          await Promise.try(() => process.kill(cleanupPid, "SIGKILL")).catch(
            () => {},
          );
      },
    };
    const pidText = await readLine(parent.stdout);
    pid = Number(pidText);
    expect(pidText).toBeDefined();
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    parent.kill("SIGKILL");
    await parent.exited;
    const deadline = performance.now() + 2_000;
    let alive = true;
    while (alive && performance.now() < deadline) {
      alive = await Promise.try(() => process.kill(pid, 0)).then(
        () => true,
        () => false,
      );
      if (alive) await Bun.sleep(20);
    }
    expect(alive).toBe(false);
  });
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

  test("refuses an unended run and records an override after an incomplete end", async () => {
    const { root, id, records } = await fixture(false);
    const holder = await holdPublicationLock(root);
    await using _holder = { [Symbol.asyncDispose]: holder.release };
    const result = await launchJudge(root, id).result;
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("before it ends");
    const prematureOverride = await launchJudge(root, id, [
      "--override",
      "reviewed",
    ]).result;
    expect(prematureOverride.exit).not.toBe(0);
    expect(prematureOverride.stderr).toContain("before it ends");
    expect(await readFile(records, "utf8")).not.toContain('"judged"');
    await holder.release();
    appendFileSync(
      records,
      `${JSON.stringify({ kind: "ended", id, at: "2026-10-27T00:01:00Z", exit: 0, report_path: null, vendor_session: null, verify: [] })}\n`,
    );
    const overridden = await launchJudge(root, id, ["--override", "reviewed"])
      .result;
    expect(overridden.exit).toBe(0);
    const log = (await readFile(records, "utf8")).trimEnd().split("\n");
    expect(
      log.flatMap((line) => {
        const record = logRecordSchema.safeParse(line);
        return record.success ? [record.data.kind] : [];
      }),
    ).toEqual(["started", "ended", "judged"]);
    const { foldedRuns } = await import("../../src/next/store.ts");
    expect((await foldedRuns(root)).find((run) => run.id === id)).toMatchObject(
      {
        state: "ended",
        judgment: { decision: "accept" },
      },
    );
  });
});

async function stalledPublication(root: string) {
  const { chmod } = await import("node:fs/promises");
  const probe = join(root, "systemctl");
  const started = join(root, "probe-started");
  const release = join(root, "probe-release");
  await writeFile(
    probe,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(started)}, "started");\nwhile (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(10);\nprocess.stdout.write("inactive\\n");\n`,
  );
  await chmod(probe, 0o755);
  appendFileSync(
    join(root, "records.jsonl"),
    JSON.stringify({
      kind: "started",
      id: "slow-probe",
      at: "2026-10-27T00:00:00Z",
      ticket: "slow",
      writes: [],
      cwd: root,
      workspace: join(root, "slow"),
      row: "fixture",
      dispatcher_session: null,
      vendor_session: null,
      pid: 2147483647,
      lease: { pid: 2147483647, start: null, unit: "slow.service" },
    }) + "\n",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { publishCurrentRuns } from ${JSON.stringify(store)}; await publishCurrentRuns(${JSON.stringify(root)});`,
    ],
    {
      env: subprocessEnvironment({ PATH: `${root}:${process.env.PATH ?? ""}` }),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  const deadline = performance.now() + 4000;
  while (!(await Bun.file(started).exists()) && performance.now() < deadline)
    await Bun.sleep(10);
  expect(await Bun.file(started).exists()).toBe(true);
  return {
    child,
    release: async () => {
      await Bun.write(release, "release");
    },
    stderr: () => child.stderr.text(),
  };
}

test("worker contract: judge succeeds while publication probes are slow", async () => {
  const { root, id } = await fixture(true);
  const publication = await stalledPublication(root);
  await (async () => {
    await using cleanup = {
      [Symbol.asyncDispose]: async () => {
        await publication.release();
        expect(await publication.child.exited).toBe(0);
      },
    };
    void cleanup;
    const judge = launchJudge(root, id);
    const result = await judge.result;
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('"verdict":"accept"');
    expect(publication.child.exitCode).toBeNull();
  })();
});

test("worker contract: publication does not lose a concurrent judge", async () => {
  const { root, id } = await fixture(true);
  const publication = await stalledPublication(root);
  await (async () => {
    await using cleanup = {
      [Symbol.asyncDispose]: async () => {
        await publication.release();
        expect(await publication.child.exited).toBe(0);
      },
    };
    void cleanup;
    const result = await launchJudge(root, id).result;
    expect(result.exit).toBe(0);
  })();
  const snapshot = jsonOf(
    z.object({
      acceptedRuns: z.array(
        z.object({
          id: z.string(),
          judgment: z.object({ decision: z.string() }).nullable(),
        }),
      ),
    }),
  ).safeParse(await readFile(join(root, "current-runs.json"), "utf8"));
  expect(snapshot.success).toBe(true);
  if (!snapshot.success) expect.unreachable("invalid snapshot");
  expect(
    snapshot.data.acceptedRuns.find((run) => run.id === id)?.judgment,
  ).toEqual({ decision: "accept" });
  expect(await readFile(join(root, "records.jsonl"), "utf8")).toContain(
    '"decision":"accept"',
  );
});
