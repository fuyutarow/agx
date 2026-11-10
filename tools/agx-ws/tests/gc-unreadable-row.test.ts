import { describe, expect, test } from "bun:test";
import {
  emptyCommitGraph,
  parseGcCommitRows,
  unlandedWorkspaceChange,
  type Workspace,
} from "../src/workspace.ts";

const ERROR_ROW =
  "<Error: Error when reading object f1a976a6701e9bd1791f1620eefc187e6a54941a of type file: Entry too large to fit in memory>";

function commitRow(
  id: string,
  parents: string[],
  options: { trunk?: boolean } = {},
): string {
  const json = {
    id,
    parents: parents.join(","),
    change: `change-${id}`,
    description: `commit ${id}`,
    empty: false,
    trunk: options.trunk ?? false,
    remote: false,
    remoteBookmarks: "",
    filesIncluded: true,
    files: "",
    changedPaths: "",
  };
  return `${id}\t${JSON.stringify(json)}`;
}

function graphOf(text: string) {
  const parsed = parseGcCommitRows(text);
  expect(parsed.ok).toBe(true);
  return parsed.ok ? parsed.value : emptyCommitGraph();
}

function workspaceAt(name: string, target: string): Workspace {
  return {
    name,
    dir: `/tmp/agx-gc-unreadable-row/${name}`,
    target,
    commit: target,
    change: `change-${target}`,
    age: "1h",
    rootMissing: false,
    main: false,
  };
}

// Graph: T (trunk) <- A <- D ; T <- B (unreadable) <- C
const output = [
  commitRow("T", [], { trunk: true }),
  commitRow("A", ["T"]),
  `B\t${ERROR_ROW}`,
  commitRow("C", ["B"]),
  commitRow("D", ["A"]),
].join("\n");

describe("gc unreadable commit row", () => {
  test("an <Error> row marks only its commit unreadable and does not fail the graph", () => {
    const parsed = parseGcCommitRows(output);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const graph = parsed.value;
    expect([...graph.keys()].toSorted()).toEqual(["A", "C", "D", "T"]);
    expect(graph.unreadable.has("B")).toBe(true);
    expect(graph.unreadable.get("B")).toContain("Entry too large");
    expect(graph.unreadable.has("A")).toBe(false);
  });

  test("the raw unreadable message is truncated", () => {
    const long = `<Error: ${"x".repeat(1000)}>`;
    const parsed = parseGcCommitRows(`L\t${long}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.unreadable.get("L")?.length).toBeLessThanOrEqual(300);
  });

  test("a workspace whose pending chain reaches the unreadable commit is kept with the reason", () => {
    const affected = unlandedWorkspaceChange(
      workspaceAt("wsC", "C"),
      graphOf(output),
    );
    expect(affected.missing).toContain("commit B is unreadable");
    expect(affected.missing).toContain("Entry too large");
  });

  test("other workspaces are still classified from the readable commits", () => {
    const graph = graphOf(output);
    const landedNearTrunk = unlandedWorkspaceChange(
      workspaceAt("wsA", "A"),
      graph,
    );
    expect(landedNearTrunk.missing).toBeUndefined();
    expect(landedNearTrunk.change?.id).toBe("A");
    const deeper = unlandedWorkspaceChange(workspaceAt("wsD", "D"), graph);
    expect(deeper.missing).toBeUndefined();
    expect(deeper.changes.map((commit) => commit.id)).toEqual(["D", "A"]);
  });
});
