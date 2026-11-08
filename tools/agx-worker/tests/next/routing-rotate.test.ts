import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRoutingPick,
  routingDecision,
  routingEvents,
} from "../../src/next/routing-events.ts";

const roots: string[] = [];
const previous = process.env.AGX_STATE_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.AGX_STATE_DIR;
  else process.env.AGX_STATE_DIR = previous;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("dated writes and newest-first lookup preserve legacy bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-routing-rotate-"));
  roots.push(root);
  process.env.AGX_STATE_DIR = root;
  const event = (id: string, source: string) =>
    JSON.stringify({
      schema: 1,
      at: "2020-01-01T00:00:00Z",
      host: "fixture",
      row: "row",
      route: "codex",
      source,
      audit: { decision_id: id },
    }) + "\n";
  const legacyPath = join(root, "routing.jsonl");
  const legacy = event("legacy", "legacy") + event("duplicate", "legacy");
  writeFileSync(legacyPath, legacy);
  writeFileSync(
    join(root, "routing-2020-01-01.jsonl"),
    event("older", "older") + event("duplicate", "old"),
  );
  writeFileSync(
    join(root, "routing-2020-01-02.jsonl"),
    event("duplicate", "new"),
  );

  recordRoutingPick({ id: "row", route: "codex" }, "today", {
    decision_id: "today",
  });
  const today = Temporal.Now.instant().toString().slice(0, 10);
  const written = JSON.parse(
    readFileSync(join(root, `routing-${today}.jsonl`), "utf8"),
  );
  expect(written.at.slice(0, 10)).toBe(today);
  expect(routingDecision("today")?.source).toBe("today");
  expect(routingDecision("older")?.source).toBe("older");
  expect(routingDecision("legacy")?.source).toBe("legacy");
  expect(routingDecision("duplicate")?.source).toBe("new");
  expect(routingDecision("missing")).toBeNull();
  expect(routingEvents().events).toHaveLength(6);
  expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
});

test("lookup stops before reading an older broken journal after a match", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-routing-rotate-"));
  roots.push(root);
  writeFileSync(join(root, "routing-2020-01-01.jsonl"), "invalid\n");
  writeFileSync(
    join(root, "routing-2020-01-02.jsonl"),
    JSON.stringify({
      schema: 1,
      at: "2020-01-02T00:00:00Z",
      host: "fixture",
      row: "row",
      route: "codex",
      source: "new",
      audit: { decision_id: "found" },
    }) + "\n",
  );
  expect(routingDecision("found", root)?.source).toBe("new");
});
