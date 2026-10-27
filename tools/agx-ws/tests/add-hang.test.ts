import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt } from "../../shared/src/attempt.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const ws = join(import.meta.dir, "../src/ws.ts");

// One long-lived parent drains both pipes, as the example-learner launcher does.
// Count workspace-operation jj starts, excluding setup, readiness and fixed read-only policy probes.
test("WS-ADD-HANG-2: three piped adds have a fixed jj budget as history and workspace counts grow", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-add-sequence-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const calls = join(root, "jj-calls.jsonl");
  const home = join(root, "home");
  const xdgConfig = join(root, "config");
  const realJj = Bun.which("jj");
  expect(realJj).not.toBeNull();
  if (realJj === null) return;
  await mkdir(bin);
  const env: NodeJS.ProcessEnv = {
    ...stateTestEnv(),
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    JJ_USER: "test",
    JJ_EMAIL: "test@example.com",
    RIP_GRAVEYARD: join(root, "graveyard"),
    AGX_STATE_DIR: join(root, "state"),
  };
  await mkdir(home);
  await mkdir(xdgConfig, { recursive: true });
  await Bun.write(
    join(xdgConfig, "jjconfig.toml"),
    '[revset-aliases]\n"trunk()" = "bookmarks(main)"\n',
  );
  env.JJ_CONFIG = join(xdgConfig, "jjconfig.toml");
  for (const [name, body] of [
    ["stat", 'process.stdout.write("ext4\\n");'],
    ["agx", 'process.stdout.write("[]\\n");'],
    [
      "jj",
      `import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
const sharedConfigRead = process.cwd() === ${JSON.stringify(repo)} && args.includes("--at-operation=@") && (
  (args.includes("workspace") && args.includes("root") && args.includes("default")) ||
  (args.includes("file") && (args.includes("list") || args.includes("show")) && (args.includes("agx.toml") || args.includes(".agx.toml"))));
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdin:"ignore", stdout:"inherit", stderr:"pipe", timeout: 20000});
const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
if (!sharedConfigRead) {
  process.stderr.write("JJ_ENV " + JSON.stringify({home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,jjConfig:process.env.JJ_CONFIG}) + "\\n");
  try { await appendFile(process.env.WS_JJ_CALLS, JSON.stringify({args,home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,jjConfig:process.env.JJ_CONFIG,cwd:process.cwd()}) + "\\n"); }
  catch (error) { process.stderr.write("JJ_TRACE_ERROR " + String(error) + "\\n"); }
}
process.stderr.write(errors);
process.exitCode = code;`,
    ],
  ] as const) {
    const file = join(bin, name);
    await Bun.write(file, `#!/usr/bin/env bun\n${body}\n`);
    await chmod(file, 0o755);
  }
  const run = async (cmd: string[], cwd = root) => {
    const signal = AbortSignal.timeout(30_000);
    const child = Bun.spawn(cmd, {
      cwd,
      env: { ...env, WS_JJ_CALLS: calls },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
      killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(signal.aborted, `${cmd.join(" ")}: ${out}\n${err}`).toBe(false);
    expect(code, err).toBe(0);
    return { out, err };
  };
  const budgets: number[] = [];
  const diffs: string[] = [];
  const growHistory = async () => {
    for (let index = 0; index < 12; index++) {
      await Bun.write(join(repo, "history.txt"), `${index}\n`);
      await run([realJj, "commit", "-m", `history ${index}`], repo);
    }
    await run([realJj, "bookmark", "set", "main", "-r", "@-"], repo);
  };
  const growWorkspaces = async () => {
    for (let index = 0; index < 12; index++) {
      const dir = join(root, `old-${index}`);
      await run(
        [
          realJj,
          "workspace",
          "add",
          "--name",
          `old-${index}`,
          "-r",
          "main",
          dir,
        ],
        repo,
      );
      await Bun.write(join(dir, "unlanded.txt"), `${index}\n`);
      await run([realJj, "commit", "-m", `unlanded ${index}`], dir);
    }
  };
  const checked = await attempt(async () => {
    await run([realJj, "git", "init", repo]);
    await run(
      [
        realJj,
        "config",
        "set",
        "--repo",
        'revset-aliases."trunk()"',
        "bookmarks(main)",
      ],
      repo,
    );
    await Bun.write(
      join(repo, "agx.toml"),
      'schema = 1\n[ws]\ntrunk = "main"\nready = ["echo ready-finished"]\n',
    );
    await run([realJj, "commit", "-m", "base"], repo);
    await run([realJj, "bookmark", "create", "main", "-r", "@-"], repo);
    const trunk = await run(
      [realJj, "log", "--no-graph", "-r", "trunk()", "-T", "commit_id"],
      repo,
    );
    expect(trunk.out.trim()).toMatch(/^[a-f0-9]{40}$/u);
    for (const stage of ["small", "history", "workspaces"]) {
      if (stage === "history") await growHistory();
      if (stage === "workspaces") await growWorkspaces();
      for (let index = 0; index < 3; index++) {
        await Bun.write(calls, "");
        const slug = `${stage}-${index}`;
        const result = await run(
          [process.execPath, ws, "add", slug, "--repo", repo, "--rev", "main"],
          repo,
        );
        expect(result.out).toContain("ready-finished");
        expect(result.out).toContain(join(`${repo}.ws`, `ws_${slug}`));
        const invocations = (await Bun.file(calls).text())
          .trim()
          .split("\n")
          .filter(Boolean);
        budgets.push(invocations.length);
        diffs.push(...invocations.filter((line) => line.includes('"diff"')));
      }
    }
    expect(budgets, JSON.stringify(budgets)).toEqual(
      Array.from({ length: 9 }, () => 7),
    );
    expect(diffs).toEqual([]);
  });
  await rm(root, { recursive: true, force: true });
  await rm(calls, { force: true });
  expect(checked.ok, checked.ok ? undefined : String(checked.error)).toBe(true);
}, 90_000);

// The shared preload still injects retired configuration; isolate refusal tests.
function stateTestEnv(): NodeJS.ProcessEnv {
  const env = { ...subprocessEnvironment() };
  delete env.AGX_NEXT_STATE_DIR;
  delete env.JJ_CONFIG;
  return env;
}
