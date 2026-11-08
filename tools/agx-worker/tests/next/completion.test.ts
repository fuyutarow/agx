import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../../src/next/cli.ts");
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(
  id: string,
  ended: {
    outcome: string;
    exit: number;
    verify: readonly { cmd: string; exit: number; log_path: string }[];
    changed_files?: number;
  },
  writes: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "agx-completion-contract-"));
  roots.push(root);
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  const runDir = join(state, "runs", id);
  mkdirSync(state, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(workspace, "work.txt"), "changed by run\n");
  const events = [
    {
      kind: "started",
      id,
      at: "2026-10-28T00:00:00Z",
      ticket: "completion-contract",
      writes,
      cwd: workspace,
      workspace,
      row: "fixture-row",
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
    },
    {
      kind: "ended",
      id,
      at: "2026-10-28T00:01:00Z",
      report_path: null,
      vendor_session: null,
      ...ended,
      verify: ended.verify.map((check, index) => ({
        ...check,
        log_path: join(runDir, `verify-${index + 1}.log`),
      })),
    },
  ];
  writeFileSync(
    join(state, "records.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    { flag: "w" },
  );
  return { root, state, id };
}

function command(
  args: string[],
  state: string,
): { exit: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    env: { ...subprocessEnvironment(), AGX_STATE_DIR: state },
  });
  return {
    exit: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("worker listing classifies a timed-out run whose verify passed with a diff as verified-timeout", () => {
  const run = fixture("verified-timeout", {
    outcome: "timeout",
    exit: 124,
    verify: [{ cmd: "bun check", exit: 0, log_path: "unused" }],
    changed_files: 2,
  });
  const listed = command(["ls", "--json", "--all"], run.state);
  expect(listed.exit).toBe(0);
  expect(listed.stderr).toBe("");
  expect(listed.stdout).toContain('"completion":"verified-timeout"');
});

test("worker listing classifies timed-out runs without a passing verify as incomplete", () => {
  const cases = [
    { name: "no-verify", verify: [], changed_files: 2 },
    {
      name: "failed-verify",
      verify: [{ cmd: "bun check", exit: 1, log_path: "unused" }],
      changed_files: 2,
    },
  ];
  for (const item of cases) {
    const run = fixture(item.name, {
      outcome: "timeout",
      exit: 124,
      verify: item.verify,
      changed_files: item.changed_files,
    });
    const result = command(["ls", item.name, "--json"], run.state);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('"completion":"incomplete"');
  }
});

test("judge contract: accept refuses an incomplete run without an override", () => {
  const run = fixture("incomplete-accept", {
    outcome: "verify-failed",
    exit: 1,
    verify: [{ cmd: "bun check", exit: 1, log_path: "unused" }],
    changed_files: 1,
  });
  const original = readFileSync(join(run.state, "records.jsonl"), "utf8");
  const refused = command(["judge", run.id, "accept"], run.state);
  expect(refused.exit).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("completion=incomplete");
  expect(refused.stderr).toContain('"outcome":"verify-failed"');
  expect(readFileSync(join(run.state, "records.jsonl"), "utf8")).toBe(original);

  const overridden = command(
    ["judge", run.id, "accept", "--override", "reviewed incomplete work"],
    run.state,
  );
  expect(overridden.exit).toBe(0);
  expect(overridden.stdout).toContain(
    '"override_reason":"reviewed incomplete work"',
  );
  const events = readFileSync(join(run.state, "records.jsonl"), "utf8")
    .trimEnd()
    .split("\n");
  const judgment = jsonOf(
    z.object({
      kind: z.literal("judged"),
      override_reason: z.string(),
    }),
  ).safeParse(events.at(-1));
  expect(judgment.success).toBe(true);
  if (judgment.success)
    expect(judgment.data.override_reason).toBe("reviewed incomplete work");
  const listed = command(["ls", run.id, "--json"], run.state);
  expect(listed.exit).toBe(0);
  expect(listed.stdout).toContain(
    '"override_reason":"reviewed incomplete work"',
  );
});

test("judge contract: accept permits a done run without an override", () => {
  const run = fixture("done-accept", {
    outcome: "ok",
    exit: 0,
    verify: [{ cmd: "bun check", exit: 0, log_path: "unused" }],
    changed_files: 1,
  });
  const result = command(["judge", run.id, "accept"], run.state);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
});

test("completion contract: a read-only ticket with passing verify is complete without override", () => {
  const run = fixture("readonly-accept", {
    outcome: "no-change",
    exit: 0,
    verify: [{ cmd: "bun check", exit: 0, log_path: "unused" }],
    changed_files: 0,
  });
  const result = command(["judge", run.id, "accept"], run.state);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  const events = readFileSync(join(run.state, "records.jsonl"), "utf8");
  expect(events).toContain('"decision":"accept"');
  expect(events).not.toContain('"override_reason"');
});

test("a no-change run of a ticket with writes is still incomplete", () => {
  const run = fixture(
    "writes-incomplete",
    {
      outcome: "no-change",
      exit: 0,
      verify: [{ cmd: "bun check", exit: 0, log_path: "unused" }],
      changed_files: 0,
    },
    ["work.txt"],
  );
  const original = readFileSync(join(run.state, "records.jsonl"), "utf8");
  const result = command(["judge", run.id, "accept"], run.state);
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("completion=incomplete");
  expect(readFileSync(join(run.state, "records.jsonl"), "utf8")).toBe(original);
});

test.each([
  { name: "missing-verify", verify: [], changed_files: 0 },
  {
    name: "failed-verify",
    verify: [{ cmd: "check", exit: 1, log_path: "unused" }],
    changed_files: 0,
  },
  {
    name: "unknown-diff",
    verify: [{ cmd: "check", exit: 0, log_path: "unused" }],
  },
  {
    name: "nonempty-diff",
    verify: [{ cmd: "check", exit: 0, log_path: "unused" }],
    changed_files: 1,
  },
])(
  "completion contract: read-only no-change needs passing verify and a known empty diff: $name",
  (item) => {
    const run = fixture(item.name, { outcome: "no-change", exit: 0, ...item });
    const result = command(["judge", run.id, "accept"], run.state);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("completion=incomplete");
  },
);
