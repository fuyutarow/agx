import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";
import { subprocessEnvironment } from "../src/subprocess-env.ts";

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("subprocessEnvironment removes inherited agent session variables", () => {
  const inherited = [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CODEX_THREAD_ID",
    "AGX_RUN_ID",
    "INVOCATION_ID",
  ];
  using cleanup = new DisposableStack();

  for (const name of inherited) {
    const previous = process.env[name];
    cleanup.defer(() => {
      restoreEnvironment(name, previous);
    });
    process.env[name] = `inherited-${name}`;
  }
  const environment = subprocessEnvironment({ HERMETIC_TEST_VALUE: "kept" });

  for (const name of inherited) expect(environment[name]).toBeUndefined();
  expect(environment.HERMETIC_TEST_VALUE).toBe("kept");
});

test("subprocessEnvironment keeps agent variables a test sets explicitly", () => {
  const environment = subprocessEnvironment({
    CLAUDE_CODE_SESSION_ID: "fixture-claude-session",
    CODEX_THREAD_ID: "fixture-codex-thread",
    AGX_RUN_ID: "fixture-run",
    INVOCATION_ID: "fixture-invocation",
  });

  expect(environment.CLAUDE_CODE_SESSION_ID).toBe("fixture-claude-session");
  expect(environment.CODEX_THREAD_ID).toBe("fixture-codex-thread");
  expect(environment.AGX_RUN_ID).toBe("fixture-run");
  expect(environment.INVOCATION_ID).toBe("fixture-invocation");
});

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.(?:[cm]?tsx?)$/u.test(entry.name) ? [path] : [];
  });
}

test("test contract: subprocesses get the hermetic environment", () => {
  const toolsDirectory = join(import.meta.dir, "../..");
  const testDirectories = readdirSync(toolsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(toolsDirectory, entry.name, "tests"))
    .filter((directory) => existsSync(directory));
  const processEnvironment = ["process", "env"].join(".");
  const inheritedSpread = new RegExp(
    ["\\.\\.\\.\\s*", processEnvironment].join(""),
    "u",
  );
  const directEnvironment = new RegExp(
    ["\\benv\\s*:\\s*", processEnvironment].join(""),
    "u",
  );
  const leaks = testDirectories
    .flatMap((directory) => filesIn(directory))
    .toSorted()
    .flatMap((path) => {
      const lines = readFileSync(path, "utf8").split("\n");
      return lines.flatMap((line, index) =>
        inheritedSpread.test(line) || directEnvironment.test(line)
          ? [`${relative(process.cwd(), path)}:${index + 1}`]
          : [],
      );
    });

  expect(
    leaks,
    `subprocess environments must use subprocessEnvironment; found direct process.env use at:\n${leaks.join("\n")}`,
  ).toEqual([]);
});
