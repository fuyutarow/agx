import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import {
  gc as collectWorkspaces,
  gcCounts,
  parseWorkspaceList,
  untrackedContent,
} from "../src/workspace.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
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
  initialCommit = true,
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
    ...subprocessEnvironment(),
    GC_CALLS_FILE: undefined,
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
  writeFileSync(join(repo, "agx.toml"), `schema = 1\n[ws]\n${config}`);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  if (initialCommit) await jjRun(["commit", "-m", "base"], repo, baseEnv);
  await jjRun(["bookmark", "create", "main", "-r", initialCommit ? "@-" : "@"], repo, baseEnv);
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

async function journalRun(interrupt: boolean) {
  const f = await fixture(2);
  const entered = join(f.parent, "rip-entered");
  const release = join(f.parent, "rip-release");
  const rip = join(f.bin, "rip");
  writeFileSync(rip, `#!/usr/bin/env bun\nimport { existsSync, watch } from "node:fs";\nimport { dirname } from "node:path";\nconst release = ${JSON.stringify(release)};\nawait Bun.write(${JSON.stringify(entered)}, "entered");\nawait new Promise((resolve) => { const w = watch(dirname(release), () => { if (existsSync(release)) { w.close(); resolve(); } }); if (existsSync(release)) { w.close(); resolve(); } });\n`);
  chmodSync(rip, 0o755);
  const child = Bun.spawn(["bun", wsCli, "gc", "--include-unrecorded", "--grace-minutes", "0", "--json", "--repo", f.repo], { cwd: f.repo, env: f.baseEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const outPromise = new Response(child.stdout).text();
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let err = "";
  while (!err.includes("gc removed ")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    err += decoder.decode(chunk.value, { stream: true });
  }
  const beforeRelease = err;
  if (interrupt) child.kill("SIGTERM");
  await Bun.write(release, "release");
  const errPromise = (async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) break; err += decoder.decode(chunk.value, { stream: true }); } return err; })();
  const [out, stderr, code] = await Promise.all([outPromise, errPromise, child.exited]);
  return { f, beforeRelease, out, err: stderr, code };
}

test("ws contract: a real gc prints each removal as it happens", async () => {
  const result = await journalRun(false);
  expect(result.code, result.err).toBe(0);
  expect(result.beforeRelease).toContain(`gc removed ${result.f.workspaces[0]} reason=`);
  expect(result.err.match(/^gc removed /gmu)).toHaveLength(2);
});

test("ws contract: gc removed count equals its removal lines on every removal path", async () => {
  const f = await fixture(2);
  const land = await addLandWorkspace(f);
  expect(land).toBeDefined();
  if (land === undefined) return;
  rmSync(land.dir, { recursive: true, force: true });
  const missing = f.workspaces[1];
  expect(missing).toBeDefined();
  if (missing === undefined) return;
  rmSync(missing, { recursive: true, force: true });
  const args = ["bun", wsCli, "gc", "--include-unrecorded", "--grace-minutes", "0", "--json", "--repo", f.repo];
  const result = await run(args, f.repo, f.baseEnv);
  const schema = jsonOf(z.object({ counts: z.object({ removed: z.number() }) }));
  const parsed = schema.safeParse(result.out);
  expect(parsed.success, result.err).toBe(true);
  const removalLines = result.err.split("\n").filter((line) => line.startsWith("gc removed "));
  expect(removalLines).toHaveLength(2);
  expect(removalLines.some((line) => line.startsWith(`gc removed ${f.workspaces[0]} reason=`))).toBe(true);
  expect(removalLines.some((line) => line.startsWith(`gc removed ${land.dir} reason=`))).toBe(true);
  expect(removalLines.some((line) => line.startsWith(`gc removed ${missing} reason=`))).toBe(false);
  if (parsed.success) expect(parsed.data.counts.removed).toBe(removalLines.length);

  const failed = await fixture(1);
  const rip = join(failed.bin, "rip");
  writeFileSync(rip, "#!/bin/sh\nexit 1\n");
  chmodSync(rip, 0o755);
  const cleanup = await run(["bun", wsCli, "gc", "--include-unrecorded", "--grace-minutes", "0", "--json", "--repo", failed.repo], failed.repo, failed.baseEnv);
  const cleanupParsed = schema.safeParse(cleanup.out);
  expect(cleanupParsed.success, cleanup.err).toBe(true);
  const cleanupLines = cleanup.err.split("\n").filter((line) => line.startsWith("gc removed "));
  expect(cleanupLines).toHaveLength(1);
  expect(cleanup.out).toContain("tombstone cleanup failed");
  if (cleanupParsed.success) expect(cleanupParsed.data.counts.removed).toBe(cleanupLines.length);
});

