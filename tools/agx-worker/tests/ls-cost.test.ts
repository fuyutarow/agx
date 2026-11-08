import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import {
  newRoutingAudit,
  recordRoutingPick,
} from "../src/next/routing-events.ts";
import {
  append,
  events,
  flushRunPublications,
  recordPath,
  setPendingPickAudit,
} from "../src/next/store.ts";

const cli = join(import.meta.dir, "../src/next/cli.ts");
const makeAudit = (id: string) => ({
  decision_id: id,
  input: { text: 'quote " brace } bracket ] \\ ' + "y".repeat(3000) },
  filters: [{ reason: "r", removed: [], after: ["a"] }],
});
const ended = (id: string) => ({
  kind: "ended",
  id,
  at: "2026-10-15T00:02:00Z",
  exit: 0,
  outcome: "ok",
  report_path: null,
  vendor_session: null,
  verify: [],
  returned: true,
  changed_files: 1,
});
const judged = (id: string, evidence: boolean) => ({
  kind: "judged",
  id,
  at: "2026-10-15T00:03:00Z",
  decision: "accept",
  note: "ok",
  ...(evidence
    ? {
        evidence: [
          {
            path: "/e.txt",
            sha256: "00",
            content: 'c } "' + "z".repeat(2000),
          },
        ],
      }
    : {}),
});
const renderRows = (rows: object[]) =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const previous = process.env.AGX_STATE_DIR;
const roots: string[] = [];
afterEach(async () => {
  await flushRunPublications();
  if (previous === undefined) delete process.env.AGX_STATE_DIR;
  else process.env.AGX_STATE_DIR = previous;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-ls-cost-"));
  roots.push(root);
  process.env.AGX_STATE_DIR = root;
  return root;
};
const jsonLines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => jsonOf(z.record(z.string(), z.unknown())).safeParse(line))
    .flatMap((result) => (result.success ? [result.data] : []));

const baseStarted = (id: string) => ({
  kind: "started" as const,
  id,
  at: "2026-10-15T00:00:00Z",
  ticket: `ticket-${id}`,
  writes: [],
  cwd: "/tmp",
  workspace: "/tmp",
  row: "terra-medium",
  dispatcher_session: null,
  vendor_session: null,
  pid: 2147483647,
});

test("a new started record carries decision_id, not pick_audit; the audit is stored by that id", () => {
  const root = fixture();
  const pickAudit = newRoutingAudit({ path: "/tmp/t.md", sha256: null });
  pickAudit.input = { big: "x".repeat(5000) };
  recordRoutingPick({ id: "terra-medium", route: "codex" }, "jev", pickAudit);
  setPendingPickAudit({
    audit: pickAudit,
    source: "jev",
    probabilities: null,
    usage_snapshot: null,
    usage_id: "usage-1",
  });
  append(baseStarted("run-new"), root, false);

  const started = jsonLines(recordPath(root)).find(
    (row) => row.kind === "started",
  );
  expect(started?.decision_id).toBe(pickAudit.decision_id);
  expect(started?.usage_id).toBe("usage-1");
  expect(started).not.toHaveProperty("pick_audit");
  expect(readFileSync(recordPath(root), "utf8")).not.toContain("xxxxxxxxxx");

  const journal = join(
    root,
    `routing-${Temporal.Now.instant().toString().slice(0, 10)}.jsonl`,
  );
  const routing = jsonLines(journal);
  const stored = routing.filter(
    (row) =>
      z.object({ decision_id: z.string() }).safeParse(row.audit).data
        ?.decision_id === pickAudit.decision_id,
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]?.audit).toMatchObject({ input: { big: "x".repeat(5000) } });

  // The lifecycle row references the decision; it does not repeat the audit.
  append(
    {
      kind: "ended",
      id: "run-new",
      at: "2026-10-15T00:01:00Z",
      exit: 0,
      report_path: null,
      vendor_session: null,
      verify: [],
    },
    root,
    false,
  );
  const lifecycle = jsonLines(journal).filter(
    (row) => row.source === "lifecycle",
  );
  expect(lifecycle).toHaveLength(1);
  expect(lifecycle[0]?.audit).toEqual({
    decision_id: pickAudit.decision_id,
    outcome_kind: "held",
    run_id: "run-new",
    worker_outcome: null,
  });
});

const lsJson = (root: string) => {
  const result = Bun.spawnSync([process.execPath, cli, "ls", "--json"], {
    env: subprocessEnvironment({ AGX_STATE_DIR: root }),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString("utf8");
};

test("ls --json is identical for old lines (copied audit, inline evidence), new lines, and a mix", () => {
  const oldLines = (id: string): object[] => [
    {
      ...baseStarted(id),
      pick_audit: {
        audit: makeAudit(`d-${id}`),
        source: "jev",
        probabilities: null,
        usage_snapshot: null,
        usage_id: `u-${id}`,
      },
    },
    ended(id),
    judged(id, true),
  ];
  const newLines = (id: string): object[] => [
    { ...baseStarted(id), decision_id: `d-${id}`, usage_id: `u-${id}` },
    ended(id),
    judged(id, false),
  ];
  const state = (rows: object[]) => {
    const root = fixture();
    writeFileSync(join(root, "records.jsonl"), renderRows(rows));
    return root;
  };
  const ids = ["a", "b", "c", "d"];
  const allOld = lsJson(state(ids.flatMap((id) => oldLines(id))));
  const allNew = lsJson(state(ids.flatMap((id) => newLines(id))));
  const mixed = lsJson(
    state(
      ids.flatMap((id, index) =>
        index % 2 === 0 ? oldLines(id) : newLines(id),
      ),
    ),
  );
  const oldOutput = jsonOf(z.array(z.unknown())).safeParse(allOld);
  expect(oldOutput.success).toBe(true);
  if (oldOutput.success) expect(oldOutput.data).toHaveLength(4);
  expect(allNew).toBe(allOld);
  expect(mixed).toBe(allOld);
});

test("an old started line yields its decision_id without its audit payload", () => {
  const root = fixture();
  const line = JSON.stringify({
    ...baseStarted("old"),
    pick_audit: {
      audit: { decision_id: "d-old", note: 'has "} ,"pick_audit": inside' },
      source: "jev",
      probabilities: null,
      usage_snapshot: null,
    },
    legacy_key: "kept-after-pick-audit",
  });
  writeFileSync(join(root, "records.jsonl"), `${line}\n`);
  const [event] = events(root);
  expect(event).toMatchObject({
    kind: "started",
    decision_id: "d-old",
    legacy_key: "kept-after-pick-audit",
  });
  expect(event).not.toHaveProperty("pick_audit");
});
