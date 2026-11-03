import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { attempt } from "../../../shared/src/attempt.ts";
import { loadRoster } from "../../src/roster/load.ts";

const catalogPath = join(import.meta.dir, "../../src/roster/catalog.toml");

const expected = new Map<string, number>([
  ["haiku-low", 102.62],
  ["haiku-medium", 192.63],
  ["haiku-high", 298.12],
  ["haiku-xhigh", 433.75],
  ["haiku-max", 595.42],
  ["sonnet-low", 131.17],
  ["sonnet-medium", 190.36],
  ["sonnet-high", 346.14],
  ["sonnet-xhigh", 725.6],
  ["sonnet-max", 1262.87],
]);

const catalogSchema = z.object({
  choice: z.array(
    z.object({
      id: z.string(),
      route: z.string(),
      aa_time_per_task_s: z.number().positive().optional(),
    }),
  ),
});

describe("claude catalog durations", () => {
  test("every claude row carries the published AA time per task", async () => {
    const toml = await attempt(async () =>
      Bun.TOML.parse(await Bun.file(catalogPath).text()),
    );
    expect(toml.ok).toBe(true);
    const parsed = catalogSchema.safeParse(toml.ok ? toml.value : undefined);
    expect(parsed.success).toBe(true);
    const choices = parsed.success ? parsed.data.choice : [];
    const claude = choices.filter(
      (row) => row.route === "claude" && /^(?:haiku|sonnet)-/u.test(row.id),
    );
    expect(claude.map((row) => row.id).toSorted((a, b) => a.localeCompare(b)))
      .toEqual([...expected.keys()].toSorted((a, b) => a.localeCompare(b)));
    for (const row of claude) {
      expect(row.aa_time_per_task_s).toBe(expected.get(row.id));
    }
  });

  test("the catalog loads", async () => {
    const roster = await loadRoster({ catalogPath });
    expect(roster).toBeDefined();
  });
});
