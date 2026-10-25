import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAgxBinary,
  resolveSuiteTool,
} from "../../../shared/src/path-dispatch.ts";

test("agx child resolution prefers the running installation over an old PATH agx", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-sibling-binary-"));
  using _cleanup = {
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  const install = join(root, "install");
  const oldBin = join(root, "old-bin");
  const called = join(root, "called.txt");
  mkdirSync(install);
  mkdirSync(oldBin);
  const sibling = join(install, "agx");
  const siblingWs = join(install, "agx-ws");
  const old = join(oldBin, "agx");
  writeFileSync(sibling, `#!/bin/sh\nprintf agx > ${called}\n`);
  writeFileSync(siblingWs, `#!/bin/sh\nprintf agx-ws > ${called}\n`);
  writeFileSync(
    old,
    "#!/bin/sh\nprintf 'agx: invalid record log line' >&2\nexit 1\n",
  );
  chmodSync(sibling, 0o755);
  chmodSync(siblingWs, 0o755);
  chmodSync(old, 0o755);

  const resolved = await resolveAgxBinary(join(install, "agx-worker"));
  expect(resolved).toBe(sibling);
  const resolvedWs = await resolveSuiteTool(
    "agx-ws",
    join(install, "agx-worker"),
  );
  expect(resolvedWs).toBe(siblingWs);
  const calls: [string, string][] = [
    [resolved, "agx"],
    [resolvedWs, "agx-ws"],
  ];
  for (const [binary, expected] of calls) {
    const child = Bun.spawn([binary, "worker", "check"], {
      env: { PATH: oldBin },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(await Bun.file(called).text()).toBe(expected);
  }
});
