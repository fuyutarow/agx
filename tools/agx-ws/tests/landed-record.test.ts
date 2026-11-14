import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const WS = join(import.meta.dir, "../src/ws.ts");
setDefaultTimeout(90_000);

type RunResult = { out: string; err: string; code: number };
type Fixture = {
  root: string;
  repo: string;
  workspaceRoot: string;
  remote: string;
  miseState: string;
  records: string;
  env: NodeJS.ProcessEnv;
};

const isolatedEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...subprocessEnvironment() };
  delete env.AGX_NEXT_STATE_DIR;
  delete env.AGX_DOCTOR_HOME;
  delete env.AGX_DOCTOR_WORKSPACE;
  return env;
};

async function run(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { out, err, code };
}

function expectSuccess(result: RunResult, command: string): void {
  expect(result.code, `${command}\n${result.out}\n${result.err}`).toBe(0);
}

async function fixture(config = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agx-ws-gc-usecase-"));
  const repo = join(root, "project");
  const workspaceRoot = `${repo}.ws`;
  const remote = join(root, "project.git");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(root, "state");
  const miseState = join(root, "mise-state");
  const graveyard = join(root, "graveyard");
  const records = join(root, "worker-records.json");
  await Promise.all([
    mkdir(bin),
    mkdir(home),
    mkdir(workspaceRoot),
    mkdir(miseState, { recursive: true }),
  ]);
  const env: NodeJS.ProcessEnv = {
    ...isolatedEnvironment(),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    AGX_STATE_DIR: state,
    AGX_TEST_RECORDS: records,
    MISE_STATE_DIR: miseState,
    MISE_CONFIG_DIR: join(root, "mise-config"),
    MISE_CEILING_PATHS: root,
    MISE_TRUSTED_CONFIG_PATHS: "",
    MISE_PARANOID: "1",
    RIP_GRAVEYARD: graveyard,
    GRAVEYARD: graveyard,
    JJ_USER: "gc-usecase-test",
    JJ_EMAIL: "gc-usecase-test@example.com",
  };
  await Bun.write(join(bin, "agx"), '#!/bin/sh\ncat "$AGX_TEST_RECORDS"\n');
  await Bun.write(join(bin, "stat"), "#!/bin/sh\nprintf 'ext4\\n'\n");
  await Bun.write(join(bin, "mise"), "#!/bin/sh\nexit 0\n");
  await Promise.all(
    ["agx", "stat", "mise"].map((name) => chmod(join(bin, name), 0o755)),
  );
  await Bun.write(records, "[]");

  const bare = await run(["git", "init", "--bare", remote], root, env);
  expectSuccess(bare, "git init --bare");
  const initialized = await run(["jj", "git", "init", repo], root, env);
  expectSuccess(initialized, "jj git init");
  const trunkAlias = await run(
    [
      "jj",
      "config",
      "set",
      "--repo",
      'revset-aliases."trunk()"',
      "bookmarks(main)",
    ],
    repo,
    env,
  );
  expectSuccess(trunkAlias, "jj config trunk() alias");
  await Bun.write(join(repo, "tracked.txt"), "trunk content\n");
  await Bun.write(join(repo, ".mise.toml"), "[tools]\n");
  await Bun.write(
    join(repo, "agx.toml"),
    `schema = 1\n[ws]\ntrunk = "main"\n${config}`,
  );
  const committed = await run(["jj", "commit", "-m", "trunk base"], repo, env);
  expectSuccess(committed, "jj commit trunk base");
  const bookmark = await run(
    ["jj", "bookmark", "create", "main", "-r", "@-"],
    repo,
    env,
  );
  expectSuccess(bookmark, "jj bookmark create main");
  const addedRemote = await run(
    ["jj", "git", "remote", "add", "origin", remote],
    repo,
    env,
  );
  expectSuccess(addedRemote, "jj git remote add origin");

  return { root, repo, workspaceRoot, remote, miseState, records, env };
}

async function withFixture(
  action: (created: Fixture) => Promise<void>,
  config = "",
): Promise<void> {
  const created = await fixture(config);
  await using _cleanup = {
    [Symbol.asyncDispose]: () =>
      rm(created.root, { recursive: true, force: true }),
  };
  await action(created);
}

async function jj(
  f: Fixture,
  args: string[],
  cwd = f.repo,
): Promise<RunResult> {
  return run(["jj", ...args], cwd, f.env);
}

async function addWorkspace(f: Fixture, slug: string): Promise<string> {
  const path = join(f.workspaceRoot, `ws_${slug}`);
  const added = await jj(f, [
    "workspace",
    "add",
    "--name",
    `ws_${slug}`,
    "-r",
    "main",
    path,
  ]);
  expectSuccess(added, `jj workspace add ${slug}`);
  return path;
}

async function gc(f: Fixture, args: string[]): Promise<RunResult> {
  return run(
    ["bun", WS, "gc", "--apply", ...args, "--repo", f.repo],
    f.repo,
    f.env,
  );
}

async function wsCommand(f: Fixture, ...args: string[]): Promise<RunResult> {
  return run(["bun", WS, ...args, "--repo", f.repo], f.repo, f.env);
}

