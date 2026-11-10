import { expect, test } from "bun:test";
import { placement, rawSchema } from "./code-size";
import { jsonOf, z } from "../zod";

test("places representative paths in each group", () => {
  expect(placement({ path: "tools/agx/src/main.ts", isTest: false })).toEqual({
    group: 0,
    row: "agx",
  });
  expect(
    placement({ path: "tools/agx/tests/main.test.ts", isTest: true }),
  ).toEqual({ group: 1, row: "agx" });
  expect(placement({ path: "tools/release/build.ts", isTest: false })).toEqual({
    group: 2,
    row: "release",
  });
  expect(placement({ path: "docs/example.ts", isTest: false })).toEqual({
    group: 3,
    row: "docs",
  });
});

test("live report reconciles and classifies every path", async () => {
  const child = Bun.spawn(["mise", "run", "loc", "--", "--json"], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  const schema = z.object({
    ok: z.boolean(),
    unclassified: z.array(z.unknown()),
    composition: z.object({
      total: z.number(),
      reconciled: z.boolean(),
      groups: z.array(z.object({ code: z.number() })),
    }),
    rawLanguageSummary: rawSchema,
  });
  const parsed = jsonOf(schema).safeParse(stdout);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const result = parsed.data;
  expect(result.ok).toBe(true);
  expect(result.unclassified).toEqual([]);
  expect(result.composition.reconciled).toBe(true);
  expect(
    result.composition.groups.reduce((sum, group) => sum + group.code, 0),
  ).toBe(result.composition.total);
  const rawCode = ["TypeScript", "TSX"].reduce(
    (sum, name) => sum + (result.rawLanguageSummary[name]?.code ?? 0),
    0,
  );
  expect(result.composition.total).toBe(rawCode);
}, 70000);
