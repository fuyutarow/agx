import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_NAMES } from "../src/next/commands.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const cli = join(import.meta.dir, "../src/next/cli.ts");
const states: string[] = [];
afterEach(() => {
  for (const state of states.splice(0))
    rmSync(state, { recursive: true, force: true });
});

function expectCommandLine(output: string) {
  const section = output.split("COMMANDS:\n")[1]?.split("\n\n")[0];
  expect(section).toBeDefined();
  const lines = section?.split("\n") ?? [];
  expect(lines).toHaveLength(COMMAND_NAMES.length + 1);
  for (const name of [...COMMAND_NAMES, "reclaim-runs"]) {
    const line = lines.find((entry) =>
      entry.trimStart().startsWith(`${name} `),
    );
    expect(line).toMatch(/^\s*\S+\s+\S.*$/u);
  }
}

test("worker help describes every command and hides internal flags", () => {
  const state = mkdtempSync(join(tmpdir(), "agx-help-"));
  states.push(state);
  for (const args of [
    ["--help"],
    ["run", "--help"],
    ["check", "--help"],
    ["run", "--help=true"],
  ]) {
    const result = Bun.spawnSync([process.execPath, cli, ...args], {
      env: subprocessEnvironment({ AGX_STATE_DIR: state }),
      timeout: 10_000,
    });
    const output = result.stdout.toString();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    for (const flag of ["dispatch-binding", "sandbox-source", "skip-routing"])
      expect(output).not.toContain(flag);
    if (args.length === 1) expectCommandLine(output);
  }
});

test("removed classify command is rejected", () => {
  const state = mkdtempSync(join(tmpdir(), "agx-classify-removed-"));
  states.push(state);
  const result = Bun.spawnSync([process.execPath, cli, "classify", "run-id"], {
    env: subprocessEnvironment({ AGX_STATE_DIR: state }),
  });
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain('unknown command "classify"');
});
