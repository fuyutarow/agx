// A deadline may kill the helper before exec, or its already restricted target.
// In neither case can a shared-store writer have started. JJ_READ_ARGS alone
// cannot establish this property: jj's backend can import refs during a read.
import { accessSync, constants } from "node:fs";
import { fromThrowable } from "neverthrow";
import readonlySource from "./readonly-exec.txt" with { type: "text" };
import { requireJjTemplateVersion } from "./jj-version.ts";

const READONLY_JOB_ENV = "AGX_READONLY_COMMAND_JOB";

// This path is valid only for a direct child spawn, not for forwarded argv.
function readonlyExecutable(): string {
  if (
    process.platform === "linux" &&
    fromThrowable(() => {
      accessSync("/proc/self/exe", constants.R_OK);
    })().isOk()
  )
    return "/proc/self/exe";
  return process.execPath;
}

export function readonlyCommand(
  argv: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): { cmd: [string, ...string[]]; env: NodeJS.ProcessEnv } {
  requireJjTemplateVersion(argv, environment);
  return {
    cmd: [readonlyExecutable(), "--eval", readonlySource, "--", cwd, ...argv],
    env: {
      ...environment,
      // Compiled executables can also host the embedded helper as Bun.
      BUN_BE_BUN: "1",
      [READONLY_JOB_ENV]: JSON.stringify({ argv, cwd }),
    },
  };
}
