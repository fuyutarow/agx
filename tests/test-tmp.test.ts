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

test("test preload guards reason-network on PATH", () => {
  const binary = Bun.which("reason-network", { PATH: process.env.PATH ?? "" });
  expect(binary).toBe(join(tmpdir(), "guard-bin", "reason-network"));
  if (binary === null) return;
  const result = Bun.spawnSync([binary]);
  expect(result.exitCode).toBe(97);
  expect(result.stderr.toString()).toBe(
    "agx tests must not run the real reason-network; put a fake on PATH\n",
  );
  const child = Bun.spawnSync(
    [process.execPath, "-e", 'process.stdout.write(Bun.which("reason-network") ?? "")'],
    { env: process.env },
  );
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe(binary);
});
