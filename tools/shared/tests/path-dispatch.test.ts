import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSuiteTool } from "../src/path-dispatch.ts";

test("Bun source mode ignores executable siblings beside the runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agx-source-path-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
  const target = "agx-worker";
  await writeFile(join(dir, target), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const runtime of ["bun", "bun.exe"]) {
    expect(await resolveSuiteTool(target, join(dir, runtime))).toBe(target);
  }
  expect(await resolveSuiteTool(target, join(dir, "agx"))).toBe(
    join(dir, target),
  );
});
