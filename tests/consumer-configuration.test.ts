import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verificationEnvironment } from "../tools/agx-worker/src/next/verify.ts";
import { InspectionUnavailable } from "../tools/shared/src/agx-config.ts";
import { subprocessEnvironment } from "../tools/shared/src/subprocess-env.ts";

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

test("doctor inspects a registered repository and ignores an unregistered git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "consumer-doctor-"));
  const home = join(root, "home");
  const workspace = join(home, "Workspace");
  const repo = join(workspace, "registered");
  const unregistered = join(workspace, "unregistered");
  const bin = join(root, "bin");
  const config = join(root, "config");
  const registry = join(config, "agx/repos");
  await Promise.all(
    [home, workspace, bin, registry].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(bin, "agx"),
    `#!${process.execPath}\nprocess.stdout.write('[]');\n`,
    { mode: 0o755 },
  );
  const env = {
    ...subprocessEnvironment(),
    HOME: home,
    AGX_REPOS_ROOT: join(root, "empty-override"),
    AGX_ADDITIONAL_REPO: unregistered,
    XDG_CONFIG_HOME: config,
    PATH: `${bin}:${process.env.PATH}`,
  };
  async function run(
    args: string[],
    extra: NodeJS.ProcessEnv = {},
    cwd = root,
  ) {
    const child = Bun.spawn(args, {
      cwd,
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
  for (const path of [repo, unregistered]) {
    const init = await run(["jj", "git", "init", path], {}, root);
    expect(init.exit, init.err).toBe(0);
    const revset = await run(
      [
        "jj",
        "config",
        "set",
        "--repo",
        'revset-aliases."trunk()"',
        "bookmarks(main)",
      ],
      {},
      path,
    );
    expect(revset.exit, revset.err).toBe(0);
    await writeFile(join(path, "base"), "base\n");
    await writeFile(
      join(path, "stray.md"),
      "+++\nschema = 2\n[proposition]\n+++\n",
    );
    const commit = await run(["jj", "commit", "-m", "base"], {}, path);
    expect(commit.exit, commit.err).toBe(0);
    const bookmark = await run(
      ["jj", "bookmark", "create", "main", "-r", "@-"],
      {},
      path,
    );
    expect(bookmark.exit, bookmark.err).toBe(0);
  }
  await writeFile(
    join(registry, "registered.toml"),
    `schema = 1\nroot = ${JSON.stringify(repo)}\n`,
  );
  const cli = [
    process.execPath,
    resolve("tools/agx-ticket/src/tkt.ts"),
    "doctor",
  ];
  const result = await run(cli);
  expect(result.exit, result.err).toBe(1);
  expect(result.out).toContain(join(repo, "stray.md"));
  expect(result.out).not.toContain(unregistered);
});
