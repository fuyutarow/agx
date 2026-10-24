import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`;
const run = {
  kind: "run",
  run_id: "original-run",
  cwd: "/tmp/legacy-workspace",
  ticket: { name: "legacy-ticket" },
  started_at: at(1),
  ended_at: at(2),
  exit: 0,
};
const judgment = (day: number, decision: string, note = decision) => ({
  type: "judged",
  run_id: run.run_id,
  at: at(day),
  decision,
  note,
});
const rowsSchema = z.array(
  z.looseObject({
    id: z.string(),
    workspace: z.string(),
    ticket: z.string(),
    legacy: z.object({ run_id: z.string(), source: z.literal("legacy-v1") }),
    judgment: z
      .object({
        decision: z.string(),
        at: z.string(),
        note: z.string(),
        legacy_key: z.string().optional(),
      })
      .nullable(),
  }),
);
const statsSchema = z.looseObject({
  runs: z.number(),
  judgments: z.number(),
  legacy_import: z
    .object({
      runs_imported: z.number(),
      judgments_imported: z.number(),
      progress_imported: z.number(),
      malformed_lines: z.number(),
      ignored_rows: z.number(),
    })
    .optional(),
});
function decode<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  const parsed = jsonOf(schema).safeParse(text);
  assert.ok(parsed.success, text);
  return parsed.data;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-c3-"));
  roots.push(root);
  const state = join(root, "state");
  const source = join(state, "legacy-v1");
  mkdirSync(source, { recursive: true });
  const env = {
    ...process.env,
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "xdg"),
  };
  const cli = (...args: string[]) => {
    const child = Bun.spawnSync(
      [process.execPath, resolve("tools/agx-worker/src/next/cli.ts"), ...args],
      { env, timeout: 15_000 },
    );
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return child.stdout.toString();
  };
  const write = (name: string, rows: unknown[]) => {
    writeFileSync(
      join(source, name),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  };
  const listing = () => decode(rowsSchema, cli("ls", "--json", "--all"));
  const stats = (importing = true) =>
    decode(
      statsSchema,
      cli("stats", ...(importing ? ["--import-legacy"] : [])),
    );
  return { state, source, cli, write, listing, stats };
}

test("C3 real CLI imports lifecycle and dated rows by judgment time, preserving identity and counts", () => {
  const f = fixture();
  f.write("runs.jsonl", [
    run,
    { kind: "acceptance", run_id: run.run_id, at: at(5), accept: false },
  ]);
  f.write("runs-2026-10-01.jsonl", [
    judgment(20, "accept", "late in older archive"),
  ]);
  f.write("runs-2026-10-15.jsonl", [judgment(10, "reject")]);
  f.write("lifecycle.jsonl", [
    judgment(15, "reject"),
    judgment(20, "accept", "late in older archive"),
    { type: "admitted" },
    judgment(16, "invalid"),
    { ...judgment(17, "reject"), at: "bad" },
  ]);
  appendFileSync(join(f.source, "lifecycle.jsonl"), "not json\n");
  const before = readdirSync(f.state).toSorted();
  expect(f.stats(false).runs).toBe(0);
  expect(f.listing()).toEqual([]);
  expect(readdirSync(f.state).toSorted()).toEqual(before);
  const first = f.stats();
  expect(first).toMatchObject({
    runs: 1,
    judgments: 4,
    legacy_import: {
      runs_imported: 1,
      judgments_imported: 4,
      progress_imported: 0,
      malformed_lines: 3,
      ignored_rows: 1,
    },
  });
  const listed = f.listing();
  expect(listed[0]?.id).toMatch(/^legacy-[a-f0-9]{24}$/u);
  expect(listed[0]).toMatchObject({
    workspace: run.cwd,
    ticket: run.ticket.name,
    legacy: { run_id: run.run_id, source: "legacy-v1" },
    judgment: { at: at(20), decision: "accept", note: "late in older archive" },
  });
  const log = readFileSync(join(f.state, "records.jsonl"), "utf8");
  expect(f.stats()).toMatchObject({
    runs: first.runs,
    judgments: first.judgments,
    legacy_import: {
      runs_imported: 0,
      judgments_imported: 0,
      progress_imported: 0,
    },
  });
  expect(readFileSync(join(f.state, "records.jsonl"), "utf8")).toBe(log);
  expect(f.listing()).toEqual(listed);
  f.write("lifecycle-2026-09-01.jsonl", [
    judgment(24, "reject", "late discovered file"),
  ]);
  expect(f.stats().legacy_import?.judgments_imported).toBe(1);
  expect(f.listing()[0]?.judgment).toMatchObject({
    at: at(24),
    decision: "reject",
  });
});

test("C3 equal-time imported ties are deterministic across discovery order, native ties win", () => {
  const a = fixture();
  const b = fixture();
  for (const f of [a, b]) f.write("runs.jsonl", [run]);
  a.write("lifecycle.jsonl", [judgment(10, "accept")]);
  b.write("lifecycle.jsonl", [judgment(10, "reject")]);
  a.stats();
  b.stats();
  a.write("runs-2026-10-01.jsonl", [judgment(10, "reject")]);
  b.write("runs-2026-10-01.jsonl", [judgment(10, "accept")]);
  a.stats();
  b.stats();
  expect(a.listing()[0]?.judgment).toEqual(b.listing()[0]?.judgment);
  const id = a.listing()[0]?.id;
  appendFileSync(
    join(a.state, "records.jsonl"),
    JSON.stringify({
      kind: "judged",
      id,
      at: at(10),
      decision: "reject",
      note: "current tie",
    }) + "\n",
  );
  expect(a.listing()[0]?.judgment).toEqual({
    at: at(10),
    decision: "reject",
    note: "current tie",
  });
  a.write("lifecycle-2026-10-01.jsonl", [
    judgment(10, "accept", "imported after native"),
  ]);
  a.stats();
  expect(a.listing()[0]?.judgment?.note).toBe("current tie");
  a.write("lifecycle-2026-10-02.jsonl", [
    judgment(11, "accept", "newer than native"),
  ]);
  a.stats();
  expect(a.listing()[0]?.judgment?.note).toBe("newer than native");
  appendFileSync(
    join(a.state, "records.jsonl"),
    JSON.stringify({
      kind: "judged",
      id,
      at: at(9),
      decision: "reject",
      note: "older native",
    }) + "\n",
  );
  expect(a.listing()[0]?.judgment?.note).toBe("newer than native");
});

test("C3 compares instants with offsets and nanoseconds, and projects historical identity", () => {
  const f = fixture();
  f.write("runs.jsonl", [run]);
  f.write("lifecycle.jsonl", [
    { ...judgment(10, "accept"), at: "2026-10-10T13:00:00.000000001+01:00" },
    judgment(10, "reject"),
  ]);
  f.stats();
  expect(f.listing()[0]?.judgment).toMatchObject({
    decision: "accept",
    at: "2026-10-10T13:00:00.000000001+01:00",
  });
  // A prior importer wrote only legacy_key on the started record.
  const path = join(f.state, "records.jsonl");
  const log = readFileSync(path, "utf8");
  writeFileSync(
    path,
    log.replace(',"legacy":{"run_id":"original-run","source":"legacy-v1"}', ""),
  );
  expect(f.listing()[0]?.legacy).toEqual({
    run_id: run.run_id,
    source: "legacy-v1",
  });
  const id = f.listing()[0]?.id;
  assert.ok(id !== undefined);
  f.cli("judge", id, "reject", "--note", "public judge");
  const current = f.listing()[0]?.judgment;
  expect(current?.note).toBe("public judge");
  expect(z.iso.datetime({ offset: true }).safeParse(current?.at).success).toBe(
    true,
  );
});

test("C3 defers orphan judgments until their run is available", () => {
  const f = fixture();
  f.write("lifecycle.jsonl", [judgment(10, "landed")]);
  expect(f.stats()).toMatchObject({
    runs: 0,
    judgments: 0,
    legacy_import: { judgments_imported: 0, ignored_rows: 1 },
  });
  f.write("runs.jsonl", [run]);
  expect(f.stats()).toMatchObject({
    runs: 1,
    judgments: 1,
    legacy_import: { runs_imported: 1, judgments_imported: 1, ignored_rows: 0 },
  });
  expect(f.listing()[0]?.judgment).toMatchObject({
    decision: "accept",
    at: at(10),
  });
  expect(f.stats().legacy_import?.judgments_imported).toBe(0);
});
