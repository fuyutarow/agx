import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { untrackedContent } from "../src/workspace.ts";

const scratch = mkdtempSync(join(tmpdir(), "agx-ws-gc-contract-"));
const wsCli = process.env.GC_WS_CLI ?? join(import.meta.dir, "../src/ws.ts");
const jj = Bun.which("jj") ?? "jj";
let repoCount = 0;

const RunOutput = z.object({
  rows: z.array(z.array(z.string())),
  counts: z.object({ total: z.number(), collectable: z.number() }),
  complete: z.boolean(),
});

type Fixture = {
  repo: string;
  parent: string;
  workspaces: string[];
  bin: string;
  baseEnv: Record<string, string | undefined>;
};

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
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

async function jjRun(args: string[], cwd: string, env: Fixture["baseEnv"]) {
  const result = await run([jj ?? "jj", ...args], cwd, env);
  expect(result.code, `${args.join(" ")}: ${result.err}`).toBe(0);
  return result;
}

async function fixture(
  workspaceCount: number,
  config = 'trunk = "main"\n',
): Promise<Fixture> {
  const parent = join(scratch, `repo-${++repoCount}`);
  const repo = join(parent, "project");
  const bin = join(parent, "bin");
  const home = join(parent, "home");
  const state = join(parent, "state");
  const graveyard = join(parent, "graveyard");
  mkdirSync(parent, { recursive: true });
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(join(home, ".config", "jj", "repos"), { recursive: true });
  writeFileSync(
    join(home, ".config", "jj", "config.toml"),
    '[revset-aliases]\n"trunk()" = "bookmarks(main)"\n',
  );
  const statShim = join(bin, "stat");
  writeFileSync(statShim, "#!/bin/sh\nprintf 'ext4\\n'\n");
  chmodSync(statShim, 0o755);
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_STATE_HOME: state,
    AGX_STATE_DIR: join(state, "agx"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    RIP_GRAVEYARD: graveyard,
    GRAVEYARD: graveyard,
    JJ_USER: "gc contract",
    JJ_EMAIL: "gc-contract@example.test",
    WS_ADD_TIMEOUT_MS: "4000",
    AGX_WS_TEST_LOCK_WAIT_MS: "100",
    AGX_WS_TEST_LOCK_POLL_MS: "1",
    AGX_WS_TEST_STEP_TIMEOUT_MS: "4000",
    AGX_WS_TEST_DRAIN_GRACE_MS: "1",
  };
  const initialized = await run([jj, "git", "init", repo], parent, baseEnv);
  expect(initialized.code, initialized.err).toBe(0);
  await jjRun(
    ["config", "set", "--repo", 'revset-aliases."trunk()"', "bookmarks(main)"],
    repo,
    baseEnv,
  );
  writeFileSync(join(repo, "agx.toml"), `schema = 1\n[ws]\n${config}`);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  await jjRun(["commit", "-m", "base"], repo, baseEnv);
  await jjRun(["bookmark", "create", "main", "-r", "@-"], repo, baseEnv);
  const workspaces: string[] = [];
  for (let index = 1; index <= workspaceCount; index++) {
    const name = `ws_${index}`;
    const dir = join(repo, "..", "project.ws", name);
    mkdirSync(join(repo, "..", "project.ws"), { recursive: true });
    const added = await run(
      [
        jj,
        "workspace",
        "add",
        "--name",
        name,
        "-r",
        "main",
        "--no-colocate",
        dir,
      ],
      repo,
      baseEnv,
    );
    expect(added.code, added.err).toBe(0);
    workspaces.push(dir);
  }
  const agx = join(bin, "agx");
  writeFileSync(agx, "#!/bin/sh\nprintf '%s\\n' '[]'\n");
  chmodSync(agx, 0o755);
  return { repo, parent, workspaces, bin, baseEnv };
}

async function addWorkspaces(f: Fixture, from: number, through: number) {
  const workspaceRoot = join(f.repo, "..", "project.ws");
  mkdirSync(workspaceRoot, { recursive: true });
  for (let index = from; index <= through; index++) {
    const name = `ws_${index}`;
    const dir = join(workspaceRoot, name);
    const added = await run(
      [
        jj,
        "workspace",
        "add",
        "--name",
        name,
        "-r",
        "main",
        "--no-colocate",
        dir,
      ],
      f.repo,
      f.baseEnv,
    );
    expect(added.code, added.err).toBe(0);
    f.workspaces.push(dir);
  }
}

async function gc(f: Fixture, extra: string[] = [], trace?: string) {
  const env = {
    ...f.baseEnv,
    ...(trace === undefined ? {} : { GC_CALLS_FILE: trace }),
  };
  return run(
    [
      "bun",
      wsCli,
      "gc",
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
      "--inventory-seconds",
      "1",
      "--json",
      "--repo",
      f.repo,
      ...extra,
    ],
    f.repo,
    env,
  );
}

