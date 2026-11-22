// Speed claims that the gate can check: how many `jj` processes one `agx ws` command starts.
// The same input gives the same count on any machine and under any load, which wall time and
// CPU time do not (docs/test-gate.md). A count that changes is a deliberate edit of this file.
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const scratch = await mkdtemp(join(tmpdir(), "ws-jj-count-"));
const ws = join(import.meta.dir, "../src/ws.ts");
const realJj = Bun.which("jj") ?? "jj";
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function fixture() {
  const root = scratch;
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const calls = join(root, "jj-calls.log");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "home"));
  await mkdir(join(root, "config", "jj", "repos"), { recursive: true });
  const env = {
    ...subprocessEnvironment(),
    JJ_CONFIG: "",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    AGX_STATE_DIR: join(root, "state/agx"),
    RIP_GRAVEYARD: join(root, "graveyard"),
    GRAVEYARD: join(root, "graveyard"),
    JJ_USER: "test",
    JJ_EMAIL: "test@example.com",
  };
  const run = async (cmd: string[], cwd: string, path: string) => {
    const child = Bun.spawn(cmd, {
      cwd,
      env: { ...env, PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  const plainPath = process.env.PATH ?? "";
  const jj = async (args: string[], cwd = repo) => {
    const result = await run([realJj, ...args], cwd, plainPath);
    expect(result.code, result.err).toBe(0);
  };
  await jj(["git", "init", repo], root);
  await jj([
    "config",
    "set",
    "--repo",
    'revset-aliases."trunk()"',
    "bookmarks(main)",
  ]);
  await Bun.write(join(repo, "a.txt"), "base\n");
  await Bun.write(join(repo, "agx.toml"), 'schema = 1\n[ws]\ntrunk = "main"\n');
  await jj(["commit", "-m", "base"]);
  await jj(["bookmark", "create", "main", "-r", "@-"]);
  // The shim records one line per call, then becomes the real jj.
  const shim = join(bin, "jj");
  await Bun.write(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$1 $2" >> "${calls}"\nexec "${realJj}" "$@"\n`,
  );
  await chmod(shim, 0o755);
  // The scratch directory is on tmpfs, which the graveyard check refuses; rip may be absent.
  const stand = async (name: string, body: string) => {
    await Bun.write(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await stand("stat", "echo ext4");
  await stand(
    "rip",
    'mkdir -p "$RIP_GRAVEYARD"; target=$(mktemp -d "$RIP_GRAVEYARD/rip-XXXXXXXX"); mv "$1" "$target/"',
  );
  /** Runs one `agx ws` command and returns the jj subcommands it started, in order. */
  const counted = async (args: string[]) => {
    await Bun.write(calls, "");
    const result = await run(
      [process.execPath, ws, ...args],
      repo,
      `${bin}:${plainPath}`,
    );
    const lines = (await Bun.file(calls).text())
      .split("\n")
      .filter((line) => line !== "");
    return { ...result, jj: lines };
  };
  return { counted };
}

test("each agx ws command starts a fixed number of jj processes", async () => {
  const f = await fixture();
  const add = await f.counted(["add", "counted"]);
  expect(add.code, add.err).toBe(0);
  const doctor = await f.counted(["doctor"]);
  expect(doctor.code, doctor.err).toBe(0);
  const gc = await f.counted(["gc"]);
  expect(gc.code, gc.err).toBe(0);
  const rmResult = await f.counted(["rm", "counted"]);
  expect(rmResult.code, rmResult.err).toBe(0);
  expect({
    add: add.jj.length,
    doctor: doctor.jj.length,
    gc: gc.jj.length,
    rm: rmResult.jj.length,
  }).toEqual({ add: 8, doctor: 0, gc: 6, rm: 11 });
});
