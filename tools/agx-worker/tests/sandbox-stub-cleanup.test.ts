import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSnapshot } from "../src/next/outcome.ts";
import {
  CLAUDE_SANDBOX_PROTECTED_PATHS,
  removeClaudeSandboxStubs,
} from "../src/workers/environment.ts";

// Every path here is inside a temporary directory the test creates and removes.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-test-stub-cleanup-"));
  roots.push(dir);
  return dir;
}

const stub = (dir: string, path: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), "");
  chmodSync(join(dir, path), 0o444);
};

const snapshot = (dir: string) => {
  const before = workspaceSnapshot(dir);
  expect(before.isOk()).toBe(true);
  return before.isOk() ? before.value : new Map<string, string>();
};

describe("claude sandbox stub cleanup", () => {
  test("removes only new empty regular files with protected names", () => {
    const dir = workspace();
    writeFileSync(join(dir, ".bashrc"), "export A=1\n");
    const before = snapshot(dir);

    stub(dir, ".zshrc");
    stub(dir, ".claude/hooks");
    writeFileSync(join(dir, ".profile"), "content\n");
    writeFileSync(join(dir, "notes.txt"), "");

    const removed = removeClaudeSandboxStubs(dir, before);
    expect(removed).toEqual([".claude/hooks", ".zshrc"]);
    expect(existsSync(join(dir, ".zshrc"))).toBe(false);
    expect(existsSync(join(dir, ".claude/hooks"))).toBe(false);
    expect(existsSync(join(dir, ".bashrc"))).toBe(true);
    expect(existsSync(join(dir, ".profile"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  test("keeps a pre-existing empty protected file and a directory of a protected name", () => {
    const dir = workspace();
    writeFileSync(join(dir, ".gitconfig"), "");
    mkdirSync(join(dir, ".vscode"));
    const before = snapshot(dir);
    expect(removeClaudeSandboxStubs(dir, before)).toEqual([]);
    expect(existsSync(join(dir, ".gitconfig"))).toBe(true);
    expect(statSync(join(dir, ".vscode")).isDirectory()).toBe(true);
  });

  test("removes nothing when the pre-run snapshot is unavailable", () => {
    const dir = workspace();
    stub(dir, ".zshrc");
    expect(removeClaudeSandboxStubs(dir, undefined)).toEqual([]);
    expect(existsSync(join(dir, ".zshrc"))).toBe(true);
  });

  test("the protected list holds the names seen on a killed run", () => {
    for (const name of [
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".gitconfig",
      ".gitmodules",
      ".mcp.json",
      ".ripgreprc",
      ".idea",
      ".vscode",
      ".zshrc",
      ".zprofile",
      ".claude/hooks",
      ".claude/agents",
      ".claude/skills",
    ])
      expect(CLAUDE_SANDBOX_PROTECTED_PATHS).toContain(name);
  });
});