test("ws contract: gc --all reports each repository on stderr as it goes", async () => {
  const first = await fixture(1);
  const second = await fixture(1);
  await jjRun(["workspace", "root"], second.repo, first.baseEnv);
  const records = [first, second].map((f, index) => ({
    id: `record-${index}`,
    state: "ended",
    cwd: f.repo,
    workspace: f.workspaces[0],
  }));
  writeFileSync(
    join(first.bin, "agx"),
    `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(records)}\nEOF\n`,
  );
  for (const format of [[], ["--json"]]) {
    const result = await run(
      [
        "bun",
        wsCli,
        "gc",
        "--all",
        "--dry-run",
        "--include-unrecorded",
        "--grace-minutes",
        "0",
        ...format,
      ],
      first.repo,
      first.baseEnv,
    );
    expect(result.code, result.err + result.out).toBe(0);
    const progress = result.err
      .split("\n")
      .filter((line) => line.startsWith("gc --all "));
    expect(progress).toHaveLength(4);
    for (const [index, repo] of [first.repo, second.repo]
      .toSorted()
      .entries()) {
      expect(progress[index * 2]).toBe(`gc --all start ${repo}`);
      expect(progress[index * 2 + 1]).toMatch(
        new RegExp(`^gc --all end .* elapsed=\\d+\\.\\d{3}s rows=\\d+$`, "u"),
      );
      expect(progress[index * 2 + 1]).toContain(`end ${repo} `);
    }
    expect(result.out).not.toContain("gc --all ");
    if (format.length > 0) {
      const parsed = jsonOf(
        z.object({ repositories: z.array(z.unknown()) }),
      ).safeParse(result.out);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.repositories).toHaveLength(2);
    }
  }
});

async function addLandWorkspace(f: Fixture) {
  const stateRoot = f.baseEnv.AGX_STATE_DIR;
  expect(stateRoot).toBeDefined();

  const name = `land_${repoCount}`;
  const state = join(stateRoot ?? "", "land", `fixture-${repoCount}`);
  const dir = join(state, "workspace");
  mkdirSync(state, { recursive: true });
  const added = await run(
    [
      jj,
      "workspace",
      "add",
      "--name",
      name,
      "-r",
      "main",
      "--no-colocate",
      dir,
    ],
    f.repo,
    f.baseEnv,
  );
  expect(added.code, added.err).toBe(0);
  return { name, state, dir };
}

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

async function wsCommand(f: Fixture, args: string[]) {
  return run(["bun", wsCli, ...args, "--repo", f.repo], f.repo, f.baseEnv);
}

