import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { selfCommand } from "../src/self-command.ts";

test("selfCommand forwards a real executable path", () => {
  const command = selfCommand();
  expect(command).not.toContain("/proc/self/exe");
  const executable = command[0];
  expect(executable).toBeDefined();
  if (executable === undefined) return;
  expect(isAbsolute(executable)).toBe(true);
  expect(statSync(executable).isFile()).toBe(true);
});
