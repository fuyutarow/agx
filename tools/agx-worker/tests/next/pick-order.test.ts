import { expect, test } from "bun:test";
import { fitsPublishedTimeBox, orderCandidates } from "../../src/next/route.ts";
import { loadRoster, type RequirementClass } from "../../src/roster/index.ts";

test("real roster picks are deterministic, credit-aware and cheapest within a credit class", async () => {
  const loaded = await loadRoster({
    policyPath: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  });
  if (!loaded.ok) throw new Error(loaded.error);
  const rows = loaded.catalogRows.filter((row) =>
    fitsPublishedTimeBox(row, 600),
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
        orderCandidates([...rows].reverse(), requirement, covered).map(
          (row) => row.id,
        ),
      ).toEqual(ordered.map((row) => row.id));
      expect(ordered[0]?.id).not.toMatch(/^(fable|opus)-/);
    }
  }
});

test("expensive credit rows cannot overtake cheaper qualifying rows, including equal-key ties", async () => {
  const loaded = await loadRoster({
    policyPath: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  });
  if (!loaded.ok) throw new Error(loaded.error);
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
    for (const row of ordered.filter((row) => /^(opus|fable)-/u.test(row.id))) {
      if (firstClaude === undefined || row.route !== "claude") continue;
      const rowPrice = (row.price_in ?? Infinity) + (row.price_out ?? Infinity);
      const firstPrice =
        (firstClaude.price_in ?? Infinity) +
        (firstClaude.price_out ?? Infinity);
      if (firstPrice < rowPrice)
        expect(ordered.indexOf(firstClaude)).toBeLessThan(ordered.indexOf(row));
    }
    expect(
      orderCandidates(
        [...loaded.catalogRows].reverse(),
        requirement,
        (row) => row.route === "claude",
      ).map((row) => row.id),
    ).toEqual(ordered.map((row) => row.id));
  }
  const base = loaded.catalogRows[0];
  if (base === undefined) throw new Error("empty catalog");
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
