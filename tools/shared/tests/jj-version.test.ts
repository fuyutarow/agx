import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../src/subprocess-env.ts";

test.each([
  ["jj 0.45.1", 2],
  ["jj 0.46.0-7d382314f9420b4b8d932245b49c99492c812b9f", 0],
])("template version %s has exit %i", async (version, expected) => {
  const dir = await mkdtemp(join(tmpdir(), "jj-version-boundary-"));
  const fake = join(dir, "jj");
  await Bun.write(fake, `#!/bin/sh\necho ${JSON.stringify(version)}\n`);
  await chmod(fake, 0o755);
  const modulePath = join(import.meta.dir, "../src/jj-version.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { requireJjTemplateVersion as check } from ${JSON.stringify(modulePath)}; check(["jj", "log", "-T", "commit_id"]);`,
    ],
    {
      env: subprocessEnvironment({ PATH: `${dir}:${process.env.PATH}` }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, err] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(expected);
  if (expected !== 0)
    expect(err).toBe(`agx: jj 0.46.0 or newer required; found ${version}\n`);
  else expect(err).toBe("");
  await rm(dir, { recursive: true, force: true });
});

test("template version is checked once for multiple calls in one process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jj-version-"));
  const trace = join(dir, "calls");
  const fake = join(dir, "jj");
  await Bun.write(
    fake,
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(trace)}\necho 'jj 0.46.0'\n`,
  );
  await chmod(fake, 0o755);
  const modulePath = join(import.meta.dir, "../src/jj-version.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { requireJjTemplateVersion as check } from ${JSON.stringify(modulePath)}; check(["jj", "log", "-T", "commit_id"]); check(["jj", "workspace", "list", "-T", "name"]);`,
    ],
    {
      env: subprocessEnvironment({ PATH: `${dir}:${process.env.PATH}` }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, err] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(0);
  expect(await Bun.file(trace).text()).toBe("--version\n");
  await rm(dir, { recursive: true, force: true });
});
