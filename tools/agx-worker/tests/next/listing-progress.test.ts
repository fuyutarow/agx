import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseFor } from "../../src/next/lease.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const at = "2026-10-24T00:00:00Z";
const progress = {
  schema: 1,
  last: "fixture command",
  at,
  commands: 7,
  files: 3,
  turns: 2,
  usage: { input_tokens: 123, output_tokens: 45 },
  cost_usd: 0.125,
  session: "vendor-live",
};
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-c2-progress-"));
  roots.push(root);
  const state = join(root, "state");
  mkdirSync(join(state, "active"), { recursive: true });
  const lease = await leaseFor(process.pid, null);
  const ids = [
    "current",
    "legacy",
    "missing",
    "invalid",
    "unreadable",
    "zero",
    "ended",
  ];
  const events: unknown[] = ids.map((id) => ({
    kind: "started",
    id,
    at,
    ticket: id,
    writes: [],
    cwd: root,
    workspace: root,
    row: "fixture",
    dispatcher_session: "dispatcher-only",
    vendor_session: "vendor-recorded",
    pid: process.pid,
    lease,
  }));
  events.push(
    { kind: "progress", id: "current", at, path: "interim-return.json" },
    {
      kind: "ended",
      id: "ended",
      at,
      exit: 0,
      outcome: "ok",
      report_path: null,
      vendor_session: "vendor-ended",
      verify: [],
    },
  );
  writeFileSync(
    join(state, "records.jsonl"),
    events.map((event) => JSON.stringify(event) + "\n").join(""),
  );
  const write = (id: string, value: unknown) => {
    mkdirSync(join(state, "runs", id), { recursive: true });
    writeFileSync(
      join(state, "runs", id, "worker-progress.jsonl"),
      JSON.stringify(value),
    );
  };
  write("current", progress);
  write("ended", progress);
  write("invalid", { ...progress, commands: -1 });
  mkdirSync(join(state, "runs", "unreadable", "worker-progress.jsonl"), {
    recursive: true,
  });
  write("zero", { schema: 1, at, last: "starting", commands: 0, files: 0 });
  for (const id of ["current", "legacy", "invalid"])
    writeFileSync(
      join(state, "active", `${id}.progress.json`),
      JSON.stringify({ ...progress, commands: 99, session: "vendor-legacy" }),
    );
  for (const id of ["legacy", "missing"])
    writeFileSync(
      join(state, "active", `${id}.json`),
      JSON.stringify({
        schema: 1,
        run_id: id,
        pid: process.pid,
        label: id,
        choice: "fixture",
        pick_source: "fixture",
        started_at: at,
        cwd: root,
        dispatcher_session: "must-not-replace-dispatcher",
        worker_session: "vendor-marker",
      }),
    );
  return { root, state };
};

const rowSchema = z.object({
  id: z.string(),
  dispatcher_session: z.string().nullable(),
  vendor_session: z.string().nullable(),
  last_progress_path: z.string().nullable(),
  progress: z
    .object({
      last: z.string(),
      at: z.string(),
      commands: z.number(),
      files: z.number(),
      turns: z.number().nullable(),
      usage: z.record(z.string(), z.unknown()).nullable(),
      usage_reason: z.string().nullable(),
      cost_usd: z.number().nullable(),
      cost_reason: z.string().nullable(),
      session: z.string().nullable(),
    })
    .nullable(),
  progress_source: z.enum(["run", "active"]).nullable(),
  progress_status: z.enum(["available", "missing", "invalid", "unreadable"]),
  progress_fresh_at: z.string().nullable(),
  progress_reason: z.string().nullable(),
});
const invoke = (root: string, state: string, ...flags: string[]) => {
  const { AGX_NEXT_STATE_DIR: _retired, ...env } = process.env;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "tools/agx-worker/src/next/cli.ts",
      "ls",
      "--json",
      ...flags,
    ],
    {
      env: { ...env, AGX_STATE_DIR: state, XDG_STATE_HOME: join(root, "xdg") },
      timeout: 15_000,
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
};

const parseRows = (text: string) => {
  const parsed = jsonOf(z.array(rowSchema)).safeParse(text);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : [];
};

