import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";

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
  const env = { ...process.env };
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

async function setRecords(f: Fixture, records: object[]): Promise<void> {
  await Bun.write(f.records, JSON.stringify(records));
}

async function gc(f: Fixture, args: string[]): Promise<RunResult> {
  return run(["bun", WS, "gc", ...args, "--repo", f.repo], f.repo, f.env);
}

function rowFor(result: RunResult, path: string): string[] {
  const rows = result.out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const row = rows.find((candidate) => candidate[0] === path);
  expect(row, `no gc row for ${path}\n${result.out}`).toBeDefined();
  return row ?? [];
}

function gcJson(result: RunResult): { rows: string[][]; complete: boolean } {
  const schema = z.object({
    rows: z.array(z.array(z.string())),
    complete: z.boolean(),
  });
  const parsed = jsonOf(schema).safeParse(result.out);
  expect(parsed.success, result.out).toBe(true);
  return parsed.success ? parsed.data : { rows: [], complete: false };
}

function jsonRowFor(
  report: { rows: string[][]; complete: boolean },
  path: string,
): string[] {
  const matches = report.rows.filter((row) => row[0] === path);
  expect(matches).toHaveLength(1);
  return matches[0] ?? [];
}

async function commitFile(
  f: Fixture,
  dir: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  await Bun.write(join(dir, path), content);
  const committed = await jj(f, ["commit", "-m", message], dir);
  expectSuccess(committed, `jj commit ${message}`);
}

async function pushWorkspaceBookmark(
  f: Fixture,
  dir: string,
  bookmark: string,
): Promise<void> {
  const created = await jj(
    f,
    ["bookmark", "create", bookmark, "-r", "@-"],
    dir,
  );
  expectSuccess(created, `jj bookmark create ${bookmark}`);
  const pushed = await jj(
    f,
    ["git", "push", "--remote", "origin", "--bookmark", bookmark],
    dir,
  );
  expectSuccess(pushed, `jj git push ${bookmark}`);
}

