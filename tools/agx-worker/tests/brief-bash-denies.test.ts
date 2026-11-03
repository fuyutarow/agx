import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPromise } from "../src/next/run.ts";
import { parseNextTicket } from "../src/next/ticket.ts";

const source = `+++
schema = 2
name = "brief-bash-denies"
writes = []
outcome = "fixture"
verify = ["true"]
[proposition]
id = "BASH-DENIES"
claim = "the brief names the denied Bash commands"
refuted_by = "a workspace denying git yields a brief without git"
+++
body
`;

const brief = (cwd: string, route: "claude" | "codex"): string => {
  const parsed = parseNextTicket(source);
  if (!parsed.success) return expect.unreachable(parsed.reason);
  return renderPromise(
    parsed.ticket,
    cwd,
    "workspace-write",
    parsed.prose,
    "/run",
    undefined,
    undefined,
    route,
  );
};

const denyLine = (text: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith("Bash denies:"));

let root: string;
let workspace: string;
let home: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brief-bash-denies-"));
  workspace = join(root, "workspace");
  home = join(root, "home");
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const writeSettings = (file: string, deny: string[]): void => {
  writeFileSync(file, JSON.stringify({ permissions: { deny } }));
};

test("a workspace that denies Bash(git:*) gets a brief line naming git", () => {
  writeSettings(join(workspace, ".claude", "settings.json"), ["Bash(git:*)"]);
  const text = brief(workspace, "claude");
  const line = denyLine(text);
  expect(line).toBeDefined();
  expect(line).toContain("git *");
});

test("with no deny rules the brief has no Bash denies line", () => {
  writeFileSync(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
  );
  expect(denyLine(brief(workspace, "claude"))).toBeUndefined();
  expect(brief(workspace, "claude")).not.toContain("Bash denies");
});

test("a missing or malformed settings file adds no line", () => {
  writeFileSync(join(workspace, ".claude", "settings.json"), "{ not json");
  expect(denyLine(brief(workspace, "claude"))).toBeUndefined();
});

test("user settings and local settings deny rules are inherited and deduplicated", () => {
  writeSettings(join(home, ".claude", "settings.json"), [
    "Bash(rm:*)",
    "Bash(git:*)",
  ]);
  writeSettings(join(workspace, ".claude", "settings.local.json"), [
    "Bash(git:*)",
  ]);
  const line = denyLine(brief(workspace, "claude"));
  expect(line).toBeDefined();
  expect(line).toContain("git *, rm *");
  expect(line?.split("git *").length).toBe(2);
});

test("non-Bash deny rules are not named", () => {
  writeSettings(join(workspace, ".claude", "settings.json"), ["Read(./.env)"]);
  expect(denyLine(brief(workspace, "claude"))).toBeUndefined();
});

test("codex briefs get no Bash denies line", () => {
  writeSettings(join(workspace, ".claude", "settings.json"), ["Bash(git:*)"]);
  expect(brief(workspace, "codex")).not.toContain("Bash denies");
});
