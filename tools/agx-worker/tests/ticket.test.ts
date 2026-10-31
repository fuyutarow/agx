import { describe, expect, test } from "bun:test";
import { globsOverlap, verifyLine } from "../src/ticket.ts";
import { parseNextTicket } from "../src/next/ticket.ts";

test("current parsing preserves schema-2 compatibility warnings and capability tags", () => {
  const parsed = parseNextTicket(`+++
schema = 2
outcome = "retain current compatibility"
consumer = "legacy producer"
verify_timeout_s = 30
capabilities = [" long-tool-loop ", { need = " reasoning ", lower_effort_lacks = " evidence " }]
[proposition]
id = "P1"
claim = "current tickets remain accepted"
refuted_by = "a rejected ticket"
decides = "infrastructure"
serves = ["P0"]
+++
RESOURCE-CLASS(NONCOMPUTE): review
RESOURCE-ENVELOPE(cpu): 1 core
`);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.ticket.capabilities).toEqual(["long-tool-loop", "reasoning"]);
  expect(parsed.ticket.verify).toEqual([]);
  expect(parsed.warnings).toEqual([
    "consumer",
    "verify_timeout_s",
    "proposition.decides",
    "proposition.serves",
    "capabilities (routing only)",
    "RESOURCE line",
  ]);
});

describe("globsOverlap (segment-exact intersection)", () => {
  test.each([
    ["tools/agx-worker/**", "tools/agx-worker/src/roster/catalog.toml", true],
    ["tools/agx-worker/**", "tools/agx-worker/tests/a.ts", true],
    ["agents/**", "tools/agx-worker/src/roster/catalog.toml", false],
    ["**", "anything/at/all", true],
    ["a/b.ts", "a/b.ts", true],
    ["a/b.ts", "a/c.ts", false],
    ["a/*/x.ts", "a/b/y.ts", false],
    ["a/b/**", "a/bc/**", false],
    ["./a/b/", "a/b/c", true],
    ["src/*.ts", "docs/*.md", false],
    [
      "launcher/frame_integrity*.test.*",
      "launcher/designs/module-ledger.toml",
      false,
    ],
    [
      "launcher/frame_integrity*.test.*",
      "launcher/frame_integrity_v6.test.ts",
      true,
    ],
    ["src/*.ts", "src/sub/file.ts", false],
    ["src/**/file.ts", "src/file.ts", true],
    ["src/**/file.ts", "src/sub/file.ts", true],
    ["a/[ab].{ts,js}", "a/b.js", true],
    ["a/[ab].ts", "a/c.ts", false],
    ["a/[a-a].ts", "a/-.ts", false],
    ["a/[😀-😃].ts", "a/😁.ts", true],
  ])("%s vs %s → %s (symmetric)", (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });
});

test("verifyLine lists the commands and tells the worker to run them in the foreground", () => {
  const line = verifyLine(["bun test", "tsc"]);
  expect(line).toContain("bun test");
  expect(line).toContain("tsc");
  expect(line).toContain("in the foreground");
  expect(line).toContain("do not background anything you need to see");
  expect(verifyLine([])).toBe("");
});

const floorTicket = (fields: string) => `+++\nschema = 2\noutcome = "work"\nwrites = []\n${fields}\n[proposition]\nid = "P"\nclaim = "works"\nrefuted_by = "failure"\n+++\n`;
test("ticket min_effort validates the floor and justification", () => {
  const parsed = parseNextTicket(floorTicket('min_effort = "high"'));
  expect(parsed.success && parsed.ticket.min_effort).toBe("high");
  const invalid = parseNextTicket(floorTicket('min_effort = "ultra"'));
  expect(invalid.success).toBe(false);
  if (!invalid.success) expect(invalid.reason).toContain("low");
  expect(parseNextTicket(floorTicket('min_effort = "xhigh"')).success).toBe(false);
  expect(parseNextTicket(floorTicket('min_effort = "max"\ncapabilities = [{ need = "reasoning", lower_effort_lacks = "depth" }]')).success).toBe(true);
});

test("refused effort floors explain the capabilities form and unsupported keys", () => {
  const form = 'capabilities = [{ need = "...", lower_effort_lacks = "..." }]';
  const missing = parseNextTicket(floorTicket('min_effort = "xhigh"'));
  expect(missing.success).toBe(false);
  if (!missing.success) expect(missing.reasons?.join(" ")).toContain(form);

  const misspelled = parseNextTicket(floorTicket('min_effort = "xhigh"\n[capability]\nneed = "reasoning"\nlower_effort_lacks = "depth"'));
  expect(misspelled.success).toBe(false);
  if (!misspelled.success) {
    expect(misspelled.reasons?.join(" ")).toContain(form);
    expect(misspelled.reasons?.join(" ")).toContain("capability: unsupported key");
  }
});
