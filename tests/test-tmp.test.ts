import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

test("test preload confines temporary files to the process directory", () => {
  expect(basename(tmpdir()).startsWith("agx-test-")).toBe(true);
  expect(process.env.TMPDIR).toBe(tmpdir());
  const child = mkdtempSync(join(tmpdir(), "fixture-"));
  expect(dirname(child)).toBe(tmpdir());
  expect(existsSync(child)).toBe(true);
});