function addJjCounter(f: Fixture) {
  const trace = join(f.parent, "jj-calls.jsonl");
  const wrapper = join(f.bin, "jj");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst rootProbe = args.includes("workspace") && args.includes("root") && args.includes("default");\nconst policyFileRead = args.includes("file") && (args.includes("list") || args.includes("show")) && (args.includes("agx.toml") || args.includes(".agx.toml"));\nconst sharedConfigRead = process.cwd() === ${JSON.stringify(f.repo)} && args.includes("--at-operation=@") && (rootProbe || policyFileRead);\nif (!sharedConfigRead) { try { appendFileSync(process.env.GC_CALLS_FILE ?? ${JSON.stringify(trace)}, JSON.stringify({cwd:process.cwd(),args}) + "\\n"); } catch (error) { process.stderr.write(String(error) + "\\n"); } }\nconst child = Bun.spawn([${JSON.stringify(jj)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });\nprocess.exitCode = await child.exited;\n`,
  );
  chmodSync(wrapper, 0o755);
  return trace;
}

function parseOutput(output: string) {
  const parsed = jsonOf(RunOutput).safeParse(output);
  expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  return parsed.success ? parsed.data : undefined;
}

test("gc usecase: a change landed as a copy is removable", async () => {
  const f = await fixture(1);
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;

  writeFileSync(join(workspace, "copied.txt"), "copied work\n");
  await jjRun(["commit", "-m", "workspace copy"], workspace, f.baseEnv);
  writeFileSync(join(f.repo, "copied.txt"), "copied work\n");
  await jjRun(["commit", "-m", "same change on trunk"], f.repo, f.baseEnv);
  await jjRun(["bookmark", "set", "main", "-r", "@-"], f.repo, f.baseEnv);

  const trunk = (
    await jjRun(
      ["log", "--no-graph", "-r", "main", "-T", "commit_id"],
      f.repo,
      f.baseEnv,
    )
  ).out.trim();
  const result = await gc(f);
  expect(result.code, `${result.err}\n${result.out}`).toBe(0);
  const row = parseOutput(result.out)?.rows.find(
    (candidate) => candidate[0] === workspace,
  );
  expect(row?.[2]).toBe("removable");
  expect(row?.[5]).toContain(`landed by content on ${trunk}`);
});

test("gc usecase: a change landed as a copy is removable by rm", async () => {
  const f = await fixture(1);
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;

  writeFileSync(join(workspace, "copied.txt"), "copied work\n");
  await jjRun(["commit", "-m", "workspace copy"], workspace, f.baseEnv);
  writeFileSync(join(f.repo, "copied.txt"), "copied work\n");
  await jjRun(["commit", "-m", "same change on trunk"], f.repo, f.baseEnv);
  await jjRun(["bookmark", "set", "main", "-r", "@-"], f.repo, f.baseEnv);

  const result = await wsCommand(f, ["rm", "1"]);
  expect(result.code, `${result.err}\n${result.out}`).toBe(0);
  expect(result.out).toContain("removed");
  expect(existsSync(workspace)).toBe(false);
});

test("gc usecase: a change not on trunk stays kept", async () => {
  const f = await fixture(1);
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;

  writeFileSync(join(workspace, "unlanded.txt"), "unlanded work\n");
  await jjRun(["commit", "-m", "unpublished payload"], workspace, f.baseEnv);

  const result = await gc(f);
  expect(result.code, `${result.err}\n${result.out}`).toBe(0);
  const row = parseOutput(result.out)?.rows.find(
    (candidate) => candidate[0] === workspace,
  );
  expect(row?.[2]).toBe("keep");
  expect(row?.[5]).toContain("unlanded change");
  expect(row?.[5]).toContain("unpublished payload");
});

// Shared config's fixed read-only root probes are excluded; this measures GC inventory work.
test("gc contract: dry-run jj call count is constant from 5 to 50 workspaces", async () => {
  const five = await fixture(5);
  const counts: number[] = [];
  const trace = addJjCounter(five);
  const first = await gc(five, [], trace);
  expect(first.code, `${first.err}\n${first.out}`).toBe(0);
  expect(parseOutput(first.out)?.complete).toBe(true);
  counts.push(
    (await Bun.file(trace).text()).trim().split("\n").filter(Boolean).length,
  );
  rmSync(trace, { force: true });
  await addWorkspaces(five, 6, 50);
  addJjCounter(five);
  const second = await gc(five, [], trace);
  expect(second.code, `${second.err}\n${second.out}`).toBe(0);
  expect(parseOutput(second.out)?.complete).toBe(true);
  counts.push(
    (await Bun.file(trace).text()).trim().split("\n").filter(Boolean).length,
  );
  console.log(`gc contract: jj calls 5=${counts[0]} 50=${counts[1]}`);
  expect(counts[0]).toBe(counts[1]);
});

test.concurrent("gc usecase: an idle land workspace is collected, not broken", async () => {
  const f = await fixture(0);
  const land = await addLandWorkspace(f);
  expect(land).toBeDefined();
  if (land === undefined) return;

  rmSync(land.dir, { recursive: true, force: true });
  const dryRun = await gc(f);
  expect(dryRun.code, `${dryRun.err}\n${dryRun.out}`).toBe(0);
  const row = parseOutput(dryRun.out)?.rows.find(
    (candidate) => candidate[0] === land.dir,
  );
  expect(row?.[1]).toBe("land");
  expect(row?.[2]).toBe("removable");

  const collected = await wsCommand(f, [
    "gc",
    "--include-unrecorded",
    "--grace-minutes",
    "0",
    "--inventory-seconds",
    "1",
  ]);
  expect(collected.code, `${collected.err}\n${collected.out}`).toBe(0);
  const remaining = await jjRun(["workspace", "list"], f.repo, f.baseEnv);
  expect(remaining.out).not.toContain(land.name);
});

test.concurrent("gc usecase: a broken user workspace still fails the dry-run", async () => {
  const f = await fixture(4);
  for (const dir of f.workspaces.slice(0, 2))
    rmSync(dir, { recursive: true, force: true });
  const result = await gc(f);
  expect(result.code, `${result.err}\n${result.out}`).toBe(1);
  const parsed = parseOutput(result.out);
  expect(parsed?.rows).toHaveLength(5);
  expect(parsed?.rows.filter((row) => row[2] === "broken")).toHaveLength(2);
  expect(
    parsed?.rows.filter((row) => row[1] === "main" && row[2] === "keep"),
  ).toHaveLength(1);
  expect(parsed?.complete).toBe(false);
});

test.concurrent("gc contract: remote-bookmarked work is removable and an unpushed change is named", async () => {
  const f = await fixture(2);
  const bare = join(f.parent, "origin.git");
  const remote = await run(
    ["git", "init", "--bare", bare],
    f.parent,
    f.baseEnv,
  );
  expect(remote.code, remote.err).toBe(0);
  await jjRun(["git", "remote", "add", "origin", bare], f.repo, f.baseEnv);

  const [pushedDir, unpushedDir] = f.workspaces;
  expect(pushedDir).toBeDefined();
  expect(unpushedDir).toBeDefined();
  if (pushedDir === undefined || unpushedDir === undefined) return;
  writeFileSync(join(pushedDir, "pushed.txt"), "pushed\n");
  await jjRun(["commit", "-m", "pushed payload"], pushedDir, f.baseEnv);
  await jjRun(
    ["bookmark", "create", "pushed-only", "-r", "@-"],
    pushedDir,
    f.baseEnv,
  );
  await jjRun(
    ["git", "push", "--remote", "origin", "--bookmark", "pushed-only"],
    pushedDir,
    f.baseEnv,
  );

  writeFileSync(join(unpushedDir, "unpushed.txt"), "not pushed\n");
  await jjRun(["commit", "-m", "unpublished payload"], unpushedDir, f.baseEnv);
  const result = await gc(f);
  expect(result.code, result.err).toBe(0);
  const parsed = parseOutput(result.out);
  const pushed = parsed?.rows.find((row) => row[0] === pushedDir);
  const unpushed = parsed?.rows.find((row) => row[0] === unpushedDir);
  expect(pushed?.[2]).toBe("removable");
  expect(unpushed?.[2]).toBe("keep");
  expect(unpushed?.[5]).toContain("unpublished payload");
});

test.concurrent("gc contract: lock is available while a large tombstone is still being deleted", async () => {
  const f = await fixture(1, 'trunk = "main"\nregenerable = ["build"]\n');
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;
  const tree = join(workspace, "build", "node_modules");
  mkdirSync(tree, { recursive: true });
  for (let index = 0; index < 1_500; index++)
    writeFileSync(join(tree, `file-${index}.js`), "export {}\n");

  const entered = join(f.parent, "rip-entered");
  const release = join(f.parent, "allow-rip");
  const rip = join(f.bin, "rip");
  writeFileSync(
    rip,
    `#!/usr/bin/env bun\nimport { existsSync, watch } from "node:fs";\nimport { dirname } from "node:path";\nconst release = ${JSON.stringify(release)};\nawait Bun.write(${JSON.stringify(entered)}, "entered");\nawait new Promise((resolve) => {\n  const watcher = watch(dirname(release), () => {\n    if (!existsSync(release)) return;\n    watcher.close();\n    resolve();\n  });\n  if (existsSync(release)) {\n    watcher.close();\n    resolve();\n  }\n});\n`,
  );
  chmodSync(rip, 0o755);

  const child = Bun.spawn(
    [
      "bun",
      wsCli,
      "gc",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
      "--inventory-seconds",
      "1",
      "--repo",
      f.repo,
    ],
    {
      cwd: f.repo,
      env: f.baseEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const outPromise = new Response(child.stdout).text();
  const errPromise = new Response(child.stderr).text();
  const exitPromise = child.exited;
  await waitForFile(entered);
  const deletionStarted = existsSync(entered);
  let addWasGranted = false;
  let addResult: Awaited<ReturnType<typeof wsCommand>> | undefined;
  if (deletionStarted) {
    addResult = await wsCommand(f, ["add", "lock-probe"]);
    addWasGranted = true;
  }
  await Bun.write(release, "release");
  const [out, err, code] = await Promise.all([
    outPromise,
    errPromise,
    exitPromise,
  ]);
  expect(deletionStarted, err).toBe(true);
  expect(
    addWasGranted,
    `add result: ${addResult?.err ?? "still waiting"}`,
  ).toBe(true);
  expect(addResult?.code, addResult?.err).toBe(0);
  expect(code, err).toBe(0);
  expect(out).toContain("removable");
});

test.concurrent("gc contract: declared regenerable path prunes a large node_modules subtree", async () => {
  const f = await fixture(
    1,
    'trunk = "main"\nregenerable = ["build/generated"]\n',
  );
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;
  const generated = join(workspace, "build", "generated");
  const modules = join(generated, "node_modules");
  mkdirSync(modules, { recursive: true });
  for (let index = 0; index < 2_000; index++)
    writeFileSync(join(modules, `file-${index}.js`), "export {}\n");

  const rootEntries = readdirSync(workspace).length;
  const generatedParentEntries = readdirSync(join(workspace, "build")).length;
  const inventory = await untrackedContent(
    workspace,
    ["build/generated"],
    1_000,
    [],
    new Set(["tracked.txt", "agx.toml"]),
  );
  expect(inventory.ok).toBe(true);
  if (!inventory.ok) return;
  expect(inventory.value.count).toBe(0);
  expect(inventory.value.entries).toBe(rootEntries + generatedParentEntries);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
