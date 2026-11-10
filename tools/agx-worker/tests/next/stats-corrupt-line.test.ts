import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliPath = join(repoRoot, "tools/agx/src/agx.ts");
const workerCliPath = join(repoRoot, "tools/agx-worker/src/next/cli.ts");
const policyPath = join(
  repoRoot,
  "tools/agx-worker/src/roster/policy.example.toml",
);
const NUL = "\u0000";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Temporary state root only: the real ~/.local/state/agx is never touched.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-stats-corrupt-"));
  roots.push(root);
  for (const dir of ["bin", "state", "home", "state/legacy-v1", "work"])
    mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(workerCliPath, join(root, "bin/agx-worker"));
  writeFileSync(join(root, "policy.toml"), readFileSync(policyPath, "utf8"));
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg"),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    AGX_CONFIG: join(root, "policy.toml"),
    AGX_TEST_CWD: join(root, "work"),
    TYPESAFE_API_KEY: "fixture-key",
    PATH: `${join(root, "bin")}:${dirname(process.execPath)}`,
  };
  for (const key of [
    "AGX_NEXT_STATE_DIR",
    "JEV_URL",
    "AGX_NEXT_JEV_URL",
    "JEX_JEV_URL",
  ])
    Reflect.deleteProperty(env, key);
  return { root, env };
}

const args = [process.execPath, cliPath, "worker"];
const stats = (env: NodeJS.ProcessEnv) => {
  const cwd = env.AGX_TEST_CWD!;
  expect(cwd).toContain("agx-stats-corrupt-");
  return Bun.spawnSync([...args, "stats", "--usage", "jev", "--window", "7d"], {
    env,
    cwd,
    timeout: 15_000,
  });
};

const Report = jsonOf(
  z.object({
    known_input_tokens: z.number().nullable(),
    known_output_tokens: z.number().nullable(),
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    unknown: z.object({ historical_runs: z.number(), time: z.number() }),
    coverage: z.object({
      observed_records_complete: z.boolean(),
      legacy_known_usage_records: z.number(),
      skipped_lines: z.array(z.object({ path: z.string(), count: z.number() })),
    }),
  }),
);

const OUTSIDE_HOURS = 24 * 40;
const hoursAgo = (hours: number) =>
  Temporal.Instant.fromEpochMilliseconds(
    Temporal.Now.instant().epochMilliseconds - hours * 3_600_000,
  ).toString();
const utcDay = (daysAgo: number) =>
  Temporal.Instant.fromEpochMilliseconds(
    Temporal.Now.instant().epochMilliseconds - daysAgo * 86_400_000,
  )
    .toString()
    .slice(0, 10);

// Each row is a complete JSON object; `prefix` damages a line the way a crash does.
function legacyFile(
  root: string,
  name: string,
  lines: { row: unknown; prefix?: string }[],
) {
  const body = lines
    .map((line) => `${line.prefix ?? ""}${JSON.stringify(line.row)}`)
    .join("\n");
  const path = join(root, "state/legacy-v1", name);
  writeFileSync(path, `${body}\n`);
  return path;
}

const usageRow = (
  runId: string,
  hours: number,
  input: number,
  output: number,
) => ({
  kind: "run",
  run_id: runId,
  started_at: hoursAgo(hours),
  pick: {
    jev: {
      response: { usage: { input_tokens: input, output_tokens: output } },
    },
  },
});

test("a dated legacy file outside the window with a NUL-prefixed line is not read", () => {
  const { root, env } = fixture();
  writeFileSync(
    join(root, "state/jev-usage.jsonl"),
    JSON.stringify({
      schema: 1,
      id: "capture",
      at: hoursAgo(1),
      tokens: { input_tokens: 100, output_tokens: 20 },
      pricing: {
        input_per_mtok: 0.042,
        output_per_mtok: 0,
        currency: "USD",
        source: "fixture",
        as_of: "2026-10-08",
        basis: "effective configuration; not a billing quote",
      },
    }) + "\n",
  );
  const baseline = stats(env);
  expect(baseline.exitCode, baseline.stderr.toString()).toBe(0);
  const before = Report.safeParse(baseline.stdout.toString());
  expect(before.success).toBe(true);

  // Rows are outside the 7d window, as the file's name says they must be.
  legacyFile(root, "runs-2026-10-10.jsonl", [
    { row: usageRow("old-good", OUTSIDE_HOURS, 999, 999) },
    {
      row: usageRow("old-damaged", OUTSIDE_HOURS + 1, 999, 999),
      prefix: NUL.repeat(57),
    },
  ]);
  const result = stats(env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const after = Report.safeParse(result.stdout.toString());
  expect(after.success, result.stdout.toString()).toBe(true);
  if (!before.success || !after.success) return;
  expect(after.data.known_input_tokens).toBe(before.data.known_input_tokens);
  expect(after.data.known_output_tokens).toBe(before.data.known_output_tokens);
  expect(after.data.input_tokens).toBe(before.data.input_tokens);
  expect(after.data.coverage.skipped_lines).toEqual([]);
}, 15000);

test("an in-window legacy file with one NUL-prefixed line totals the good lines and warns once", () => {
  const { root, env } = fixture();
  // Named for yesterday (UTC): the name bound must keep it, since rows may be stamped up to a day later.
  const path = legacyFile(root, `runs-${utcDay(1)}.jsonl`, [
    { row: usageRow("good-a", 2, 50, 10) },
    { row: usageRow("damaged", 3, 999, 999), prefix: NUL.repeat(57) },
    { row: usageRow("good-b", 4, 5, 1) },
  ]);
  const result = stats(env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const stderr = result.stderr.toString();
  expect(stderr.split(path).length - 1).toBe(1);
  expect(stderr).toContain("skipped 1 unparseable line(s)");
  const data = Report.safeParse(result.stdout.toString());
  expect(data.success, result.stdout.toString()).toBe(true);
  if (!data.success) return;
  expect(data.data.known_input_tokens).toBe(55);
  expect(data.data.known_output_tokens).toBe(11);
  expect(data.data.coverage.legacy_known_usage_records).toBe(2);
  expect(data.data.coverage.skipped_lines).toEqual([{ path, count: 1 }]);
  expect(data.data.coverage.observed_records_complete).toBe(false);
  expect(data.data.input_tokens).toBeNull();
  expect(data.data.output_tokens).toBeNull();
}, 15000);

test("an undated legacy file last written before the window is not read", () => {
  const { root, env } = fixture();
  const path = legacyFile(root, "runs.jsonl", [
    { row: usageRow("old", OUTSIDE_HOURS, 1, 1), prefix: NUL.repeat(3) },
  ]);
  // utimes takes seconds; the file is last written well before the 7d window.
  const old =
    Temporal.Instant.from("2026-10-11T00:00:00Z").epochMilliseconds / 1000;
  utimesSync(path, old, old);
  const result = stats(env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const data = Report.safeParse(result.stdout.toString());
  expect(data.success, result.stdout.toString()).toBe(true);
  if (!data.success) return;
  expect(data.data.coverage.skipped_lines).toEqual([]);
  expect(data.data.known_input_tokens).toBeNull();
}, 15000);