test("real ls JSON projects cumulative counts, source precedence, unknowns and separate identities", async () => {
  const { root, state } = await fixture();
  const rows = parseRows(invoke(root, state));
  const current = rows.find((row) => row.id === "current");
  const { schema: _schema, ...expected } = progress;
  expect(current?.progress).toEqual({
    ...expected,
    usage_reason: null,
    cost_reason: null,
  });
  expect(current?.progress_source).toBe("run");
  expect(current?.progress_status).toBe("available");
  expect(current?.progress_fresh_at).toBe(at);
  expect(current?.last_progress_path).toBe("interim-return.json");
  expect(current?.dispatcher_session).toBe("dispatcher-only");
  expect(current?.vendor_session).toBe("vendor-live");
  const legacy = rows.find((row) => row.id === "legacy");
  expect(legacy?.progress?.commands).toBe(99);
  expect(legacy?.progress_source).toBe("active");
  expect(legacy?.vendor_session).toBe("vendor-legacy");
  const missing = rows.find((row) => row.id === "missing");
  expect(missing?.progress).toBeNull();
  expect(missing?.progress_source).toBeNull();
  expect(missing?.progress_fresh_at).toBeNull();
  expect(missing?.progress_status).toBe("missing");
  expect(missing?.vendor_session).toBe("vendor-marker");
  expect(missing?.dispatcher_session).toBe("dispatcher-only");
  for (const id of ["invalid", "unreadable"] as const) {
    const row = rows.find((entry) => entry.id === id);
    expect(row?.progress).toBeNull();
    expect(row?.progress_fresh_at).toBeNull();
    expect(row?.progress_status).toBe(id);
    expect(row?.progress_source).toBe("run");
  }
  expect(rows.find((row) => row.id === "zero")?.progress).toEqual({
    last: "starting",
    at,
    commands: 0,
    files: 0,
    turns: null,
    usage: null,
    usage_reason: "vendor has not reported usage yet",
    cost_usd: null,
    cost_reason:
      "vendor has not reported cost and no usage-based estimate is available",
    session: null,
  });
  expect(rows.find((row) => row.id === "ended")?.vendor_session).toBe(
    "vendor-ended",
  );
  const selected = parseRows(invoke(root, state, "current"));
  if (current === undefined) expect.unreachable("fixture has no current run");
  expect(selected).toEqual([current]);
  const waited = parseRows(invoke(root, state, "ended", "--wait"));
  const ended = rows.find((row) => row.id === "ended");
  if (ended === undefined) expect.unreachable("fixture has no ended run");
  expect(waited).toEqual([ended]);
  const summary = jsonOf(z.object({ runs: z.array(rowSchema) })).safeParse(
    invoke(root, state, "--summary", "--workspace", root),
  );
  expect(summary.success).toBe(true);
  if (summary.success) expect(summary.data.runs).toEqual(rows);
});

test("running JSON exposes live counters and explains unknown progress and usage", async () => {
  const { root, state } = await fixture();
  writeFileSync(
    join(state, "runs", "current", "worker-progress.jsonl"),
    JSON.stringify({ ...progress, usage: {}, cost_usd: undefined }),
  );
  const schema = z.array(
    rowSchema.extend({
      progress: rowSchema.shape.progress
        .unwrap()
        .extend({
          usage_reason: z.string().nullable(),
          cost_reason: z.string().nullable(),
        })
        .nullable(),
    }),
  );
  const parsed = jsonOf(schema).safeParse(invoke(root, state, "--running"));
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const rows = parsed.data;
  expect(rows.some((row) => row.id === "ended")).toBe(false);
  const live = rows.find((row) => row.id === "current");
  expect(live?.progress).toMatchObject({
    last: progress.last,
    at,
    commands: 7,
    files: 3,
    turns: 2,
    usage: null,
    cost_usd: null,
  });
  expect(live?.progress_reason).toBeNull();
  expect(live?.progress?.usage_reason).toContain("vendor has not reported");
  expect(live?.progress?.cost_reason).toContain("no usage-based estimate");
  expect(rows.find((row) => row.id === "missing")?.progress_reason).toContain(
    "producer may predate",
  );
  for (const id of ["invalid", "unreadable"])
    expect(rows.find((row) => row.id === id)?.progress_reason).toBeString();
});

test("real ls rejects malformed progress and ignores mismatched active identities", async () => {
  const { root, state } = await fixture();
  writeFileSync(
    join(state, "active", "missing.json"),
    JSON.stringify({
      schema: 1,
      run_id: "other-run",
      pid: process.pid,
      label: "wrong",
      choice: "fixture",
      pick_source: "fixture",
      started_at: at,
      cwd: root,
      worker_session: "wrong-session",
    }),
  );
  writeFileSync(join(state, "active", "legacy.progress.json"), "{broken");
  writeFileSync(
    join(state, "runs", "current", "worker-progress.jsonl"),
    JSON.stringify({ ...progress, at: "not-a-time" }),
  );
  const rows = parseRows(invoke(root, state));
  expect(rows.find((row) => row.id === "missing")?.vendor_session).toBe(
    "vendor-recorded",
  );
  for (const id of ["current", "legacy"]) {
    expect(rows.find((row) => row.id === id)?.progress).toBeNull();
    expect(rows.find((row) => row.id === id)?.progress_status).toBe("invalid");
  }
});
