import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLAUDE_READ_ALLOW,
  claudeWorkspaceWriteSettings,
  workerWritableRoots,
} from "../src/workers/environment.ts";

// Paths are only strings here; nothing is created or read on disk.
const input = {
  runDir: "/tmp/agx-read-scope-run",
  runTemp: "/tmp/agx-read-scope-temp",
  source: { HOME: "/tmp/agx-read-scope-home" },
};
const settings = claudeWorkspaceWriteSettings(input);
const outside = "/home/someone/.cache/soks-coord/retro/candidates.md";

describe("claude workspace-write read scope", () => {
  test("allows Read on every absolute path, so a path outside the workspace is readable", () => {
    expect(settings.permissions.allow).toContain("Read(//**)");
    expect(settings.permissions.allow).toEqual([...CLAUDE_READ_ALLOW]);
    // The rule is anchored at the filesystem root ("//"), not the workspace or home.
    for (const rule of settings.permissions.allow)
      expect(rule.startsWith("Read(//")).toBe(true);
    expect(outside.startsWith("/")).toBe(true);
  });

  test("grants read only: no write-capable rule and no new writable root", () => {
    for (const rule of settings.permissions.allow)
      expect(/^(Edit|Write|MultiEdit|NotebookEdit)\b/u.test(rule)).toBe(false);
    const allowWrite = settings.sandbox.filesystem.allowWrite;
    expect(allowWrite).not.toContain(outside);
    expect(allowWrite).not.toContain("/");
    expect(allowWrite).toEqual([
      resolve(input.runTemp),
      "/tmp",
      ...workerWritableRoots({ runDir: input.runDir, source: input.source }),
    ]);
    expect(settings.permissions.additionalDirectories).toEqual([
      resolve(input.runDir),
    ]);
  });

  test("the settings carry no deny rule that would mask the repository's own deny rules", () => {
    expect(Object.hasOwn(settings.permissions, "deny")).toBe(false);
  });

  test("run.ts builds these settings only for workspace-write; read-only and none stay unchanged", () => {
    const run = readFileSync(
      new URL("../src/next/run.ts", import.meta.url),
      "utf8",
    );
    expect(run).toMatch(
      /sandbox === "workspace-write"\s*\?\s*JSON\.stringify\(\s*claudeWorkspaceWriteSettings/u,
    );
    expect(run).toMatch(/:\s*undefined;/u);
    expect(run).not.toContain("CLAUDE_READ_ALLOW");
  });
});