test.todo("gc usecase: U1 dry-run gives each workspace one removable, keep, or broken verdict and exits 0 when every row is judged — owner agx-ws-gc-constant-cost-1026", async () => {
  await withFixture(async (f) => {
    const removable = await addWorkspace(f, "dry-removable");
    const keep = await addWorkspace(f, "dry-keep");
    await Bun.write(join(keep, "untracked.txt"), "preserve\n");

    const dry = await gc(f, [
      "--dry-run",
      "--json",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(dry, "agx ws gc --dry-run --json");
    const report = gcJson(dry);
    expect(report.complete).toBe(true);
    expect(report.rows).toHaveLength(2);
    expect(jsonRowFor(report, removable)[2]).toBe("removable");
    expect(jsonRowFor(report, keep)[2]).toBe("keep");
    for (const row of report.rows) {
      expect(["removable", "keep", "broken"].includes(row[2] ?? "")).toBe(true);
      expect(row[5]?.length).toBeGreaterThan(0);
    }
  });
});

test("gc usecase: U2 removes a workspace whose non-empty change is reachable from a remote bookmark", async () => {
  await withFixture(async (f) => {
    const collectedPath = await addWorkspace(f, "remote-collected");
    await commitFile(
      f,
      collectedPath,
      "remote-work.txt",
      "published work\n",
      "published work",
    );
    await pushWorkspaceBookmark(f, collectedPath, "published-work");

    const removedPath = await addWorkspace(f, "remote-removed");
    await commitFile(
      f,
      removedPath,
      "remote-rm.txt",
      "published work for rm\n",
      "published rm work",
    );
    await pushWorkspaceBookmark(f, removedPath, "published-rm-work");

    const trunkPath = await addWorkspace(f, "trunk-collected");
    await commitFile(
      f,
      trunkPath,
      "trunk-work.txt",
      "landed work\n",
      "landed work",
    );

    const removed = await run(
      ["bun", WS, "rm", "remote-removed", "--repo", f.repo],
      f.repo,
      f.env,
    );
    expectSuccess(removed, "agx ws rm remote-removed");
    expect(existsSync(removedPath)).toBe(false);

    const advancedTrunk = await jj(
      f,
      ["bookmark", "set", "main", "-r", "@-"],
      trunkPath,
    );
    expectSuccess(advancedTrunk, "jj bookmark set main");

    const dry = await gc(f, [
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(dry, "agx ws gc --dry-run");
    expect(rowFor(dry, collectedPath)[2]).toBe("removable");
    const trunkVerdict = rowFor(dry, trunkPath)[2];
    expect(["removable", "empty", "landed"].includes(trunkVerdict ?? "")).toBe(
      true,
    );

    const collected = await gc(f, [
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(collected, "agx ws gc");
    expect(rowFor(collected, collectedPath)[2]).toBe("removable");
    expect(rowFor(collected, trunkPath)[2]).toBe("removable");
    expect(existsSync(collectedPath)).toBe(false);
    expect(existsSync(trunkPath)).toBe(false);
  });
});

test("gc usecase: U3 keeps and names the ten unpushed changes in a workspace", async () => {
  await withFixture(async (f) => {
    const path = await addWorkspace(f, "unpushed");
    for (let index = 1; index <= 10; index++) {
      const suffix = String(index).padStart(2, "0");
      await commitFile(
        f,
        path,
        `unpublished-${suffix}.txt`,
        `change ${suffix}\n`,
        `unpublished change ${suffix}`,
      );
    }

    const dry = await gc(f, [
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(dry, "agx ws gc --dry-run");
    const row = rowFor(dry, path);
    expect(row[2], row.join("\t")).toBe("keep");
    expect(row[5]).toContain("unlanded change");
    expect(row[5]).toContain("unpublished change 10");

    const removed = await run(
      ["bun", WS, "rm", "unpushed", "--repo", f.repo],
      f.repo,
      f.env,
    );
    expect(removed.code).toBe(1);
    expect(removed.err).toContain("unlanded changes");
    for (let index = 1; index <= 10; index++)
      expect(removed.err).toContain(
        `unpublished change ${String(index).padStart(2, "0")}`,
      );
    expect(existsSync(path)).toBe(true);
  });
});

test.todo("gc usecase: U4 reports a missing registered directory as broken and continues, including a relative recorded root — owner agx-ws-gc-constant-cost-1026; firedancer canonical-cache-repro-b and ci-gate-clean-1024", async () => {
  await withFixture(async (f) => {
    const missing = join(f.workspaceRoot, "ws_missing-relative");
    const addedMissing = await jj(f, [
      "workspace",
      "add",
      "--name",
      "ws_missing-relative",
      "-r",
      "main",
      "../project.ws/ws_missing-relative",
    ]);
    expectSuccess(addedMissing, "jj workspace add relative missing");
    const intact = await addWorkspace(f, "intact");
    await rm(missing, { recursive: true, force: true });

    const dry = await gc(f, [
      "--dry-run",
      "--json",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    const report = gcJson(dry);
    expect(
      report.rows.some((row) => row[0] === missing && row[2] === "broken"),
    ).toBe(true);
    expect(report.rows.some((row) => row[0] === intact)).toBe(true);
  });
});

test.todo("gc usecase: U5 gc judges unregistered sibling directories by comparing trunk-tracked files — owner agx-ws-gc-unregistered-1027", async () => {
  await withFixture(async (f) => {
    const equal = await addWorkspace(f, "orphan-equal");
    const different = await addWorkspace(f, "orphan-different");
    await commitFile(
      f,
      different,
      "tracked.txt",
      "changed outside trunk\n",
      "orphan tracked difference",
    );
    for (const name of ["ws_orphan-equal", "ws_orphan-different"])
      expectSuccess(
        await jj(f, ["workspace", "forget", name]),
        `jj workspace forget ${name}`,
      );

    const dry = await gc(f, [
      "--dry-run",
      "--json",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    const report = gcJson(dry);
    expect(jsonRowFor(report, equal)[2]).toBe("removable");
    const differing = jsonRowFor(report, different);
    expect(differing[2]).toBe("keep");
    expect(differing[5]).toContain("tracked.txt");
  });
});

test("gc usecase: U5 rm compares unregistered sibling files to trunk before removal", async () => {
  await withFixture(async (f) => {
    const equal = await addWorkspace(f, "orphan-equal");
    const different = await addWorkspace(f, "orphan-different");
    await commitFile(
      f,
      different,
      "tracked.txt",
      "changed outside trunk\n",
      "orphan tracked difference",
    );
    for (const name of ["ws_orphan-equal", "ws_orphan-different"]) {
      const forgotten = await jj(f, ["workspace", "forget", name]);
      expectSuccess(forgotten, `jj workspace forget ${name}`);
    }

    const listed = await jj(f, ["workspace", "list", "-T", 'name ++ "\\n"']);
    expectSuccess(listed, "jj workspace list");
    expect(listed.out).not.toContain("ws_orphan-equal");
    expect(listed.out).not.toContain("ws_orphan-different");

    const removedEqual = await run(
      ["bun", WS, "rm", "orphan-equal", "--repo", f.repo],
      f.repo,
      f.env,
    );
    expectSuccess(removedEqual, "agx ws rm orphan-equal");
    expect(existsSync(equal)).toBe(false);

    const keptDifferent = await run(
      ["bun", WS, "rm", "orphan-different", "--repo", f.repo],
      f.repo,
      f.env,
    );
    expect(keptDifferent.code).toBe(1);
    expect(keptDifferent.err).toContain("tracked.txt");
    expect(existsSync(different)).toBe(true);
  });
});

test("gc usecase: U6 keeps live workspaces and workspaces younger than the grace period", async () => {
  await withFixture(async (f) => {
    const live = await addWorkspace(f, "live");
    const young = await addWorkspace(f, "young");
    await setRecords(f, [
      {
        id: "live-usecase-run",
        state: "running",
        workspace: live,
        cwd: live,
        continues: null,
        started_at: Temporal.Now.instant().toString(),
      },
    ]);

    const liveDry = await gc(f, [
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(liveDry, "agx ws gc --dry-run live");
    const liveRow = rowFor(liveDry, live);
    expect(liveRow[2]).toBe("keep");
    expect(liveRow[5]).toContain("live or continuing run live-usecase-run");

    await setRecords(f, []);
    const youngDry = await gc(f, ["--dry-run", "--include-unrecorded"]);
    expectSuccess(youngDry, "agx ws gc --dry-run young");
    const youngRow = rowFor(youngDry, young);
    expect(youngRow[2]).toBe("keep");
    expect(youngRow[5]).toContain("grace 30 min");
  });
});

test("gc usecase: U7 ignores declared regenerable paths but keeps other untracked files by name", async () => {
  await withFixture(async (f) => {
    const path = await addWorkspace(f, "regenerable");
    await mkdir(join(path, "generated"), { recursive: true });
    await mkdir(join(path, "node_modules", "fixture-package"), {
      recursive: true,
    });
    await Bun.write(join(path, "generated", "bundle.js"), "generated\n");
    await Bun.write(
      join(path, "node_modules", "fixture-package", "index.js"),
      "installed\n",
    );

    const onlyRegenerable = await gc(f, [
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(onlyRegenerable, "agx ws gc --dry-run");
    const cleanRow = rowFor(onlyRegenerable, path);
    expect(
      ["removable", "empty", "landed"].includes(cleanRow[2] ?? ""),
      onlyRegenerable.out,
    ).toBe(true);
    expect(cleanRow[5]).not.toContain("generated");
    expect(cleanRow[5]).not.toContain("node_modules");

    await Bun.write(join(path, "valuable-output.json"), "keep me\n");
    const withUntracked = await gc(f, [
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(withUntracked, "agx ws gc --dry-run");
    const kept = rowFor(withUntracked, path);
    expect(kept[2]).toBe("keep");
    expect(kept[5]).toContain("valuable-output.json");
    expect(kept[5]).not.toContain("node_modules");
  }, 'regenerable = ["generated/", "node_modules/"]\n');
});

test("gc usecase: U7 reads declared regenerable paths from agx.toml [ws]", async () => {
  await withFixture(async (f) => {
    const path = await addWorkspace(f, "agx-regenerable");
    await mkdir(join(path, "generated"), { recursive: true });
    await Bun.write(join(path, "generated", "bundle.js"), "generated\n");

    const dry = await gc(f, [
      "--dry-run",
      "--json",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(dry, "agx ws gc --dry-run --json");
    const row = jsonRowFor(gcJson(dry), path);
    expect(row[2]).toBe("removable");
    expect(row[5]).not.toContain("generated");
  }, 'regenerable = ["generated/"]\n');
});

test.todo("gc usecase: U8 classification uses the same number of jj calls for 5 and 50 workspaces — owner agx-ws-gc-constant-cost-1026", async () => {
  await withFixture(async (f) => {
    for (let index = 0; index < 5; index++)
      await addWorkspace(f, `count-${index}`);
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    if (realJj === null) {
      expect(realJj, "jj is required for this fixture").not.toBeNull();
      return;
    }
    const calls = join(f.root, "jj-calls.log");
    f.env.JJ_CALL_LOG = calls;
    await Bun.write(
      join(f.root, "bin", "jj"),
      `#!/bin/sh\nprintf 'jj\\n' >> "$JJ_CALL_LOG"\nexec ${JSON.stringify(realJj)} "$@"\n`,
    );
    await chmod(join(f.root, "bin", "jj"), 0o755);
    await Bun.write(calls, "");
    expectSuccess(
      await gc(f, [
        "--dry-run",
        "--include-unrecorded",
        "--grace-minutes",
        "0",
      ]),
      "agx ws gc for five workspaces",
    );
    const fiveCalls = (await Bun.file(calls).text())
      .split("\n")
      .filter(Boolean).length;

    for (let index = 5; index < 50; index++)
      await addWorkspace(f, `count-${index}`);
    await Bun.write(calls, "");
    expectSuccess(
      await gc(f, [
        "--dry-run",
        "--include-unrecorded",
        "--grace-minutes",
        "0",
      ]),
      "agx ws gc for fifty workspaces",
    );
    const fiftyCalls = (await Bun.file(calls).text())
      .split("\n")
      .filter(Boolean).length;
    expect(fiftyCalls).toBe(fiveCalls);
  });
});

test.todo("gc usecase: U9 holds the workspace lock only for forget plus rename to a tombstone — owner agx-ws-rm-tombstone-1026", async () => {
  await withFixture(async (f) => {
    const path = await addWorkspace(f, "lock-scope");
    const realJj = Bun.which("jj");
    const realRip = Bun.which("rip");
    expect(realJj).not.toBeNull();
    expect(realRip).not.toBeNull();
    if (realJj === null) {
      expect(realJj, "jj and rip are required for this fixture").not.toBeNull();
      return;
    }
    if (realRip === null) {
      expect(
        realRip,
        "jj and rip are required for this fixture",
      ).not.toBeNull();
      return;
    }
    const events = join(f.root, "lock-events.log");
    const lock = join(f.root, "project.ws.lock");
    f.env.WS_LOCK_EVENTS = events;
    f.env.WS_LOCK_PATH = lock;
    f.env.WS_REAL_JJ = realJj;
    f.env.WS_REAL_RIP = realRip;
    await Bun.write(
      join(f.root, "bin", "jj"),
      '#!/bin/sh\nif [ -d "$WS_LOCK_PATH" ]; then state=held; else state=free; fi\nprintf "jj\\t%s\\t%s\\n" "$*" "$state" >> "$WS_LOCK_EVENTS"\nexec "$WS_REAL_JJ" "$@"\n',
    );
    await Bun.write(
      join(f.root, "bin", "rip"),
      '#!/bin/sh\nif [ -d "$WS_LOCK_PATH" ]; then state=held; else state=free; fi\nprintf "rip\\t%s\\n" "$state" >> "$WS_LOCK_EVENTS"\nexec "$WS_REAL_RIP" "$@"\n',
    );
    await Promise.all([
      chmod(join(f.root, "bin", "jj"), 0o755),
      chmod(join(f.root, "bin", "rip"), 0o755),
    ]);
    await Bun.write(events, "");

    expectSuccess(
      await run(
        ["bun", WS, "rm", "lock-scope", "--repo", f.repo],
        f.repo,
        f.env,
      ),
      "agx ws rm lock-scope",
    );
    const rows = (await Bun.file(events).text())
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const forget = rows.find(
      (row) =>
        row[0] === "jj" && (row[1]?.includes("workspace forget") ?? false),
    );
    const listing = rows.find(
      (row) => row[0] === "jj" && (row[1]?.includes("workspace list") ?? false),
    );
    const rename = rows.find((row) => row[0] === "rip");
    expect(forget?.[2]).toBe("held");
    expect(listing?.[2]).toBe("free");
    expect(rename?.[1]).toBe("held");
    expect(existsSync(path)).toBe(false);
  });
});

test("gc usecase: U10 removes a workspace's mise trusted-config and tracked-config entries", async () => {
  await withFixture(async (f) => {
    const path = await addWorkspace(f, "mise-cleanup");
    const trusted = join(f.miseState, "trusted-configs");
    const tracked = join(f.miseState, "tracked-configs");
    await Promise.all([
      mkdir(trusted, { recursive: true }),
      mkdir(tracked, { recursive: true }),
    ]);
    await symlink(join(path, ".mise.toml"), join(tracked, "workspace-config"));
    await symlink(path, join(trusted, "workspace-root"));

    const removed = await run(
      ["bun", WS, "rm", "mise-cleanup", "--repo", f.repo],
      f.repo,
      f.env,
    );
    expectSuccess(removed, "agx ws rm mise-cleanup");
    expect(existsSync(path)).toBe(false);
    const [trackedEntries, trustedEntries] = await Promise.all([
      readdir(tracked),
      readdir(trusted),
    ]);
    expect(trackedEntries).toEqual([]);
    expect(trustedEntries).toEqual([]);
  });
});

test.todo("gc usecase: U11 judges and collects a worker store created by agx ws add --worker-store — owner agx-ws-collect-worker-stores-1026", async () => {
  await withFixture(async (f) => {
    const added = await run(
      ["bun", WS, "add", "worker-store", "--worker-store", "--repo", f.repo],
      f.repo,
      f.env,
    );
    expectSuccess(added, "agx ws add worker-store --worker-store");
    const path = join(f.workspaceRoot, "ws_worker-store");
    const dry = await gc(f, [
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(dry, "agx ws gc --dry-run worker-store");
    expect(
      ["removable", "empty", "landed"].includes(rowFor(dry, path)[2] ?? ""),
    ).toBe(true);
    const collected = await gc(f, [
      "--include-unrecorded",
      "--grace-minutes",
      "0",
    ]);
    expectSuccess(collected, "agx ws gc worker-store");
    expect(existsSync(path)).toBe(false);
  });
});
