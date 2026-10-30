import { appendFile } from "node:fs/promises";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  append,
  events,
  flushRunPublications,
  foldedRuns,
  fullFoldedRuns,
  listingHistory,
  recordPath,
  type NextEvent,
} from "../../src/next/store.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

import { list } from "../../src/next/run.ts";

const previous = process.env.AGX_STATE_DIR;
const roots: string[] = [];
afterEach(async () => {
  await flushRunPublications();
  if (previous === undefined) delete process.env.AGX_STATE_DIR;
  else process.env.AGX_STATE_DIR = previous;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "agx-incremental-fold-"));
  roots.push(root);
  process.env.AGX_STATE_DIR = root;
  return root;
};
const started = (id: string, pid = 2147483647): NextEvent => ({
  kind: "started",
  id,
  at: "2026-10-15T00:00:00Z",
  ticket: "incremental",
  writes: [],
  cwd: "/tmp",
  workspace: "/tmp",
  row: "terra-medium",
  dispatcher_session: null,
  vendor_session: null,
  pid,
});

test("store contract: a record with an end_notice.status written before 1.20.2 is read", async () => {
  const root = fixture();
  const cases = [
    {
      id: "legacy-skip",
      notice: { exit: null, receipt: "skipped: no dispatcher" },
      status: "skipped",
    },
    {
      id: "legacy-accepted",
      notice: { exit: 0, receipt: "sent" },
      status: "accepted",
    },
    {
      id: "legacy-deadline",
      notice: { exit: 4, receipt: "deadline" },
      status: "deadline",
    },
    {
      id: "legacy-unreachable",
      notice: { exit: 127, receipt: "not found" },
      status: "unreachable",
    },
    {
      id: "current-pending",
      notice: { status: "pending", exit: null, receipt: "scheduled" },
      status: "pending",
    },
    {
      id: "current-accepted",
      notice: { status: "accepted", exit: 0, receipt: "sent" },
      status: "accepted",
    },
    {
      id: "current-unreachable",
      notice: { status: "unreachable", exit: 7, receipt: "failed" },
      status: "unreachable",
    },
    {
      id: "current-deadline",
      notice: { status: "deadline", exit: 4, receipt: "deadline" },
      status: "deadline",
    },
    {
      id: "current-skipped",
      notice: { status: "skipped", exit: null, receipt: "skipped" },
      status: "skipped",
    },
  ];
  const records = cases.flatMap(({ id, notice }) => [
    started(id),
    {
      kind: "ended",
      id,
      at: "2026-10-15T00:01:00Z",
      exit: 0,
      outcome: "ok",
      report_path: null,
      vendor_session: null,
      verify: [],
      end_notice: notice,
    },
  ]);
  fs.writeFileSync(
    recordPath(root),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const rows = await foldedRuns(root);
  expect(rows.map((row) => [row.id, row.end_notice?.status])).toEqual(
    cases.map(({ id, status }) => [id, status]),
  );
});

test("store contract: one unreadable record line is skipped and named with its file and line", async () => {
  const root = fixture();
  const records = [
    JSON.stringify(started("survivor")),
    "not-json",
    JSON.stringify({
      kind: "ended",
      id: "survivor",
      at: "2026-10-15T00:01:00Z",
      exit: 0,
      report_path: null,
      vendor_session: null,
      verify: [],
    }),
  ];
  fs.writeFileSync(recordPath(root), `${records.join("\n")}\n`);

  const decoded = events(root);
  expect(decoded.map(({ kind }) => kind)).toEqual(["started", "ended"]);
  expect((await foldedRuns(root))[0]?.state).toBe("ended");

  const listed = Bun.spawnSync(
    [process.execPath, "tools/agx-worker/src/next/cli.ts", "ls", "--json"],
    { env: { ...subprocessEnvironment(), AGX_STATE_DIR: root } },
  );
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString()).toContain('"id":"survivor"');
  expect(listed.stderr.toString()).toContain(`${recordPath(root)}:2`);
});

