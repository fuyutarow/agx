import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";

export type RepoFixture = {
  root: string;
  source: string;
  remote: string;
  env: Record<string, string | undefined>;
};

export async function repoFixture(
  prefix = "agx-worker-store-",
): Promise<RepoFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const source = join(root, "project");
  const remote = join(root, "remote.git");
  const config = join(root, "config");
  const bin = join(root, "bin");
  const graveyard = join(root, "graveyard");
  await Promise.all(
    [
      source,
      config,
      bin,
      graveyard,
      join(root, "home"),
      join(root, "data"),
    ].map((path) => mkdir(path, { recursive: true })),
  );
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    AGX_STATE_DIR: join(root, "state", "agx"),
    RIP_GRAVEYARD: graveyard,
    GRAVEYARD: graveyard,
    FAKE_FS: "ext4",
    JJ_USER: "Fixture",
    JJ_EMAIL: "fixture@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  await writeFile(join(bin, "stat"), "#!/bin/sh\necho ext4\n", {
    mode: 0o755,
  });
  await writeFile(
    join(bin, "mise"),
    "#!/usr/bin/env bun\nprocess.stdout.write('{}\\n');\n",
    { mode: 0o755 },
  );
  const initSource = await run(["jj", "git", "init", source], root, env);
  if (initSource.code !== 0)
    throw new Error(`jj git init failed: ${initSource.err}`);
  await writeFile(join(source, "file.txt"), "base\n");
  await writeFile(join(source, ".ws.toml"), 'trunk = "alpha@origin"\n');
  await writeFile(
    join(source, "agx.toml"),
    'schema = 1\ntickets = ".agents/tickets"\n',
  );
  await mkdir(join(source, ".agents", "tickets"), { recursive: true });

  const initRemote = Bun.spawnSync(["git", "init", "--bare", remote], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (initRemote.exitCode !== 0)
    throw new Error(`git init --bare failed: ${initRemote.stderr.toString()}`);
  const base = await run(["jj", "commit", "-m", "base"], source, env);
  if (base.code !== 0) throw new Error(`jj commit failed: ${base.err}`);
  for (const [args, cwd] of [
    [["bookmark", "create", "alpha", "-r", "@-"], source],
    [["git", "remote", "add", "origin", remote], source],
    [["git", "push", "--remote", "origin", "--bookmark", "alpha"], source],
  ] as const) {
    const result = await run(["jj", ...args], cwd, env);
    if (result.code !== 0)
      throw new Error(`jj ${args.join(" ")} failed: ${result.err}`);
  }
  return { root, source, remote, env };
}

export async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 900_000,
    killSignal: "SIGKILL",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

export async function addWorkerStore(
  fixture: RepoFixture,
  slug: string,
): Promise<{ workspace: string; out: string; err: string }> {
  const script = new URL("../src/ws.ts", import.meta.url).pathname;
  const result = await run(
    [
      process.execPath,
      script,
      "add",
      slug,
      "--worker-store",
      "--repo",
      fixture.source,
      "--json",
    ],
    fixture.source,
    fixture.env,
  );
  if (result.code !== 0)
    throw new Error(`agx-ws add failed (exit ${result.code}): ${result.err}`);
  const parsed = jsonOf(z.object({ workspace: z.string() })).safeParse(
    result.out,
  );
  if (!parsed.success)
    throw new Error(`agx-ws add returned no workspace: ${result.out}`);
  return { workspace: parsed.data.workspace, out: result.out, err: result.err };
}

export async function snapshot(path: string): Promise<string[]> {
  const rows: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).toSorted()) {
      const full = join(directory, name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        rows.push(`${full.slice(path.length)}\0link\0${await readlink(full)}`);
      } else if (info.isDirectory()) {
        await visit(full);
      } else if (info.isFile()) {
        const bytes = await readFile(full);
        rows.push(
          `${full.slice(path.length)}\0${createHash("sha256").update(bytes).digest("hex")}`,
        );
      }
    }
  };
  await visit(path);
  return rows;
}

export async function chmodTree(
  path: string,
  writable: boolean,
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  const mode = info.mode & 0o777;
  await chmod(path, writable ? mode | 0o200 : mode & ~0o222);
  if (!info.isDirectory()) return;
  for (const name of await readdir(path))
    await chmodTree(join(path, name), writable);
}

export async function removeFixture(fixture: RepoFixture): Promise<void> {
  await chmodTree(fixture.source, true).catch(() => {});
  await rm(fixture.root, { recursive: true, force: true });
}
