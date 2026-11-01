import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendVerifyKilledNote } from "../src/next/run.ts";
import { verifyKind } from "../src/next/verify.ts";

test("SIGKILLed verify records its kind and a diagnostic in its log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-verify-killed-"));
  using cleanup = {
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  void cleanup;
  const log = join(dir, "verify.log");
  const child = Bun.spawn(
    ["sh", "-c", 'exec 2>&1; sh -c "$1"', "agx-verify", "sh -c 'kill -9 $$'"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [exit, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  writeFileSync(log, output);
  appendVerifyKilledNote(log, exit, child.signalCode, "agt-test");
  expect(exit).toBe(137);
  expect(verifyKind(exit, child.signalCode)).toBe("killed");
  expect(readFileSync(log, "utf8")).toContain(
    "agx: verify killed by SIGKILL (exit 137); the kernel OOM killer is a common cause; see journalctl --user -u agt-test\n",
  );
});
