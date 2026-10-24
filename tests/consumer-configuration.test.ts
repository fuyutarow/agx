import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verificationEnvironment } from "../tools/agx-worker/src/next/verify.ts";
import { InspectionUnavailable } from "../tools/shared/src/agx-config.ts";

test("verification reads a neutral prefix file or an explicitly configured location", async () => {
  const root = await mkdtemp(join(tmpdir(), "consumer-prefix-"));
  const home = join(root, "home");
  const config = join(root, "config");
  await mkdir(join(config, "agx"), { recursive: true });
  const prefix = join(root, "brew");
  await writeFile(join(config, "agx/brew-prefix"), `${prefix}\n`);
  const custom = join(root, "custom-prefix");
  const alternate = join(root, "alternate");
  await writeFile(custom, `${alternate}\n`);
  for (const [extra, expected] of [
    [{}, prefix],
    [{ AGX_BREW_PREFIX_FILE: custom }, alternate],
  ] as const) {
    const env = verificationEnvironment(
      root,
      { HOME: home, XDG_CONFIG_HOME: config, PATH: "", ...extra },
      {},
    );
    expect(env).not.toBeInstanceOf(InspectionUnavailable);
    if (env instanceof InspectionUnavailable) return;
    expect(env.PATH?.split(":")).toContain(join(expected, "bin"));
    expect(env.PATH?.split(":")).toContain(join(expected, "sbin"));
  }
});

test("doctor includes a configured additional repository and suppresses it under a root override", async () => {
  const root = await mkdtemp(join(tmpdir(), "consumer-doctor-"));
  const home = join(root, "home");
  const repo = join(root, "consumer");
  const bin = join(root, "bin");
  const empty = join(root, "empty");
  await Promise.all([home, bin, empty].map((path) => mkdir(path)));
  await writeFile(
    join(bin, "agx"),
    `#!${process.execPath}\nprocess.stdout.write('[]');\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    AGX_REPOS_ROOT: undefined,
    AGX_ADDITIONAL_REPO: undefined,
    XDG_CONFIG_HOME: join(root, "config"),
    PATH: `${bin}:${process.env.PATH}`,
  };
  async function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
    const child = Bun.spawn(args, {
      cwd: root,
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, out, err };
  }
  const init = await run(["jj", "git", "init", repo]);
  expect(init.exit, init.err).toBe(0);
  await writeFile(
    join(repo, "stray.md"),
    "+++\nschema = 2\n[proposition]\n+++\n",
  );
  const cli = [
    process.execPath,
    resolve("tools/agx-ticket/src/tkt.ts"),
    "doctor",
  ];
  const normal = await run(cli);
  expect(normal.exit, normal.err).toBe(0);
  expect(normal.out).not.toContain(repo);
  const added = await run(cli, { AGX_ADDITIONAL_REPO: repo });
  expect(added.exit, added.err).toBe(1);
  expect(added.out).toContain(join(repo, "stray.md"));
  const overridden = await run(cli, {
    AGX_ADDITIONAL_REPO: repo,
    AGX_REPOS_ROOT: empty,
  });
  expect(overridden.exit, overridden.err).toBe(0);
  expect(overridden.out).not.toContain(repo);
});