test.each([127, 137])(
  "historical verify-failed exit %s is classified in full and cached folds",
  async (exit) => {
    const root = fixture();
    append(started("legacy-verify"));
    append({
      kind: "ended",
      id: "legacy-verify",
      at: "2026-10-15T00:01:00Z",
      exit: 0,
      outcome: "verify-failed",
      report_path: null,
      vendor_session: null,
      verify: [{ cmd: "check", exit, log_path: "check.log" }],
    });
    const kind = exit === 127 ? "unrunnable" : "killed";
    expect((await fullFoldedRuns())[0]?.verify[0]?.kind).toBe(kind);
    expect((await fullFoldedRuns())[0]?.outcome).toBe(`verify-${kind}`);
    expect(await foldedRuns()).toEqual(await fullFoldedRuns());
    expect(fs.existsSync(join(root, "records.fold.json"))).toBe(false);
    expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  },
);

test("seeded random append batches equal a full fold after every batch", async () => {
  const root = fixture();
  // Exercise the fold without asynchronous publication sealing synthetic dead PIDs.
  const appendEvent = (event: Parameters<typeof append>[0]) => {
    append(event, root, false);
  };
  let seed = 42;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const appendRandom = (batch: number) => {
    const id = `run-${random(20)}`;
    const kind = random(4);
    if (kind === 0) appendEvent(started(id, process.pid));
    if (kind === 1)
      appendEvent({
        kind: "progress",
        id,
        at: "2026-10-15T00:00:01Z",
        path: `日本語-${batch}`,
      });
    if (kind === 2)
      appendEvent({
        kind: "ended",
        id,
        at: "2026-10-15T00:01:00Z",
        exit: random(2),
        report_path: null,
        vendor_session: null,
        verify: [
          {
            cmd: "check",
            exit: 0,
            log_path: "/tmp/check",
            future_field: "preserved",
          },
        ],
        returned: false,
        changed_files: 0,
      });
    if (kind === 3)
      appendEvent({
        kind: "judged",
        id,
        at: "2026-10-15T00:02:00Z",
        decision:
          ["accept", "reject", "landed", "ignored"][random(4)] ?? "accept",
        note: `batch-${batch}`,
      });
  };
  for (let batch = 0; batch < 150; batch++) {
    for (let i = 0, n = random(9) + 1; i < n; i++) {
      appendRandom(batch);
    }
    expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  }
}, 15_000);

test("warm fold reads exactly appended record bytes and zero for unchanged history", async () => {
  fixture();
  append(started("run"));
  for (let i = 0; i < 1000; i++)
    append({ kind: "progress", id: "run", at: "now", path: `${i}` });
  await flushRunPublications();
  await foldedRuns();
  const before = fs.statSync(recordPath()).size;
  // Simulate another writer without racing append()'s asynchronous snapshot publisher.
  await appendFile(
    recordPath(),
    `${JSON.stringify({ kind: "judged", id: "run", at: "now", decision: "accept", note: "tail" })}\n`,
  );
  const appended = fs.statSync(recordPath()).size - before;
  const read = spyOn(fs, "readSync");
  const whole = spyOn(fs, "readFileSync");
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await list({ json: true })).toBe(0);
  expect(read.mock.calls).toHaveLength(1);
  expect(read.mock.calls[0]?.[2]?.length).toBe(appended);
  expect(read.mock.calls[0]?.[2]?.position).toBe(before);
  read.mockClear();
  await foldedRuns();
  expect(read.mock.calls).toHaveLength(0);
  expect(whole.mock.calls.some(([path]) => path === recordPath())).toBe(false);
  output.mockRestore();
  whole.mockRestore();
  read.mockRestore();
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
});

test("warm listing retains malformed imports without rereading history, while folds skip them", async () => {
  const root = fixture();
  append(started("native", process.pid));
  await flushRunPublications();
  await foldedRuns();
  const malformed = {
    ...started("legacy"),
    row: 42,
    legacy: { run_id: "old", source: "legacy-v1" },
  };
  const before = fs.statSync(recordPath()).size;
  await appendFile(recordPath(), `${JSON.stringify(malformed)}\n`);
  const appended = fs.statSync(recordPath()).size - before;
  const read = spyOn(fs, "readSync");
  const whole = spyOn(fs, "readFileSync");
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  const warning = spyOn(process.stderr, "write").mockImplementation(() => true);
  using _restore = {
    [Symbol.dispose]: () => {
      warning.mockRestore();
      output.mockRestore();
      whole.mockRestore();
      read.mockRestore();
    },
  };
  const history = await listingHistory();
  expect(history.runs.map((run) => run.id)).toEqual(["native"]);
  expect(history.malformed).toEqual([malformed]);
  expect(read.mock.calls).toHaveLength(1);
  expect(read.mock.calls[0]?.[2]?.length).toBe(appended);
  expect(read.mock.calls[0]?.[2]?.position).toBe(before);
  read.mockClear();
  expect(await listingHistory()).toEqual(history);
  expect(await list({ json: true })).toBe(0);
  expect(
    warning.mock.calls.some(([line]) => String(line).includes("hidden_legacy=1")),
  ).toBe(true);
  expect(await list({ json: true, includeLegacy: true })).toBe(0);
  expect(output.mock.calls.at(-1)?.[0]).toContain('"row":42');
  expect(read.mock.calls).toHaveLength(0);
  expect(whole.mock.calls.some(([path]) => path === recordPath())).toBe(false);
  const strict = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      'import { listingHistory, foldedRuns } from "./tools/agx-worker/src/next/store.ts"; await listingHistory(); await foldedRuns();',
    ],
    { env: { ...subprocessEnvironment(), AGX_STATE_DIR: root }, timeout: 5000 },
  );
  expect(strict.exitCode).toBe(0);
  expect(strict.stderr.toString()).toContain(`${recordPath(root)}:2`);
  fs.writeFileSync(recordPath(), "");
  expect(await listingHistory()).toEqual({ runs: [], malformed: [] });
});