test("ws contract: gc on SIGTERM prints what it removed and exits 143", async () => {
  const result = await journalRun(true);
  expect(result.code, result.err).toBe(143);
  expect(result.err).toContain(`gc removed ${result.f.workspaces[0]} reason=`);
  expect(result.err).toContain("gc interrupted removed=1 remaining=1");
  expect(existsSync(result.f.workspaces[1] ?? "")).toBe(true);
  expect(parseOutput(result.out)?.rows.some((row) => row[0] === result.f.workspaces[0])).toBe(true);
});

test("ws contract: progress lines reach a piped stderr before gc ends", async () => {
  const f = await fixture(1);
  const repos = join(f.baseEnv.XDG_CONFIG_HOME ?? "", "agx", "repos");
  mkdirSync(repos, { recursive: true });
  writeFileSync(join(repos, "test.toml"), `schema = 1\nroot = ${JSON.stringify(f.repo)}\n`);
  const child = Bun.spawn(["bun", wsCli, "gc", "--all", "--json"], {
    cwd: f.repo, env: f.baseEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  const stdout = child.stdout.text();
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let stderr = "";
  while (!stderr.includes(`gc --all start ${f.repo}\n`)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stderr += decoder.decode(chunk.value, { stream: true });
  }
  expect(stderr).toContain(`gc --all start ${f.repo}\n`);
  expect(child.exitCode).toBeNull();
  child.kill("SIGTERM");
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stderr += decoder.decode(chunk.value, { stream: true });
  }
  const [out, code] = await Promise.all([stdout, child.exited]);
  expect(code, stderr).toBe(143);
  expect(stderr).toContain("gc interrupted removed=");
  expect(parseOutput(out)).toBeDefined();
});

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

test.each([{ format: [] }, { format: ["--json"] }])("ws contract: gc --all reports each repository on stderr as it goes %j", async ({ format }) => {
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
  {
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

test("ws contract: gc trace reports each step on stderr only when asked", async () => {
  const f = await fixture(1);
  delete f.baseEnv.AGX_WS_GC_TRACE;
  const normal = await gc(f);
  f.baseEnv.AGX_WS_GC_TRACE = "1";
  const traced = await gc(f);
  expect(normal.code).toBe(0);
  expect(traced.code).toBe(0);
  const normalReport = parseOutput(normal.out);
  const tracedReport = parseOutput(traced.out);
  expect(
    tracedReport?.rows.map((row) => row.filter((_, index) => index !== 4)),
  ).toEqual(
    normalReport?.rows.map((row) => row.filter((_, index) => index !== 4)),
  );
  expect(tracedReport?.counts).toEqual(normalReport?.counts);
  expect(tracedReport?.complete).toBe(normalReport?.complete);
  expect(normal.err).toBe("");
  const lines = traced.err.trim().split("\n");
  const steps = [
    "workspace list",
    "run records",
    "aggregate jj graph generation",
    "graph parsing",
    "per-workspace classification",
    "untracked inventory",
    "comparison",
  ];
  const progress = lines.splice(4, 1)[0];
  expect(progress).toMatch(
    /^gc trace: cumulative: workspaces=\d+\/\d+ classification=\d+\.\d{3} ms inventory=\d+\.\d{3} ms count=\d+ comparison=\d+\.\d{3} ms removal=\d+\.\d{3} ms slowest=".*" ms=\d+\.\d{3} step=(classification|inventory|comparison)$/u,
  );
  expect(lines).toHaveLength(steps.length);
  for (const [index, step] of steps.entries()) {
    expect(lines[index]).toMatch(
      new RegExp(
        "^gc trace: " +
          step +
          ": [0-9]+\\.[0-9]{3} ms" +
          (step === "per-workspace classification" ||
          step === "untracked inventory"
            ? " count=[0-9]+"
            : "") +
          "$",
        "u",
      ),
    );
  }
});

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

test("ws contract: gc and rm agree on a landed copy with ignored node_modules", async () => {
  const f = await fixture(1);
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;
  writeFileSync(join(workspace, ".gitignore"), "node_modules/\n");
  writeFileSync(join(workspace, "copied.txt"), "copied work\n");
  await jjRun(["commit", "-m", "workspace copy"], workspace, f.baseEnv);
  writeFileSync(join(f.repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(f.repo, "copied.txt"), "copied work\n");
  await jjRun(["commit", "-m", "same change on trunk"], f.repo, f.baseEnv);
  await jjRun(["bookmark", "set", "main", "-r", "@-"], f.repo, f.baseEnv);
  mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
  writeFileSync(
    join(workspace, "node_modules", "pkg", "index.js"),
    "generated\n",
  );
  const dry = await gc(f);
  expect(
    parseOutput(dry.out)?.rows.find((row) => row[0] === workspace)?.[2],
  ).toBe("removable");
  const removed = await wsCommand(f, ["rm", "1"]);
  expect(removed.code, removed.err).toBe(0);
  expect(existsSync(workspace)).toBe(false);
});

test("ws contract: untracked inventory ignores ignored and regenerable paths but keeps a real untracked file", async () => {
  const f = await fixture(1, 'trunk = "main"\nregenerable = ["generated/"]\n');
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;
  writeFileSync(join(workspace, ".gitignore"), "node_modules/\n");
  await jjRun(["commit", "-m", "ignore"], workspace, f.baseEnv);
  await jjRun(["bookmark", "set", "main", "-r", "@-"], workspace, f.baseEnv);
  mkdirSync(join(workspace, "node_modules"));
  mkdirSync(join(workspace, "generated"));
  writeFileSync(join(workspace, "node_modules", "ignored"), "ignored");
  writeFileSync(join(workspace, "generated", "rebuild"), "generated");
  writeFileSync(join(workspace, "real.txt"), "keep");
  const inventory = await untrackedContent(workspace, ["generated/"]);
  expect(inventory.ok).toBe(true);
  if (!inventory.ok) return;
  expect(inventory.value.count).toBe(1);
  expect(inventory.value.paths).toEqual(["real.txt"]);
  const dry = await gc(f);
  expect(
    parseOutput(dry.out)?.rows.find((row) => row[0] === workspace)?.[2],
  ).toBe("keep");
  const removed = await wsCommand(f, ["rm", "1"]);
  expect(removed.code).not.toBe(0);
  expect(existsSync(join(workspace, "real.txt"))).toBe(true);
});

test("ws contract: untracked inventory makes one VCS listing call per workspace", async () => {
  const f = await fixture(1);
  const workspace = f.workspaces[0];
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;
  mkdirSync(join(workspace, "one", "two"), { recursive: true });
  writeFileSync(join(workspace, "one", "two", "real.txt"), "keep");
  const wrapper = join(f.parent, "inventory.ts");
  writeFileSync(
    wrapper,
    `
import { untrackedContent } from ${JSON.stringify(join(import.meta.dir, "../src/workspace.ts"))};
const original = Bun.spawn;
const commands = [];
Bun.spawn = (...args) => { commands.push(args[0]); return original(...args); };
const result = await untrackedContent(${JSON.stringify(workspace)}, [], 10000, [], new Set(["tracked.txt", "agx.toml"]));
console.log(JSON.stringify({ result, commands }));
`,
  );
  const result = await run(["bun", wrapper], workspace, f.baseEnv);
  expect(result.code, result.err).toBe(0);
  const parsed = jsonOf(
    z.object({
      result: z.object({
        ok: z.literal(true),
        value: z.object({ paths: z.array(z.string()) }),
      }),
      commands: z.array(z.array(z.string())),
    }),
  ).safeParse(result.out);
  expect(parsed.success, result.out).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.result.value.paths).toContain("one/two/real.txt");
  expect(parsed.data.commands).toHaveLength(1);
  expect(parsed.data.commands[0]).toContain("ls-files");
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
describe("gc call count fixture", () => {
  let five: Fixture;
  let trace: string;
  let firstCount: number;
  beforeAll(async () => {
    five = await fixture(5);
    trace = addJjCounter(five);
    const first = await gc(five, [], trace);
    expect(first.code, `${first.err}\n${first.out}`).toBe(0);
    expect(parseOutput(first.out)?.complete).toBe(true);
    firstCount = (await Bun.file(trace).text()).trim().split("\n").filter(Boolean).length;
    rmSync(trace, { force: true });
  });
  function stageWorkspaces(from: number) {
    beforeAll(async () => {
      await addWorkspaces(five, from, Math.min(from + 8, 50));
    });
  }
  for (let from = 6; from <= 50; from += 9) stageWorkspaces(from);
  test("gc contract: dry-run jj call count is constant from 5 to 50 workspaces", async () => {
    const second = await gc(five, [], trace);
    expect(second.code, `${second.err}\n${second.out}`).toBe(0);
    expect(parseOutput(second.out)?.complete).toBe(true);
    const secondCount = (await Bun.file(trace).text()).trim().split("\n").filter(Boolean).length;
    console.log(`gc contract: jj calls 5=${firstCount} 50=${secondCount}`);
    expect(firstCount).toBe(secondCount);
  });
});

test("gc usecase: an idle land workspace is collected, not broken", async () => {
  const f = await fixture(0, undefined, false);
  const land = await addLandWorkspace(f);
  expect(land).toBeDefined();
  if (land === undefined) return;

  rmSync(land.dir, { recursive: true, force: true });
  const collected = await collectWorkspaces({
    repo: f.repo, dryRun: false, includeUnrecorded: true,
    graceMinutes: 0, inventorySeconds: 1, env: f.baseEnv,
  });
  expect(collected.ok, collected.ok ? "" : String(collected.error)).toBe(true);
  if (!collected.ok) return;
  const row = collected.value.lines.map((line) => line.split("\t"))
    .find((candidate) => candidate[0] === land.dir);
  expect(row?.[1]).toBe("land");
  expect(row?.[2], row?.join("\t")).toBe("collected");
});

test("gc usecase: a broken user workspace still fails the dry-run", async () => {
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

test("ws contract: gc inventory budget keeps unexamined workspaces and reports incomplete", async () => {
  const f = await fixture(3);
  for (const workspace of f.workspaces)
    writeFileSync(join(workspace, "untracked.txt"), "keep\n");
  const wrapper = join(f.parent, "clock.ts");
  writeFileSync(
    wrapper,
    `
const now = performance.now.bind(performance);
let inventoryClockCalls = 0;
Object.defineProperty(performance, "now", { value: () => {
  const stack = new Error().stack ?? "";
  if (stack.includes("classifyGc") && !stack.includes("untrackedContent")) {
    inventoryClockCalls++;
    return now() + (inventoryClockCalls >= 2 ? 1100 : 0);
  }
  return now();
}});
await import(${JSON.stringify(wsCli)});
`,
  );
  const result = await run(
    [
      "bun",
      wrapper,
      "gc",
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
      "--inventory-budget-seconds",
      "1",
      "--json",
      "--repo",
      f.repo,
    ],
    f.repo,
    f.baseEnv,
  );
  expect(result.code, result.err).toBe(0);
  const parsed = parseOutput(result.out);
  const rows =
    parsed?.rows.filter((row) => f.workspaces.includes(row[0] ?? "")) ?? [];
  expect(rows).toHaveLength(3);
  expect(
    rows.filter((row) => row[5]?.includes("untracked content") === true),
  ).toHaveLength(1);
  expect(
    rows.filter(
      (row) =>
        row[2] === "keep" &&
        row[5]?.includes("inventory budget exhausted") === true,
    ),
  ).toHaveLength(2);
  expect(parsed?.counts.collectable).toBe(0);
  expect(parsed?.complete).toBe(false);
});


test("ws contract: gc --json counts give every kept reason in the fixture its own key", () => {
  const reasons = [
    ["unrecorded", "unrecorded workspace; pass --include-unrecorded to collect"],
    ["unsnapshotted", "unsnapshotted working-copy changes: yes: bytes differ at README.md"],
    ["abandoned", "all runs ended without acceptance over 24h ago: abc; pass --abandoned to collect"],
    ["active_processes", "processes are working inside /workspace (pid 1)"],
    ["configured_keep", "declared in [ws].keep"],
  ] as const;
  const rows = reasons.map(([, reason]) => ["path", "ws", "keep", "", "", reason].join("\t"));
  rows.push(["path", "ws", "removable", "", "", "nothing unlanded; no untracked content"].join("\t"));
  const counts = gcCounts(rows).kept;
  for (const [key] of reasons) expect(counts[key]).toBe(1);
  expect(counts.removable).toBe(1);
  expect(counts.other).toBe(0);
});

test("ws contract: gc summary counts removed and kept by reason", async () => {
  const rows = [
    ["a", "ws", "removable", "", "", "nothing unlanded; removed"],
    ["b", "ws", "keep", "", "", "unlanded change abc"],
    ["c", "ws", "keep", "", "", "run abc is unjudged; keep"],
    ["d", "ws", "keep", "", "", "untracked content: 1 files"],
    ["e", "ws", "keep", "", "", "inventory budget exhausted"],
    ["f", "ws", "broken", "", "", "missing"],
    ["g", "ws", "keep", "", "", "protected"],
  ].map((row) => row.join("\t"));
  expect(gcCounts(rows)).toMatchObject({ removed: 1, kept: { unlanded: 1, unjudged_run: 1, untracked_content: 1, inventory_budget_exhausted: 1, broken: 1, other: 1 } });
  const f = await fixture(1);
  const result = await gc(f);
  expect(result.code, result.err).toBe(0);
  const parsed = jsonOf(z.object({ counts: z.object({ removed: z.number(), kept: z.object({ removable: z.number() }) }) })).safeParse(result.out);
  expect(result.err).toBe("");
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.counts.kept.removable + parsed.data.counts.removed).toBe(1);
  const repos = join(f.baseEnv.XDG_CONFIG_HOME ?? "", "agx", "repos");
  mkdirSync(repos, { recursive: true });
  writeFileSync(join(repos, "test.toml"), `schema = 1\nroot = ${JSON.stringify(f.repo)}\n`);
  const args = ["bun", wsCli, "gc", "--all", "--dry-run", "--include-unrecorded", "--grace-minutes", "0"];
  const all = await run([...args, "--json"], f.repo, f.baseEnv);
  expect(all.code, all.err).toBe(0);
  const counts = z.object({ removed: z.number(), kept: z.object({ unlanded: z.number(), unjudged_run: z.number(), untracked_content: z.number(), inventory_budget_exhausted: z.number(), broken: z.number(), removable: z.number(), other: z.number() }) });
  const allParsed = jsonOf(z.object({ counts, repositories: z.array(z.object({ root: z.string(), counts })) })).safeParse(all.out);
  expect(allParsed.success).toBe(true);
  if (allParsed.success) {
    const repo = allParsed.data.repositories.find((entry) => entry.root === f.repo);
    expect(repo?.counts).toEqual(allParsed.data.counts);
    expect(repo?.counts.kept.removable).toBe(1);
  }
  const plain = await run(args, f.repo, f.baseEnv);
  expect(plain.code, plain.err).toBe(0);
  const repoLine = plain.out.split("\n").find((line) => line.startsWith(`${f.repo}\trepo\t`));
  expect(repoLine?.split("\t")[4]).toMatch(/^\{"total":\d+,"unlanded":\d+,"collectable":\d+,"legacy":\d+\}$/u);
});

test("ws doctor inventories returned runs and warns by age", async () => {
  const f = await fixture(1);
  const repos = join(f.baseEnv.XDG_CONFIG_HOME ?? "", "agx", "repos");
  mkdirSync(repos, { recursive: true });
  writeFileSync(join(repos, "test.toml"), `schema = 1\nroot = ${JSON.stringify(f.repo)}\n`);
  const endedAt = Temporal.Now.instant().subtract({ hours: 30 }).toString();
  const record = { id: "returned", state: "ended", returned: false, judgment: null, ended_at: endedAt, workspace: f.workspaces[0] };
  writeFileSync(join(f.bin, "agx"), `#!/bin/sh\nprintf '%s\n' '${JSON.stringify([record])}'\n`);
  const doctor = await run(["bun", wsCli, "doctor", "--quiet"], f.repo, f.baseEnv);
  expect(doctor.code, doctor.err).toBe(1);
  const schema = z.object({ type: z.literal("workspace_summary"), workspace_count: z.number(), unjudged_returned_runs: z.number(), oldest_unjudged_age_hours: z.number(), unjudged_warn_hours: z.number() });
  const summary = doctor.out.split("\n").map((line) => jsonOf(schema).safeParse(line)).find((item) => item.success);
  expect(summary?.success).toBe(true);
  if (summary?.success) {
    expect(summary.data.workspace_count).toBe(1);
    expect(summary.data.unjudged_returned_runs).toBe(1);
    expect(summary.data.oldest_unjudged_age_hours).toBeGreaterThanOrEqual(30);
    expect(summary.data.unjudged_warn_hours).toBe(24);
  }
  expect(doctor.out).toContain('"finding":"unjudged-age"');
});

test("ws contract: a repository time budget defers the remaining candidates without removing them", async () => {
  const f = await fixture(2);
  const rip = join(f.bin, "rip");
  writeFileSync(rip, "#!/bin/sh\nsleep 1.2\nexit 0\n");
  chmodSync(rip, 0o755);
  const result = await run(["bun", wsCli, "gc", "--include-unrecorded", "--grace-minutes", "0", "--repo-budget-seconds", "1", "--json", "--repo", f.repo], f.repo, f.baseEnv);
  expect(result.code, result.err).toBe(0);
  const parsed = parseOutput(result.out);
  expect(parsed?.complete).toBe(false);
  expect(parsed?.rows.some((row) => row[5] === "repository time budget exhausted")).toBe(true);
  expect(existsSync(f.workspaces[1] ?? "")).toBe(true);
});

test("ws contract: gc --all starts with the repository least recently started", async () => {
  const first = await fixture(0);
  const second = await fixture(0);
  await jjRun(["workspace", "root"], second.repo, first.baseEnv);
  const repos = join(first.baseEnv.XDG_CONFIG_HOME ?? "", "agx", "repos");
  mkdirSync(repos, { recursive: true });
  for (const [index, f] of [first, second].entries()) writeFileSync(join(repos, `${index}.toml`), `schema = 1\nroot = ${JSON.stringify(f.repo)}\n`);
  const starts = join(first.baseEnv.AGX_STATE_DIR ?? "", "ws-gc-starts");
  mkdirSync(starts, { recursive: true });
  const hash = new Bun.CryptoHasher("sha256").update(first.repo).digest("hex");
  writeFileSync(join(starts, hash), String(Temporal.Now.instant().epochMilliseconds));
  const result = await run(["bun", wsCli, "gc", "--all", "--dry-run", "--json"], first.repo, first.baseEnv);
  expect(result.code, result.err).toBe(0);
  expect(result.err.indexOf(`gc --all start ${second.repo}`)).toBeLessThan(result.err.indexOf(`gc --all start ${first.repo}`));
});

test("ws contract: gc --all stops starting repositories after its run budget", async () => {
  const first = await fixture(1);
  const second = await fixture(0);
  await jjRun(["workspace", "root"], second.repo, first.baseEnv);
  const repos = join(first.baseEnv.XDG_CONFIG_HOME ?? "", "agx", "repos");
  mkdirSync(repos, { recursive: true });
  for (const [index, f] of [first, second].entries()) writeFileSync(join(repos, `${index}.toml`), `schema = 1\nroot = ${JSON.stringify(f.repo)}\n`);
  const rip = join(first.bin, "rip");
  writeFileSync(rip, "#!/bin/sh\nsleep 1.2\nexit 0\n");
  chmodSync(rip, 0o755);
  const result = await run(["bun", wsCli, "gc", "--all", "--include-unrecorded", "--grace-minutes", "0", "--all-budget-seconds", "1", "--json"], first.repo, first.baseEnv);
  expect(result.code, result.err).toBe(0);
  expect(result.err).not.toContain(`gc --all start ${second.repo}`);
  expect(result.out).toContain("run time budget exhausted");
});

test("ws contract: an unparseable workspace list line is reported with its raw text", () => {
  const raw = `not a workspace record ${"x".repeat(320)}`;
  const repo = { backing: "/repo", name: "repo", parent: "/", wsRoot: "/repo.ws" };
  const row = parseWorkspaceList(repo, raw)[0];
  expect(row?.name).toContain("<invalid-workspace-");
  expect(row?.recordError).toContain(raw.slice(0, 300));
  expect(row?.recordError).not.toContain(raw.slice(0, 301));
});

test("ws contract: a workspace list timestamp error preserves the workspace row", () => {
  const repo = { backing: "/repo", name: "repo", parent: "/", wsRoot: "/repo.ws" };
  const record = JSON.stringify({ name: "ws_1", root: "/repo.ws/ws_1", target: "abc", change: "def" });
  const rows = parseWorkspaceList(repo, `${record}\t<Error: Out-of-range date>`);
  expect(rows.some((row) => row.dir === "/repo.ws/ws_1" && row.age === "?")).toBe(true);
  expect(rows.some((row) => row.name.includes("<invalid-workspace-"))).toBe(false);
});

test("ws contract: a future workspace commit still produces a valid list row", async () => {
  const f = await fixture(0);
  const future = Temporal.Now.instant().add({ seconds: 60 }).toString();
  const created = await run([jj, "new"], f.repo, { ...f.baseEnv, JJ_TIMESTAMP: future });
  expect(created.code, created.err).toBe(0);
  const listed = await jjRun(["workspace", "list", "-T", 'json({"name" => self.name(), "root" => self.root(), "target" => self.target().commit_id(), "change" => self.target().change_id().short(12)}) ++ "\\t" ++ self.target().committer().timestamp().format("%s") ++ "\\n"'], f.repo, f.baseEnv);
  const repo = { backing: f.repo, name: "project", parent: f.parent, wsRoot: join(f.parent, "project.ws") };
  const rows = parseWorkspaceList(repo, listed.out, true);
  expect(rows.some((row) => row.name.includes("<invalid-workspace-"))).toBe(false);
  expect(rows.some((row) => row.dir === f.repo)).toBe(true);
});
