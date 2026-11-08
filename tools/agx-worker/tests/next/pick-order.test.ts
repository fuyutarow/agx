import { expect, test } from "bun:test";
import { fitsPublishedTimeBox, orderCandidates } from "../../src/next/route.ts";
import { loadRoster, type RequirementClass } from "../../src/roster/index.ts";

test("real roster picks are deterministic, credit-aware and cheapest within a credit class", async () => {
  const loaded = await loadRoster({
    policyPath: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const rows = loaded.catalogRows.filter((candidate) =>
    fitsPublishedTimeBox(candidate, 600),
  );
  const cases: [RequirementClass, string, string][] = [
    ["mechanical", "luna-low", "haiku-low"],
    ["localized", "haiku-medium", "haiku-medium"],
    ["cross_module", "terra-high", "sonnet-high"],
  ];
  for (const [requirement, without, withCredit] of cases) {
    for (const [credit, expected] of [
      [false, without],
      [true, withCredit],
    ] as const) {
      const covered = (row: (typeof rows)[number]) =>
        credit && row.route === "claude";
      const ordered = orderCandidates(rows, requirement, covered);
      expect(ordered[0]?.id).toBe(expected);
      expect(
        orderCandidates(rows.toReversed(), requirement, covered).map(
          (candidate) => candidate.id,
        ),
      ).toEqual(ordered.map((row) => row.id));
      expect(ordered[0]?.id).not.toMatch(/^(fable|opus)-/u);
    }
  }
});

test("expensive credit rows cannot overtake cheaper qualifying rows, including equal-key ties", async () => {
  const loaded = await loadRoster({
    policyPath: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  for (const requirement of [
    "mechanical",
    "localized",
    "cross_module",
  ] as const) {
    const ordered = orderCandidates(
      loaded.catalogRows,
      requirement,
      (row) => row.route === "claude",
    );
    const firstClaude = ordered.find((row) => row.route === "claude");
    const costlyClaudeRows = ordered.filter(
      (item) => /^(opus|fable)-/u.test(item.id) && item.route === "claude",
    );
    const firstPrice =
      (firstClaude?.price_in ?? Infinity) +
      (firstClaude?.price_out ?? Infinity);
    expect(
      costlyClaudeRows.every((candidate) => {
        const candidatePrice =
          (candidate.price_in ?? Infinity) + (candidate.price_out ?? Infinity);
        return (
          firstClaude === undefined ||
          firstPrice >= candidatePrice ||
          ordered.indexOf(firstClaude) < ordered.indexOf(candidate)
        );
      }),
    ).toBe(true);
    expect(
      orderCandidates(
        loaded.catalogRows.toReversed(),
        requirement,
        (row) => row.route === "claude",
      ).map((row) => row.id),
    ).toEqual(ordered.map((row) => row.id));
  }
  const base = loaded.catalogRows[0];
  expect(base).toBeDefined();
  if (base === undefined) return;
  const ties = [
    { ...base, id: "z-low" },
    { ...base, id: "a-low" },
  ];
  expect(
    orderCandidates(ties, "mechanical", () => false).map((row) => row.id),
  ).toEqual(["a-low", "z-low"]);
  expect(
    orderCandidates(ties, "cross_module", () => false).map((row) => row.id),
  ).toEqual(["a-low", "z-low"]);
});
