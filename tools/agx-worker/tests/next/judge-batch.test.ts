import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { judgeBatch } from "../../src/next/run.ts";
import { recordedRuns, acquireWorkspaceLockUntilAvailable, publishCurrentRuns } from "../../src/next/store.ts";

const resultSchema = jsonOf(z.object({ status: z.string() }));
const statuses = (output: string) => output.trim().split("\n").map((line) => {
  const result = resultSchema.safeParse(line);
  return result.success ? result.data.status : undefined;
});

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../../src/next/cli.ts");
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agx-judge-batch-"));
  roots.push(root);
  const records = join(root, "records.jsonl");
  const events = ["one", "two", "three", "incomplete"].flatMap((id) => [
    { kind: "started", id, at: "2026-10-27T00:00:00Z", ticket: id, writes: [], cwd: root, workspace: root, row: "fixture", dispatcher_session: null, vendor_session: null, pid: process.pid },
    { kind: "ended", id, at: "2026-10-27T00:01:00Z", exit: 0, ...(id === "incomplete" ? {} : { outcome: "ok" }), report_path: null, vendor_session: null, verify: [] },
  ]);
  await writeFile(records, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  async function run(lines: unknown[]) {
    const file = join(root, "batch.jsonl");
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const child = Bun.spawn([process.execPath, cli, "judge", "--from", file], { env: { ...subprocessEnvironment(), AGX_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    return { stdout, stderr, exit };
  }
  return { root, records, run };
}

test("batch applies all judgments and rerun appends nothing", async () => {
  const f = await fixture();
  const lines = ["one", "two", "three"].map((run) => ({ run, decision: "reject", note: "reviewed" }));
  const first = await f.run(lines);
  expect(first.exit).toBe(0);
  expect(statuses(first.stdout)).toEqual(["applied", "applied", "applied"]);
  const records = await readFile(f.records, "utf8");
  expect(records.match(/"kind":"judged"/gu)).toHaveLength(3);
  expect(await Bun.file(join(f.root, "current-runs.json")).exists()).toBe(true);
  const second = await f.run(lines);
  expect(second.exit).toBe(0);
  expect(statuses(second.stdout)).toEqual(["unchanged", "unchanged", "unchanged"]);
  expect(await readFile(f.records, "utf8")).toBe(records);
});

test("one load, lock acquisition and publication for three judgments", async () => {
  const f = await fixture();
  const file = join(f.root, "counts.jsonl");
  await writeFile(file, ["one", "two", "three"].map((run) => JSON.stringify({ run, decision: "reject" })).join("\n") + "\n");
  const counts = { load: 0, lock: 0, publish: 0 };
  const result = await judgeBatch(file, {
    root: f.root,
    load: async (...args) => { counts.load++; return recordedRuns(...args); },
    lock: async (...args) => { counts.lock++; return acquireWorkspaceLockUntilAvailable(...args); },
    publish: async (...args) => { counts.publish++; return publishCurrentRuns(...args); },
    writeStdout: () => {},
  });
  expect(result).toBe(0);
  expect(counts).toEqual({ load: 1, lock: 1, publish: 1 });
});

test("invalid lines and incomplete accepts leave records untouched", async () => {
  const f = await fixture();
  const before = await readFile(f.records, "utf8");
  const result = await f.run([{ run: "one", decision: "reject" }, { run: "missing", decision: "reject" }, { run: "incomplete", decision: "accept" }]);
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("line 2:");
  expect(result.stderr).toContain("line 3:");
  expect(result.stderr).toContain("incomplete");
  expect(await readFile(f.records, "utf8")).toBe(before);
  expect(await Bun.file(join(f.root, "current-runs.json")).exists()).toBe(false);
});
