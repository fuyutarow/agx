import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readonlyCommand } from "../src/readonly-command.ts";

test("embedded isolation helper preserves argv and denies target writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-embedded-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
  const execute = async (argv: string[]) => {
    const invocation = readonlyCommand(argv, root);
    const child = Bun.spawn(invocation.cmd, {
      env: invocation.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ]);
    return { code, stdout, stderr };
  };
  const read = await execute([
    "sh",
    "-c",
    'printf "%s\\n" "$@"',
    "probe",
    "two words",
    "--flag",
    "$literal",
  ]);
  expect(read.code, read.stderr).toBe(0);
  expect(read.stdout).toBe("two words\n--flag\n$literal\n");
  const target = join(root, "must-not-exist");
  const write = await execute([
    "sh",
    "-c",
    'printf blocked > "$1"',
    "probe",
    target,
  ]);
  expect(write.code).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("embedded isolation needs no Bun on PATH and keeps its transport private", async () => {
  const invocation = readonlyCommand(
    [
      "/bin/sh",
      "-c",
      'printf "%s:%s" "${BUN_BE_BUN-unset}" "${AGX_READONLY_COMMAND_JOB-unset}"',
    ],
    "/tmp",
    { ...process.env, PATH: "/no-executables" },
  );
  const child = Bun.spawn(invocation.cmd, {
    env: invocation.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout.text(),
    child.stderr.text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toBe("unset:unset");
});
