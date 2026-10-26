import { expect, test } from "bun:test";
import { timeboxLineageRefusal } from "../../src/next/timebox-lineage.ts";

test.each([
  { name: "independent timeouts", parent: null, middle: false, refused: false },
  {
    name: "two ancestral timeouts",
    parent: "first",
    middle: false,
    refused: true,
  },
  {
    name: "non-timeout between timeouts",
    parent: "middle",
    middle: true,
    refused: true,
  },
  {
    name: "cycle without a second timeout",
    parent: "last",
    middle: false,
    refused: false,
  },
])(
  "dispatch contract: rule 3 counts $name",
  async ({ parent, middle, refused }) => {
    const runs = [
      { id: "first", outcome: "timeout", continues: null },
      { id: "sibling", outcome: "timeout", continues: "first" },
      { id: "middle", outcome: "ok", continues: middle ? "first" : null },
      { id: "last", outcome: "timeout", continues: parent },
    ];
    const reason = await timeboxLineageRefusal(
      runs,
      "last",
      {
        schema: 2,
        writes: [],
        outcome: "fixture",
        verify: [],
        capabilities: [],
        proposition: { id: "P", claim: "fixture", refuted_by: "fixture" },
      },
      "",
      "/unused-state",
    );
    expect(reason !== undefined).toBe(refused);
    if (refused) {
      expect(reason).toContain("last, first");
      expect(reason).not.toContain("sibling");
    }
  },
);
