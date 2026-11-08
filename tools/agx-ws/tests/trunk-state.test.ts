import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

setDefaultTimeout(60_000);
const WS = join(import.meta.dir, "../src/ws.ts");

const scratch = mkdtempSync(join(tmpdir(), "ws-trunk-state-"));
const bin = join(scratch, "bin");
const home = join(scratch, "home");
mkdirSync(bin);
mkdirSync(home);
for (const [name, body] of [
  ["stat", "echo ext4"],
  ["agx", 'echo "[]"'],
] as const) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

const env = (): Record<string, string | undefined> => {
  const base: Record<string, string | undefined> = {
    ...subprocessEnvironment(),
  };
  delete base.AGX_NEXT_STATE_DIR;
  return {
    ...base,
    JJ_CONFIG: "",
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    AGX_STATE_DIR: join(home, "state/agx"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(scratch, "cache"),
    MISE_CEILING_PATHS: scratch,
    RIP_GRAVEYARD: join(scratch, "graveyard"),
    GRAVEYARD: join(scratch, "graveyard"),
    JJ_USER: "t",
    JJ_EMAIL: "t@example.com",
  };
};

async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}
const jj = async (args: string[], cwd: string) => {
  const r = await run(["jj", ...args], cwd);
  expect(r.code, `jj ${args.join(" ")}: ${r.err}`).toBe(0);
  return r.out.trim();
};
const commitOf = (rev: string, cwd: string) =>
  jj(["log", "--no-graph", "-r", rev, "-T", "commit_id"], cwd);

let counter = 0;
/** Repo whose trunk() is `alpha@origin` (as in a repo whose trunk bookmark is not main); `withRemote` pushes alpha. */
async function fixture(withRemote: boolean, localTrunk = false) {
  const parent = join(scratch, `r${++counter}`);
  mkdirSync(parent);
  const path = join(parent, "proj");
  await jj(["git", "init", path], parent);
  await jj(
    [
      "config",
      "set",
      "--repo",
      'revset-aliases."trunk()"',
      localTrunk ? "bookmarks(exact:alpha)" : "present(alpha@origin)",
    ],
    path,
  );
  if (localTrunk)
    writeFileSync(
      join(path, "agx.toml"),
      'schema = 1\n[ws]\ntrunk = "alpha"\n',
    );
  writeFileSync(join(path, "a.txt"), "a\n");
  await jj(["commit", "-m", "base"], path);
  await jj(["bookmark", "create", "alpha", "-r", "@-"], path);
  const remote = join(parent, "origin.git");
  const init = await run(["git", "init", "--bare", remote], parent);
  expect(init.code).toBe(0);
  await jj(["git", "remote", "add", "origin", remote], path);
  if (withRemote)
    await jj(
      ["git", "push", "--remote", "origin", "--bookmark", "alpha"],
      path,
    );
  return path;
}
async function advanceLocal(path: string, text: string) {
  writeFileSync(join(path, "a.txt"), text);
  await jj(["commit", "-m", text], path);
  await jj(["bookmark", "set", "alpha", "-r", "@-"], path);
}
const add = (path: string, slug: string, extra: string[] = []) =>
  run(["bun", WS, "add", slug, "--no-fetch", ...extra], path);
const wsParent = (path: string, slug: string) =>
  commitOf(`ws_${slug}@`, path).catch(() => "");

describe("AGX-WS-TRUNK-AHEAD-MESSAGE-1103", () => {
  test("absent remote bookmark keeps the fetch advice", async () => {
    const path = await fixture(false, true);
    const r = await add(path, "absent");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no remote-tracking trunk bookmark found");
    expect(r.err).toContain("fetch the trunk bookmark");
    expect(r.err).toContain((await commitOf("alpha", path)).slice(0, 12));
  });

  test("local trunk one commit ahead of alpha@origin succeeds on the local commit", async () => {
    const path = await fixture(true);
    const remote = await commitOf("alpha@origin", path);
    await advanceLocal(path, "b\n");
    const local = await commitOf("alpha", path);
    expect(local).not.toBe(remote);
    const r = await add(path, "ahead");
    expect(r.err).not.toContain("no remote-tracking trunk bookmark");
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toContain(local.slice(0, 12));
  });

  test("consumer state: local alpha three commits ahead of alpha@origin creates the workspace, also when trunk names the remote bookmark", async () => {
    for (const trunk of ["alpha", "alpha@origin"]) {
      const path = await fixture(true, true);
      writeFileSync(
        join(path, "agx.toml"),
        `schema = 1\n[ws]\ntrunk = ${JSON.stringify(trunk)}\n`,
      );
      const remote = await commitOf("alpha@origin", path);
      await advanceLocal(path, `ahead-1 ${trunk}\n`);
      await advanceLocal(path, `ahead-2 ${trunk}\n`);
      await advanceLocal(path, `ahead-3 ${trunk}\n`);
      const local = await commitOf("alpha", path);
      expect(local).not.toBe(remote);
      const r = await add(path, `ahead3-${trunk.replace(/\W/gu, "")}`);
      expect(r.err).not.toContain("no remote-tracking trunk bookmark");
      expect(r.code, r.err).toBe(0);
      expect(r.out + r.err).toContain(local.slice(0, 12));
    }
  });

  test("diverged local trunk and alpha@origin is told apart and names both commits", async () => {
    const path = await fixture(true);
    const remote = await commitOf("alpha@origin", path);
    // Rewrite the pushed commit locally: same change, new commit id.
    await jj(
      ["describe", "--ignore-immutable", "-r", "alpha", "-m", "rewritten"],
      path,
    );
    const local = await commitOf("alpha", path);
    expect(local).not.toBe(remote);
    const r = await add(path, "diverged");
    expect(r.code).not.toBe(0);
    expect(r.err).not.toContain("no remote-tracking trunk bookmark");
    expect(r.err).toContain("has diverged");
    expect(r.err).toContain(local.slice(0, 12));
    expect(r.err).toContain(remote.slice(0, 12));
    expect(r.err).toContain("--rev");
  });

  test("a conflicted local trunk bookmark is refused with its own message", async () => {
    const path = await fixture(true);
    const base = await commitOf("alpha", path);
    await jj(["new", base, "-m", "x"], path);
    const a = await commitOf("@", path);
    await jj(["new", base, "-m", "y"], path);
    const b = await commitOf("@", path);
    // Two concurrent moves of alpha from the same operation conflict the bookmark.
    const op = await jj(["op", "log", "--no-graph", "-n1", "-T", "id"], path);
    await jj(["bookmark", "set", "alpha", "-r", a], path);
    await jj(["--at-op", op, "bookmark", "set", "alpha", "-r", b], path);
    const state = await jj(["bookmark", "list", "alpha"], path);
    expect(state).toContain("conflicted");
    const r = await add(path, "conflicted");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is conflicted");
    expect(r.err).toContain(a.slice(0, 12));
    expect(r.err).toContain(b.slice(0, 12));
    expect(r.err).not.toContain("no remote-tracking trunk bookmark");
  });

  test("explicit --rev never consults the trunk state", async () => {
    const path = await fixture(true);
    await advanceLocal(path, "b\n");
    const local = await commitOf("alpha", path);
    const r = await add(path, "explicit", ["--rev", local]);
    expect(r.code, r.err).toBe(0);
    expect(await wsParent(path, "explicit")).not.toBe("");
  });
});
