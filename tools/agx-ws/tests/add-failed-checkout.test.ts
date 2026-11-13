import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, unlink } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const realJj = Bun.which("jj");
const ws = join(import.meta.dir, "../src/ws.ts");

test("failed checkout is forgotten and buried before readiness", async () => {
  expect(realJj).not.toBeNull();
  if (realJj === null) return;
  const root = await mkdtemp(join(tmpdir(), "ws-failed-checkout-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await mkdir(bin);
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    AGX_STATE_DIR: join(root, "state", "agx"),
    MISE_STATE_DIR: join(root, "mise"),
    RIP_GRAVEYARD: join(root, "graveyard"),
    JJ_CONFIG: "",
    JJ_USER: "test",
    JJ_EMAIL: "test@example.com",
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete env.AGX_NEXT_STATE_DIR;
  await mkdir(join(root, "home"), { recursive: true });
  const run = async (args: string[], cwd = root) => {
    const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  const shim = async (name: string, body: string) => {
    const path = join(bin, name);
    await Bun.write(path, `#!/usr/bin/env bun\n${body}\n`);
    await chmod(path, 0o755);
  };
  await (async () => {
    expect((await run([realJj, "git", "init", repo])).code).toBe(0);
    await Bun.write(
      join(repo, "agx.toml"),
      'schema = 1\n[ws]\ntrunk = "main"\nready = ["touch should-not-run"]\n',
    );
    await Bun.write(join(repo, "tracked"), "original\n");
    expect((await run([realJj, "commit", "-m", "base"], repo)).code).toBe(0);
    expect(
      (await run([realJj, "bookmark", "create", "main", "-r", "@-"], repo))
        .code,
    ).toBe(0);
    await shim("stat", 'process.stdout.write("ext4\\n");');
    await shim("agx", 'process.stdout.write("[]\\n");');
    await shim(
      "jj",
      `const args = process.argv.slice(2);
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit", stderr:"inherit"});
const code = await child.exited;
if (args.includes("workspace") && args.includes("add") && code === 0) { process.stderr.write("Error when reading object deadbeef: Entry too large to fit in memory (tracked)\\n"); process.exit(1); }
process.exitCode = code;`,
    );
    const failed = await run(
      [process.execPath, ws, "add", "failed", "--repo", repo, "--rev", "main"],
      repo,
    );
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain("jj workspace add");
    expect(failed.err).toContain("deadbeef");
    expect(existsSync(join(`${repo}.ws`, "ws_failed"))).toBe(false);
    const list = await run([realJj, "workspace", "list"], repo);
    expect(list.out).not.toContain("ws_failed");
    expect(existsSync(join(`${repo}.ws`, "ws_failed", "should-not-run"))).toBe(
      false,
    );
  })().finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}, 60_000);

test("discard-broken removes missing checkout files but retains unsaved edits", async () => {
  expect(realJj).not.toBeNull();
  if (realJj === null) return;
  const root = await mkdtemp(join(tmpdir(), "ws-missing-checkout-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await mkdir(bin);
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    AGX_STATE_DIR: join(root, "state", "agx"),
    MISE_STATE_DIR: join(root, "mise"),
    RIP_GRAVEYARD: join(root, "graveyard"),
    JJ_CONFIG: "",
    JJ_USER: "test",
    JJ_EMAIL: "test@example.com",
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete env.AGX_NEXT_STATE_DIR;
  await mkdir(join(root, "home"), { recursive: true });
  const run = async (args: string[], cwd = root) => {
    const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  for (const [name, body] of [
    ["stat", 'process.stdout.write("ext4\\n");'],
    ["agx", 'process.stdout.write("[]\\n");'],
  ]) {
    const path = join(bin, name!);
    await Bun.write(path, `#!/usr/bin/env bun\n${body}\n`);
    await chmod(path, 0o755);
  }
  await (async () => {
    expect((await run([realJj, "git", "init", repo])).code).toBe(0);
    await Bun.write(
      join(repo, "agx.toml"),
      'schema = 1\n[ws]\ntrunk = "main"\n',
    );
    await Bun.write(join(repo, "missing"), "original\n");
    await Bun.write(join(repo, "edit"), "original\n");
    expect((await run([realJj, "commit", "-m", "base"], repo)).code).toBe(0);
    expect(
      (await run([realJj, "bookmark", "create", "main", "-r", "@-"], repo))
        .code,
    ).toBe(0);
    for (const slug of ["missing", "edited"]) {
      const added = await run(
        [process.execPath, ws, "add", slug, "--repo", repo, "--rev", "main"],
        repo,
      );
      expect(added.code, added.err).toBe(0);
      await unlink(join(`${repo}.ws`, `ws_${slug}`, "missing"));
    }
    await Bun.write(join(`${repo}.ws`, "ws_edited", "edit"), "unsaved edit\n");
    const wrapper = join(bin, "jj");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("show") && args.includes("missing")) { process.stderr.write("Error when reading object deadbeef: Entry too large to fit in memory\\n"); process.exit(1); }
if (args.some((arg) => arg.includes("ws_missing@") && arg.includes("empty()"))) { process.stderr.write("Error when reading object deadbeef: Entry too large to fit in memory\\n"); process.exit(1); }
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit", stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(wrapper, 0o755);
    const refused = await run(
      [
        process.execPath,
        ws,
        "rm",
        "edited",
        "--discard-broken",
        "--repo",
        repo,
      ],
      repo,
    );
    expect(refused.code).not.toBe(0);
    expect(existsSync(join(`${repo}.ws`, "ws_edited", "edit"))).toBe(true);
    const removed = await run(
      [
        process.execPath,
        ws,
        "rm",
        "missing",
        "--discard-broken",
        "--repo",
        repo,
      ],
      repo,
    );
    expect(removed.code, removed.err).toBe(0);
    expect(removed.err).toContain("saved patch");
    const patchPath = removed.err.match(/saved patch note ([^\n]+)/u)?.[1];
    expect(patchPath).toBeDefined();
    expect(await Bun.file(patchPath ?? "").text()).toContain("deadbeef");
    expect(existsSync(join(`${repo}.ws`, "ws_missing"))).toBe(false);
    expect((await run([realJj, "workspace", "list"], repo)).out).not.toContain(
      "ws_missing",
    );
  })().finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}, 60_000);
