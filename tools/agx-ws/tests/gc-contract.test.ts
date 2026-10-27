import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { untrackedContent } from "../src/workspace.ts";

setDefaultTimeout(180_000);

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
  };
  const initialized = await run([jj, "git", "init", repo], parent, baseEnv);
  expect(initialized.code, initialized.err).toBe(0);
  writeFileSync(join(repo, ".ws.toml"), config);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  await jjRun(["commit", "-m", "base"], repo, baseEnv);
  await jjRun(["bookmark", "create", "main", "-r", "@-"], repo, baseEnv);
  const workspaces: string[] = [];
  for (let index = 1; index <= workspaceCount; index++) {
    const name = `ws_${index}`;
    const dir = join(repo, "..", "project.ws", name);
    mkdirSync(join(repo, "..", "project.ws"), { recursive: true });
    const added = await run(
      [jj, "workspace", "add", "--name", name, "-r", "main", dir],
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
      "--json",
      "--repo",
      f.repo,
      ...extra,
    ],
    f.repo,
    env,
  );
}

async function wsCommand(f: Fixture, args: string[]) {
  return run(["bun", wsCli, ...args, "--repo", f.repo], f.repo, f.baseEnv);
}

function addJjCounter(f: Fixture) {
  const trace = join(f.parent, "jj-calls.jsonl");
  const wrapper = join(f.bin, "jj");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.GC_CALLS_FILE ?? ${JSON.stringify(trace)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}) + "\\n");\nconst child = Bun.spawn([${JSON.stringify(jj)}, ...process.argv.slice(2)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });\nprocess.exitCode = await child.exited;\n`,
  );
  chmodSync(wrapper, 0o755);
  return trace;
}

function parseOutput(output: string) {
  const parsed = jsonOf(RunOutput).safeParse(output);
  expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  return parsed.success ? parsed.data : undefined;
}

test("gc contract: dry-run jj call count is constant from 5 to 50 workspaces", async () => {
  const five = await fixture(5);
  const fifty = await fixture(50);
  const counts: number[] = [];
  for (const f of [five, fifty]) {
    const trace = addJjCounter(f);
    const result = await gc(f, [], trace);
    expect(result.code, `${result.err}\n${result.out}`).toBe(0);
    const parsed = parseOutput(result.out);
    expect(parsed?.complete).toBe(true);
    const callLog = (await Bun.file(trace).text())
      .trim()
      .split("\n")
      .filter(Boolean);
    counts.push(callLog.length);
  }
  console.log(`gc contract: jj calls 5=${counts[0]} 50=${counts[1]}`);
  expect(counts[0]).toBe(counts[1]);
});

test("gc contract: two missing workspace directories remain broken rows", async () => {
  const f = await fixture(4);
  for (const dir of f.workspaces.slice(0, 2))
    rmSync(dir, { recursive: true, force: true });
  const result = await gc(f);
  expect([0, 1]).toContain(result.code);
  const parsed = parseOutput(result.out);
  expect(parsed?.rows).toHaveLength(5);
  expect(parsed?.rows.filter((row) => row[2] === "broken")).toHaveLength(2);
  expect(
    parsed?.rows.filter((row) => row[1] === "main" && row[2] === "keep"),
  ).toHaveLength(1);
  expect(parsed?.complete).toBe(false);
});

test("gc contract: remote-bookmarked work is removable and an unpushed change is named", async () => {
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

test("gc contract: lock is available while a large tombstone is still being deleted", async () => {
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
    `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(entered)}, "entered");\nconst deadline = performance.now() + 20_000;\nwhile (!(await Bun.file(${JSON.stringify(release)}).exists()) && performance.now() < deadline) await Bun.sleep(10);\nif (!(await Bun.file(${JSON.stringify(release)}).exists())) process.exitCode = 9;\n`,
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
  const enteredDeadline = performance.now() + 10_000;
  while (
    !(await Bun.file(entered).exists()) &&
    performance.now() < enteredDeadline
  )
    await Bun.sleep(20);
  const deletionStarted = await Bun.file(entered).exists();
  let addWasGranted = false;
  let addResult: Awaited<ReturnType<typeof wsCommand>> | undefined;
  if (deletionStarted) {
    const add = wsCommand(f, ["add", "lock-probe"]);
    const completed = await Promise.race([
      add,
      Bun.sleep(5_000).then(() => null),
    ]);
    addWasGranted = completed !== null;
    if (completed !== null) addResult = completed;
    else addResult = await add;
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

test("gc contract: declared regenerable path prunes a large node_modules subtree", async () => {
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
    10_000,
    [],
    new Set(["tracked.txt", ".ws.toml"]),
  );
  expect(inventory.ok).toBe(true);
  if (!inventory.ok) return;
  expect(inventory.value.count).toBe(0);
  expect(inventory.value.entries).toBe(rootEntries + generatedParentEntries);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
