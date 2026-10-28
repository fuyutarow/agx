import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { loadRoster } from "../../src/roster/index.ts";

const PricingProjection = z.looseObject({
  schema: z.literal(1),
  as_of: z.iso.date(),
  default: z.string(),
  auto: z.looseObject({ routes: z.array(z.enum(["codex", "claude"])) }),
  claude_run: z.object({
    max_budget_usd: z.number(),
    max_turns: z.number(),
    reason: z.string(),
  }),
  sources: z.record(z.string(), z.url()),
  objective: z.string(),
  choice: z.array(
    z.looseObject({
      id: z.string(),
      route: z.enum(["codex", "claude"]),
      price_in: z.number().optional(),
      price_cached_in: z.number().optional(),
      price_out: z.number().optional(),
      aa_cost_to_run_usd: z.number().optional(),
      aa_tokens_to_run_m: z.number().optional(),
      aa_cost_per_task_usd: z.number().optional(),
      aa_time_per_task_s: z.number().optional(),
    }),
  ),
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("roster --json publishes pricing with missing prices omitted on a fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-roster-pricing-"));
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "tools/agx-worker/src/next/cli.ts", "roster", "--json"],
    {
      cwd: new URL("../../../../", import.meta.url).pathname,
      env: {
        ...process.env,
        AGX_CONFIG: new URL("./fixtures/roster-pricing.toml", import.meta.url)
          .pathname,
        AGX_STATE_DIR: join(root, "state"),
        XDG_STATE_HOME: join(root, "xdg-state"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stderr).toBe("");
  const parsed = jsonOf(PricingProjection).safeParse(stdout);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const roster = parsed.data;
  expect(roster.default).toBe("luna-high");
  expect(roster.auto.routes).toEqual(["codex"]);
  expect(roster.choice.find((row) => row.id === "luna-high")).toMatchObject({
    route: "codex",
    price_in: 0.1,
    price_cached_in: 0.01,
    price_out: 0.5,
    aa_cost_to_run_usd: 62.575047245754845,
    aa_tokens_to_run_m: 40.451607,
    aa_cost_per_task_usd: 0.07294776473194697,
    aa_time_per_task_s: 269.2430350741027,
  });
  // The fixture uses the shipped catalog: this Claude row has no cached price,
  // and remains exported even though automatic routing allows only codex.
  const missing = roster.choice.find((row) => row.id === "sonnet-high");
  expect(missing).toMatchObject({
    route: "claude",
    price_in: 2,
    price_out: 10,
  });
  expect(missing).not.toHaveProperty("price_cached_in");
  expect(missing).not.toHaveProperty("aa_cost_per_task_usd");
  expect(missing).not.toHaveProperty("aa_time_per_task_s");
  expect(
    roster.choice.find((row) => row.id === "luna-medium"),
  ).not.toHaveProperty("aa_time_per_task_s");
  expect(roster.choice.some((row) => row.id === "luna-low")).toBe(false);
  expect(roster.choice.some((row) => row.id === "sol6-high")).toBe(false);
  expect(roster).not.toHaveProperty("exclude");
});

test("roster rejects nonpositive published per-task measurements", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-roster-task-metrics-"));
  roots.push(root);
  const catalogPath = join(root, "catalog.toml");
  const catalog = await Bun.file(
    new URL("../../src/roster/catalog.toml", import.meta.url),
  ).text();
  const invalidPricing: Array<[string, number]> = [
    ["aa_cost_per_task_usd", 0],
    ["aa_cost_per_task_usd", -1],
    ["aa_time_per_task_s", 0],
    ["aa_time_per_task_s", -1],
  ];
  for (const [field, invalid] of invalidPricing) {
    await Bun.write(
      catalogPath,
      catalog.replace(
        new RegExp(`^${field} = .*`, "mu"),
        `${field} = ${invalid}`,
      ),
    );
    const loaded = await loadRoster({
      catalogPath,
      policyPath: new URL("./fixtures/roster-pricing.toml", import.meta.url)
        .pathname,
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(field);
    else expect.unreachable(`accepted ${field} = ${invalid}`);
  }
});
