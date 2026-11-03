import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  claudeWorkspaceWriteAllowedTools,
  claudeWorkspaceWriteSettings,
  WORKSPACE_WRITE_NETWORK_ACCESS,
} from "../src/workers/environment.ts";

const settings = claudeWorkspaceWriteSettings({
  runDir: "/tmp/agx-egress-run",
  runTemp: "/tmp/agx-egress-temp",
  source: { HOME: "/tmp/agx-egress-home" },
});
const codexSource = readFileSync(
  new URL("../src/workers/codex.ts", import.meta.url),
  "utf8",
);

describe("workspace-write egress parity", () => {
  test("codex passes the shared network declaration for workspace-write", () => {
    expect(codexSource).toContain(
      "sandbox_workspace_write.network_access=${WORKSPACE_WRITE_NETWORK_ACCESS}",
    );
  });

  test("claude grants network and the web tools exactly when codex grants network", () => {
    const tools = claudeWorkspaceWriteAllowedTools().split(",");
    const granted = settings.sandbox.network?.allowedDomains.includes("*");
    expect(granted === true).toBe(WORKSPACE_WRITE_NETWORK_ACCESS);
    expect(tools.includes("WebFetch")).toBe(WORKSPACE_WRITE_NETWORK_ACCESS);
    expect(tools.includes("WebSearch")).toBe(WORKSPACE_WRITE_NETWORK_ACCESS);
    expect(tools).toContain("Bash");
  });

  test("run.ts takes the allowed tools from the shared helper, only for workspace-write", () => {
    const run = readFileSync(
      new URL("../src/next/run.ts", import.meta.url),
      "utf8",
    );
    expect(run).toContain("claudeWorkspaceWriteAllowedTools()");
    expect(run).toContain('sandbox === "workspace-write"');
  });

  test("read-only and none do not use the workspace-write settings or tools", () => {
    const run = readFileSync(
      new URL("../src/next/run.ts", import.meta.url),
      "utf8",
    );
    expect(run).toMatch(
      /sandbox === "workspace-write"\s*\?\s*\[\s*"--allowed-tools",\s*claudeWorkspaceWriteAllowedTools\(\),\s*\]\s*:\s*\[\]/u,
    );
    expect(run).toMatch(
      /sandbox === "workspace-write"\s*\?\s*JSON\.stringify\(\s*claudeWorkspaceWriteSettings/u,
    );
  });
});
