import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSuiteTool } from "../src/path-dispatch.ts";
import { subprocessEnvironment } from "../src/subprocess-env.ts";

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

test("dispatch contract: SIGTERM to agx reaches the forwarded child and agx exits with its status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agx-signal-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
  await writeFile(join(dir, "agx-ws"), `#!${process.execPath}\nprocess.on("SIGTERM", () => { process.stderr.write("child received SIGTERM\\n"); process.exit(37); });\nprocess.stdout.write("ready\\n");\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../agx/src/agx.ts"), "ws"], {
    env: subprocessEnvironment({ PATH: `${dir}:${process.env.PATH ?? ""}` }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  expect(new TextDecoder().decode(ready.value)).toContain("ready");
  child.kill("SIGTERM");
  const [stderr, code] = await Promise.all([child.stderr.text(), child.exited]);
  expect(stderr).toContain("child received SIGTERM");
  expect(code).toBe(37);
});
