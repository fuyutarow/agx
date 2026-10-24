import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

test("test preload confines temporary files to the process directory", () => {
  const runParent = process.env.AGX_TEST_RUN_DIR ?? "";
  expect(basename(runParent).startsWith("agx-test-run-ns-")).toBe(true);
  expect(tmpdir().startsWith(`${runParent}/`)).toBe(true);
  expect(process.env.TMPDIR).toBe(tmpdir());
  const child = mkdtempSync(join(tmpdir(), "fixture-"));
  expect(dirname(child)).toBe(tmpdir());
  expect(existsSync(child)).toBe(true);
});
