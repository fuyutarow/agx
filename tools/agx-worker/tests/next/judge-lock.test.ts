import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(40_000);

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../../src/next/cli.ts");
const store = resolve(import.meta.dir, "../../src/next/store.ts");
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

function launchJudge(root: string, id: string, timeout = 10_000) {
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

async function holdPublicationLock(root: string, releaseAfterMs?: number) {
  const ready = join(root, "holder-ready");
  const release = join(root, "holder-release");
  const script = join(root, "judge-lock-holder.ts");
  await writeFile(
    script,
    `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkspaceLock } from ${JSON.stringify(store)};
const [root, ready, release, delay] = process.argv.slice(2);
if (root === undefined || ready === undefined || release === undefined || delay === undefined) throw new Error("missing lock fixture args");
const lock = await acquireWorkspaceLock(join(root, "current-runs.json"), root);
if (!lock.ok) throw new Error(lock.error);
writeFileSync(ready, String(process.pid));
if (delay === "release") while (!existsSync(release)) await Bun.sleep(5);
else await Bun.sleep(Number(delay));
await lock.release();
`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      script,
      root,
      ready,
      release,
      releaseAfterMs === undefined ? "release" : String(releaseAfterMs),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 36_000 },
  );
  const readyDeadline = performance.now() + 5000;
  while (!existsSync(ready) && performance.now() < readyDeadline)
    await Bun.sleep(5);
  expect(existsSync(ready)).toBe(true);
  const pid = Number(readFileSync(ready, "utf8"));
  return { child, pid, release };
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(5);
  return predicate();
}

describe("worker contract: judge lock", () => {
  test("waits for a 2 s publication lock held by another process", async () => {
    const { root, id } = await fixture(true);
    const holder = await holdPublicationLock(root, 2000);
    const started = performance.now();
    try {
      const result = await launchJudge(root, id).result;
      const elapsed = performance.now() - started;
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe("");
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await holder.child.exited;
    }
  });

  test("fails after the bound with the lock holder pid and command", async () => {
    const { root, id, records } = await fixture(true);
    const original = await readFile(records, "utf8");
    const holder = await holdPublicationLock(root);
    try {
      const result = await launchJudge(root, id, 36_000).result;
      expect(result.exit).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("stayed busy past 30000ms");
      expect(result.stderr).toContain(`holder pid=${holder.pid}`);
      expect(result.stderr).toContain("judge-lock-holder.ts");
      expect(await readFile(records, "utf8")).toBe(original);
    } finally {
      await writeFile(holder.release, "release");
      await holder.child.exited;
    }
  });

  test("records against the run id before its end is published", async () => {
    const { root, id, records } = await fixture(false);
    const noticeAt = performance.now();
    const judge = launchJudge(root, id);
    const appeared = await waitFor(
      () => readFileSync(records, "utf8").includes('"kind":"judged"'),
      1000,
    );
    const judgedAt = performance.now();
    expect(appeared).toBe(true);
    appendFileSync(
      records,
      `${JSON.stringify({ kind: "ended", id, at: "2026-10-27T00:01:00Z", exit: 0, report_path: null, vendor_session: null, verify: [] })}\n`,
    );
    const result = await judge.result;
    expect(result.exit).toBe(0);
    expect(judgedAt - noticeAt).toBeLessThan(1000);
    const log = (await readFile(records, "utf8")).trimEnd().split("\n");
    expect(log.map((line) => JSON.parse(line).kind)).toEqual([
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