test("partial UTF-8 tail is reread, and rotation, truncation, corrupt cache and version changes rebuild", async () => {
  const root = fixture();
  append(started("first"));
  await foldedRuns();
  const tail = Buffer.from(
    JSON.stringify({
      kind: "progress",
      id: "first",
      at: "now",
      path: "日本語",
    }) + "\n",
  );
  const split = tail.indexOf(Buffer.from("本")) + 1;
  fs.appendFileSync(recordPath(), tail.subarray(0, split));
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  expect(fs.existsSync(join(root, "records.fold.json"))).toBe(false);
  fs.appendFileSync(recordPath(), tail.subarray(split));
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  fs.renameSync(recordPath(), join(root, "rotated.jsonl"));
  append(started("rotated"));
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  fs.writeFileSync(recordPath(), "");
  expect(await foldedRuns()).toEqual([]);
  append(started("new"));
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  fs.writeFileSync(join(root, "records.fold.json"), '{"version":999}');
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  fs.writeFileSync(join(root, "records.fold.json"), "broken");
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
});

test("ls --running combines with JSON, all and selector; cached liveness is refreshed", async () => {
  const root = fixture();
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(async () => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  append(started("live", child.pid));
  append(started("orphan"));
  append(started("ended", process.pid));
  append({
    kind: "ended",
    id: "ended",
    at: "2026-10-15T00:01:00Z",
    exit: 0,
    report_path: null,
    vendor_session: null,
    verify: [],
  });
  const ls = (args: string[]) =>
    Bun.spawnSync(
      [process.execPath, "tools/agx-worker/src/next/cli.ts", "ls", ...args],
      { env: { ...subprocessEnvironment(), AGX_STATE_DIR: root } },
    );
  const json = ls(["--running", "--json", "--all"]);
  expect(json.exitCode).toBe(0);
  expect(json.stdout.toString()).toContain('"id":"live"');
  expect(json.stdout.toString()).not.toContain('"id":"orphan"');
  expect(json.stdout.toString()).not.toContain('"id":"ended"');
  const human = ls(["incremental", "--running", "--all"]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout.toString()).toContain("live running");
  expect(human.stdout.toString()).not.toContain("orphan");
  await foldedRuns();
  child.kill();
  await child.exited;
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  using _restoreOutput = { [Symbol.dispose]: () => { output.mockRestore(); } };
  expect(await list({ running: true, json: true })).toBe(0);
  expect(output.mock.calls.at(-1)?.[0]).toBe("[]\n");
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
});

test("unwritable snapshot falls back safely and malformed complete tail is skipped", async () => {
  const root = fixture();
  append(started("run"));
  fs.mkdirSync(join(root, "records.fold.json"));
  expect(await foldedRuns()).toEqual(await fullFoldedRuns());
  await flushRunPublications();
  expect(fs.readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
  fs.rmSync(join(root, "records.fold.json"), { recursive: true });
  await foldedRuns();
  fs.appendFileSync(recordPath(), '{"kind":"broken"}\n');
  const result = Bun.spawnSync(
    [process.execPath, "tools/agx-worker/src/next/cli.ts", "ls", "--json"],
    { env: { ...subprocessEnvironment(), AGX_STATE_DIR: root } },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain(`${recordPath(root)}:3`);
});
