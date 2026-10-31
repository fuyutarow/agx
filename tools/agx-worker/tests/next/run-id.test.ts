import { expect, test } from "bun:test";
import { resolveRunId } from "../../src/next/run-id.ts";

test("unknown selector reports the recorded count without ids", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `run-${i}` }));
  const result = resolveRunId(rows, "missing");
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.error.length).toBeLessThan(300);
  expect(result.error).toContain("missing");
  expect(result.error).toContain("50");
  for (const row of rows) expect(result.error).not.toContain(row.id);
});

test("ambiguous selector lists only the first 20 sorted candidates", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `run-${String(i).padStart(2, "0")}`,
  })).toReversed();
  const result = resolveRunId(rows, "run-");
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.error).toBe(
    `run id 'run-' is ambiguous; run id candidates: ${rows
      .toReversed()
      .slice(0, 20)
      .map((row) => row.id)
      .join(", ")}, 10 more`,
  );
});

test("exact ids and unique prefixes resolve", () => {
  const rows = [{ id: "run-a" }, { id: "run-ab" }, { id: "run-bc" }];
  expect(resolveRunId(rows, "run-a")).toEqual({
    kind: "resolved",
    row: { id: "run-a" },
  });
  expect(resolveRunId(rows, "run-b")).toEqual({
    kind: "resolved",
    row: { id: "run-bc" },
  });
});
