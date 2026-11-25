// Shared by the workspace-*.test.ts files. Fixtures use real jj repositories in a scratch
// directory, a fake `agx` on PATH, and a `stat` shim whose answer decides whether the graveyard
// looks RAM-backed. Each test file is its own process, so each gets its own scratch directory.
import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod, unlink, lstat } from "node:fs/promises";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

export const WS = join(import.meta.dir, "../src/ws.ts");
export const scratch = mkdtempSync(join(tmpdir(), "ws-test-"));
export const localPolicyFiles: string[] = [];
mkdirSync(join(scratch, "config", "jj", "repos"), { recursive: true });
export const bin = join(scratch, "bin");
export const graveyard = join(scratch, "graveyard");
export const records = join(scratch, "agx.json");
export const home = join(scratch, "home");

export const baseEnv = (
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  ...stateTestEnv(),
  JJ_CONFIG: "",
  PATH: `${bin}:${process.env.PATH}`,
  HOME: home,
  XDG_STATE_HOME: join(home, "state"),
  AGX_STATE_DIR: join(home, "state/agx"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  MISE_STATE_DIR: join(scratch, "mise-state"),
  MISE_CONFIG_DIR: join(scratch, "mise-config"),
  MISE_CEILING_PATHS: scratch,
  MISE_TRUSTED_CONFIG_PATHS: "",
  MISE_PARANOID: "1",
  RIP_GRAVEYARD: graveyard,
  GRAVEYARD: graveyard,
  JJ_USER: "t",
  JJ_EMAIL: "t@example.com",
  FAKE_FS: "ext4",
  ...extra,
});

export async function run(cmd: string[], cwd: string, env = baseEnv()) {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}
// Existing GC fixtures predate the default grace contract; opt them out unless a test sets it.
export const ws = (args: string[], cwd: string, env = baseEnv()) =>
  run(
    [
      "bun",
      WS,
      ...args,
      ...(args[0] === "gc" &&
      !args.includes("--grace-minutes") &&
      !args.includes("--help")
        ? ["--grace-minutes", "0"]
        : []),
    ],
    cwd,
    env,
  );
export const jj = (args: string[], cwd: string) => run(["jj", ...args], cwd);

export async function pushBookmark(
  path: string,
  name: string,
): Promise<string> {
  const remote = join(scratch, `remote-${name}.git`);
  const init = Bun.spawn(["git", "init", "--bare", remote], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, , initCode] = await Promise.all([
    new Response(init.stdout).text(),
    new Response(init.stderr).text(),
    init.exited,
  ]);
  expect(initCode).toBe(0);
  expect(
    (await jj(["git", "remote", "add", "origin", remote], path)).code,
  ).toBe(0);
  expect((await jj(["bookmark", "create", name, "-r", "@-"], path)).code).toBe(
    0,
  );
  const pushed = await jj(
    ["git", "push", "--remote", "origin", "--bookmark", name],
    path,
  );
  expect(pushed.code, pushed.err).toBe(0);
  return remote;
}

export function shim(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}
export const setRecords = (rows: object[]): void => {
  writeFileSync(records, JSON.stringify(rows));
};

afterEach(async () => {
  await Promise.all(localPolicyFiles.splice(0).map((path) => unlink(path)));
});

export const seq = { n: 0 };
/** A fresh repo `<scratch>/n/<name>` with one landed commit on bookmark `main`; returns its path. */
export async function repo(config?: string, colocate = true): Promise<string> {
  const parent = join(scratch, `r${++seq.n}`);
  mkdirSync(parent);
  const path = join(parent, "proj");
  expect(
    (
      await jj(
        ["git", "init", ...(colocate ? [] : ["--no-colocate"]), path],
        parent,
      )
    ).code,
  ).toBe(0);
  expect(
    (
      await jj(
        [
          "config",
          "set",
          "--repo",
          'revset-aliases."trunk()"',
          "bookmarks(main)",
        ],
        path,
      )
    ).code,
  ).toBe(0);
  writeFileSync(join(path, "a.txt"), "a\n");
  if (config !== undefined)
    writeFileSync(join(path, "agx.toml"), `schema = 1\n[ws]\n${config}`);
  await jj(["commit", "-m", "base"], path);
  expect(
    (await jj(["bookmark", "create", "main", "-r", "@-"], path)).code,
  ).toBe(0);
  return path;
}
export const wsDir = (path: string, slug: string): string =>
  join(path, "..", "proj.ws", `ws_${slug}`);

export async function brokenFixture(slug: string, unlanded = false) {
  const path = await repo('trunk = "main"\n');
  setRecords([]);
  expect((await ws(["add", slug], path)).code).toBe(0);
  const dir = wsDir(path, slug);
  if (unlanded) {
    await Bun.write(join(dir, "a.txt"), "revision change\n");
    expect((await jj(["commit", "-m", "unlanded fixture"], dir)).code).toBe(0);
  }
  await Bun.write(join(dir, "a.txt"), "disk change\n");
  const realJj = Bun.which("jj");
  const wrapper = join(scratch, `wrapper-${slug}`);
  await mkdir(wrapper);
  await Bun.write(
    join(wrapper, "jj"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log")) { process.stderr.write("working copy revision not found\\n"); process.exit(1); }
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit", stderr:"inherit"});
process.exitCode = await child.exited;
`,
  );
  await chmod(join(wrapper, "jj"), 0o755);
  return {
    path,
    dir,
    env: baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
  };
}

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  shim("agx", `cat "${records}"`);
  shim("stat", `echo "$FAKE_FS"`);
  shim(
    "rip",
    `mkdir -p "$RIP_GRAVEYARD"; target=$(mktemp -d "$RIP_GRAVEYARD/rip-XXXXXXXX"); mv "$1" "$target/"`,
  );
  setRecords([]);
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

export const listing = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).toSorted() : [];
export const symlinkTargets = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const link = join(directory, entry);
    return lstatSync(link).isSymbolicLink() ? [readlinkSync(link)] : [];
  });
export const pathExists = (dir: string): Promise<boolean> =>
  lstat(dir).then(
    () => true,
    () => false,
  );
export const gcRows = jsonOf(
  z.object({
    rows: z.array(z.array(z.string())),
    broken: z.array(z.string()),
    complete: z.boolean(),
  }),
);

export const recFor = (dir: string) => ({
  id: dir,
  state: "ended",
  cwd: dir,
  workspace: dir,
  continues: null,
  judgment: { decision: "reject" },
});

// Keep inherited configuration from influencing the explicit test cases.
export function stateTestEnv(): NodeJS.ProcessEnv {
  const env = { ...subprocessEnvironment() };
  delete env.AGX_NEXT_STATE_DIR;
  return env;
}
