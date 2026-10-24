import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-jev-usage-"));
  roots.push(root);
  for (const dir of ["bin", "state", "home", "state/legacy-v1"])
    mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(
    resolve("tools/agx-worker/src/next/cli.ts"),
    join(root, "bin/agx-worker"),
  );
  writeFileSync(
    join(root, "policy.toml"),
    readFileSync("tools/agx-worker/src/roster/policy.example.toml", "utf8"),
  );
  const env = {
    ...process.env,
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg"),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    AGX_CONFIG: join(root, "policy.toml"),
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
const args = [process.execPath, "tools/agx/src/agx.ts", "worker"];
const stats = (
  env: NodeJS.ProcessEnv,
  extra = ["--usage", "jev", "--window", "7d"],
) => Bun.spawnSync([...args, "stats", ...extra], { env, timeout: 15_000 });
const Report = jsonOf(
  z.object({
    schema: z.literal(1),
    usage: z.literal("jev"),
    window: z.string(),
    from: z.string(),
    to: z.string(),
    captured_at: z.string(),
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    known_input_tokens: z.number().nullable(),
    known_output_tokens: z.number().nullable(),
    pricing: z.object({
      input_per_mtok: z.number(),
      output_per_mtok: z.number(),
      source: z.string(),
      as_of: z.string(),
      observed_at: z.string(),
    }),
    known_tokens_at_effective_price_usd: z.number().nullable(),
    completeness: z.literal("partial"),
    unknown: z.object({
      usage: z.number(),
      historical_runs: z.number(),
      captured_calls: z.number(),
      time: z.number(),
      historical_pricing: z.number(),
    }),
    coverage: z.object({
      history_complete: z.literal(false),
      observed_records_complete: z.boolean(),
      captured_calls: z.number(),
      known_usage_records: z.number(),
      legacy_known_usage_records: z.number(),
      trailing_partial_record: z.boolean(),
      usage_journal_present: z.boolean(),
    }),
  }),
);
function report(result: ReturnType<typeof stats>) {
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const parsed = Report.safeParse(result.stdout.toString());
  expect(parsed.success, result.stdout.toString()).toBe(true);
  if (!parsed.success) return process.exit(1);
  return parsed.data;
}
const at = (hours: number) =>
  Temporal.Instant.fromEpochMilliseconds(
    Temporal.Now.instant().epochMilliseconds - hours * 3_600_000,
  ).toString();
const price = {
  input_per_mtok: 0.042,
  output_per_mtok: 0,
  currency: "USD",
  source: "fixture capture price",
  as_of: "2026-10-08",
  basis: "effective configuration; not a billing quote",
};
const capture = (
  hours: number,
  tokens: { input_tokens: number; output_tokens: number } | null,
  id = crypto.randomUUID(),
) => ({ schema: 1, id, at: at(hours), tokens, pricing: price });
function journal(root: string, name: string, rows: unknown[]) {
  writeFileSync(
    join(root, "state", name),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

test("real CLI sums only in-window evidence, and missing historical usage is never zero", () => {
  const { root, env } = fixture();
  journal(root, "jev-usage.jsonl", [
    capture(1, { input_tokens: 100, output_tokens: 20 }),
    capture(169, { input_tokens: 9000, output_tokens: 9000 }),
    capture(-1, { input_tokens: 8000, output_tokens: 8000 }),
    capture(2, null),
  ]);
  journal(root, "records.jsonl", [
    { kind: "started", id: "historical", at: at(3) },
    { kind: "started", id: "outside", at: at(200) },
  ]);
  journal(root, "legacy-v1/runs-2026-10-23.jsonl", [
    {
      kind: "run",
      run_id: "old-known",
      started_at: at(4),
      pick: {
        jev: { response: { usage: { input_tokens: 50, output_tokens: 10 } } },
      },
    },
    { kind: "run", run_id: "old-missing", started_at: at(5) },
    { kind: "run", run_id: "old-outside", started_at: at(200) },
  ]);
  const before = readFileSync(join(root, "state/jev-usage.jsonl"), "utf8");
  const data = report(stats(env));
  expect(data.known_input_tokens).toBe(150);
  expect(data.known_output_tokens).toBe(30);
  expect(data.input_tokens).toBeNull();
  expect(data.output_tokens).toBeNull();
  expect(data.unknown).toEqual({
    usage: 3,
    historical_runs: 2,
    captured_calls: 1,
    time: 0,
    historical_pricing: 1,
  });
  expect(data.coverage.captured_calls).toBe(2);
  expect(data.coverage.legacy_known_usage_records).toBe(1);
  expect(data.known_tokens_at_effective_price_usd).toBeCloseTo(
    (150 * 0.042) / 1_000_000,
  );
  expect(data.pricing.source).toContain("catalog");
  expect(data.pricing.as_of).toBe("2026-10-08");
  expect(
    Temporal.Instant.from(data.to).epochMilliseconds -
      Temporal.Instant.from(data.from).epochMilliseconds,
  ).toBe(7 * 86_400_000);
  expect(
    Temporal.Instant.compare(data.captured_at, data.to),
  ).toBeGreaterThanOrEqual(0);
  expect(readFileSync(join(root, "state/jev-usage.jsonl"), "utf8")).toBe(
    before,
  );
});

test("empty, explicit zero and missing usage have distinct meanings; imported legacy is deduplicated", () => {
  const { root, env } = fixture();
  const empty = report(stats(env));
  expect(empty.known_input_tokens).toBeNull();
  expect(empty.coverage.usage_journal_present).toBe(false);
  journal(root, "runs.jsonl", [
    {
      kind: "run",
      run_id: "zero",
      started_at: at(1),
      pick: {
        jev: { response: { usage: { input_tokens: 0, output_tokens: 0 } } },
      },
    },
  ]);
  journal(root, "records.jsonl", [
    { kind: "started", id: "imported", at: at(1), legacy_key: "run:zero" },
  ]);
  const data = report(stats(env));
  expect(data.known_input_tokens).toBe(0);
  expect(data.unknown.usage).toBe(0);
  expect(data.coverage.known_usage_records).toBe(1);
  journal(root, "records.jsonl", [
    { kind: "started", id: "uncaptured", at: at(1) },
  ]);
  const missing = report(stats(env));
  expect(missing.unknown.historical_runs).toBe(1);
  expect(missing.input_tokens).toBeNull();
});

test("malformed complete records refuse JSON; incomplete tails and unknown dates are explicit", () => {
  const { root, env } = fixture();
  writeFileSync(join(root, "state/jev-usage.jsonl"), '{"schema":');
  expect(report(stats(env)).coverage.trailing_partial_record).toBe(true);
  writeFileSync(join(root, "state/jev-usage.jsonl"), "bad\n");
  const invalid = stats(env);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stdout.toString()).toBe("");
  journal(root, "jev-usage.jsonl", [capture(1, null)]);
  journal(root, "runs.jsonl", [{ kind: "run", run_id: "undated" }]);
  expect(report(stats(env)).unknown.time).toBe(1);
});

test("usage invocation rejects incompatible flags and bad windows", () => {
  const { env } = fixture();
  for (const extra of [
    ["--usage", "other"],
    ["--usage", "jev", "--routing"],
    ["--usage", "jev", "--host", "here"],
    ["--usage", "jev", "--import-legacy"],
    ["--usage", "jev", "--window", "0d"],
    ["--usage", "jev", "extra"],
  ])
    expect(stats(env, extra).exitCode).toBe(2);
  expect(report(stats(env, ["--usage", "jev"])).window).toBe("7d");
  expect(stats(env, ["--help"]).stdout.toString()).toContain("--usage");
});

test("real routing CLI captures response usage even for fallback, missing usage remains unknown", async () => {
  const { root, env } = fixture();
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "luna-high" } },
        usage: { input_tokens: 123, output_tokens: 7 },
      }),
  });
  await using _cleanup = { [Symbol.asyncDispose]: () => server.stop(true) };
  const ticket = join(root, "ticket.md");
  writeFileSync(
    ticket,
    '+++\nschema = 2\noutcome = "fixture"\n[proposition]\nid = "P"\nclaim = "fixture"\nrefuted_by = "failure"\n+++\nFixture selection.\n',
  );
  async function pick() {
    const child = Bun.spawn([...args, "roster", ticket], {
      env: { ...env, JEV_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, err).toBe(0);
    expect(out).toContain("luna-high");
  }
  await pick();
  let data = report(stats(env));
  expect(data.input_tokens).toBe(123);
  expect(data.output_tokens).toBe(7);
  expect(data.known_input_tokens).toBe(123);
  expect(data.known_output_tokens).toBe(7);
  expect(data.unknown.usage).toBe(0);
  server.reload({
    fetch: () =>
      Response.json({
        answers: {},
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
  });
  await pick();
  data = report(stats(env));
  expect(data.known_input_tokens).toBe(133);
  expect(data.known_output_tokens).toBe(9);
  server.reload({
    fetch: () =>
      Response.json({ answers: { worker: { choice: "luna-high" } } }),
  });
  await pick();
  data = report(stats(env));
  expect(data.known_input_tokens).toBe(133);
  expect(data.unknown.captured_calls).toBe(1);
  expect(data.input_tokens).toBeNull();
});