async function prepare(
  f: Fixture,
  slug: string,
): Promise<{ path: string; landed: string }> {
  const path = await addWorkspace(f, slug);
  await Bun.write(join(path, "tracked.txt"), "copied work\n");
  expectSuccess(await jj(f, ["status"], path), "snapshot workspace");
  expectSuccess(await jj(f, ["new", "main"], f.repo), "new trunk change");
  await Bun.write(join(f.repo, "tracked.txt"), "copied work\n");
  expectSuccess(
    await jj(f, ["commit", "-m", "copy land"], f.repo),
    "commit copy",
  );
  const id = await jj(f, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
  expectSuccess(id, "resolve landed commit");
  expectSuccess(
    await jj(f, ["bookmark", "set", "main", "-r", "@-"]),
    "advance trunk",
  );
  await Bun.write(join(f.repo, "tracked.txt"), "later trunk change\n");
  expectSuccess(await jj(f, ["commit", "-m", "later"], f.repo), "commit later");
  expectSuccess(
    await jj(f, ["bookmark", "set", "main", "-r", "@-"]),
    "advance trunk again",
  );
  return { path, landed: id.out.trim() };
}

test("refuses an unreachable commit without writing a record", async () => {
  await withFixture(async (f) => {
    const { path } = await prepare(f, "unreachable");
    const res = await wsCommand(f, "landed", "unreachable", "ws_unreachable@");
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("not reachable from trunk");
    expect(existsSync(join(f.env.AGX_STATE_DIR ?? "", "ws-landed"))).toBe(
      false,
    );
    expect(existsSync(path)).toBe(true);
  });
});

test("record permits rm after copied landing and later trunk change", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "removed");
    expectSuccess(await wsCommand(f, "landed", "removed", landed), "record");
    expectSuccess(await wsCommand(f, "rm", "removed"), "rm");
    expect(existsSync(path)).toBe(false);
  });
});

test("accepted removal guard compares a valid land record to its landed commit", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "accepted-landed");
    await Bun.write(
      f.records,
      JSON.stringify([
        {
          id: "accepted-run",
          state: "ended",
          workspace: path,
          cwd: path,
          judgment: { decision: "accept" },
        },
      ]),
    );
    expectSuccess(
      await wsCommand(f, "landed", "accepted-landed", landed),
      "record",
    );
    const result = await wsCommand(f, "rm", "accepted-landed");
    expectSuccess(result, "rm accepted landed workspace");
    expect(existsSync(path)).toBe(false);
  });
});

test("accepted removal still refuses workspace paths beyond the recorded commit", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "accepted-edited");
    await Bun.write(join(path, "tracked.txt"), "different accepted work\n");
    expectSuccess(await jj(f, ["status"], path), "snapshot divergent tip");
    await Bun.write(
      f.records,
      JSON.stringify([
        {
          id: "accepted-edit-run",
          state: "ended",
          workspace: path,
          cwd: path,
          judgment: { decision: "accept" },
        },
      ]),
    );
    expectSuccess(
      await wsCommand(f, "landed", "accepted-edited", landed),
      "record",
    );
    const result = await wsCommand(f, "rm", "accepted-edited");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain(`recorded landed commit ${landed}`);
    expect(existsSync(path)).toBe(true);
  });
});

test("unrecorded accepted paths still compare against current trunk", async () => {
  await withFixture(async (f) => {
    const { path } = await prepare(f, "accepted-no-record");
    await Bun.write(
      f.records,
      JSON.stringify([
        {
          id: "accepted-unrecorded-run",
          state: "ended",
          workspace: path,
          cwd: path,
          judgment: { decision: "accept" },
        },
      ]),
    );
    const result = await wsCommand(f, "rm", "accepted-no-record");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("accepted work has unlanded paths");
    expect(result.err).toContain("land or reject it first");
    expect(existsSync(path)).toBe(true);
  });
});

test("edits after recording are protected, including after snapshot", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "edited");
    expectSuccess(await wsCommand(f, "landed", "edited", landed), "record");
    await Bun.write(join(path, "tracked.txt"), "new work\n");
    expect((await wsCommand(f, "rm", "edited")).code).not.toBe(0);
    expectSuccess(await jj(f, ["status"], path), "snapshot edit");
    expect((await wsCommand(f, "rm", "edited")).code).not.toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

test("gc collects a workspace with a matching landed record", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "collected");
    expectSuccess(await wsCommand(f, "landed", "collected", landed), "record");
    const result = await gc(f, [
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(result, "gc");
    expect(result.out).toContain("landed by record");
    expect(existsSync(path)).toBe(false);
  });
});

test("record is ignored when trunk no longer contains the landed commit", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "rewound");
    expectSuccess(await wsCommand(f, "landed", "rewound", landed), "record");
    expectSuccess(
      await jj(f, [
        "bookmark",
        "set",
        "main",
        "-r",
        `${landed}--`,
        "--allow-backwards",
      ]),
      "rewind trunk",
    );
    expect((await wsCommand(f, "rm", "rewound")).code).not.toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

test("record does not bypass untracked content", async () => {
  await withFixture(async (f) => {
    const { path, landed } = await prepare(f, "untracked");
    expectSuccess(await wsCommand(f, "landed", "untracked", landed), "record");
    await Bun.write(join(path, "untracked.txt"), "keep me\n");
    const result = await wsCommand(f, "rm", "untracked");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("untracked content");
    expect(existsSync(path)).toBe(true);
  });
});
