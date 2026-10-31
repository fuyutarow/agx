import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const scratch = mkdtempSync(join(tmpdir(), "agx-gc-read-race-"));
const jj = Bun.which("jj") ?? "jj";
const cli = join(import.meta.dir, "../src/ws.ts");
let sequence = 0;

test.each(["read", "exception"])("gc keeps classifying after %s failure", async (failure) => {
  const parent = join(scratch, String(sequence++));
  const repo = join(parent, "project");
  const home = join(parent, "home");
  const bin = join(parent, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home);
  writeFileSync(join(bin, "agx"), "#!/bin/sh\nprintf '%s\\n' '[]'\n");
  writeFileSync(join(bin, "stat"), "#!/bin/sh\nprintf 'ext4\\n'\n");
  chmodSync(join(bin, "agx"), 0o755);
  chmodSync(join(bin, "stat"), 0o755);
  const env = { ...subprocessEnvironment(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(parent, "state"), AGX_STATE_DIR: join(parent, "state", "agx"), PATH: `${bin}:${process.env.PATH}`, JJ_USER: "test", JJ_EMAIL: "test@example.test" };
  async function run(args: string[], cwd = repo) {
    const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    return { out, err, code };
  }
  let result = await run([jj, "git", "init", repo], parent);
  expect(result.code, result.err).toBe(0);
  writeFileSync(join(repo, "tracked"), "content");
  for (const args of [[jj, "commit", "-m", "base"], [jj, "bookmark", "create", "main", "-r", "@-"]]) {
    result = await run(args);
    expect(result.code, result.err).toBe(0);
  }
  writeFileSync(join(repo, "agx.toml"), 'schema = 1\n[ws]\ntrunk = "main"\n');
  const root = join(parent, "project.ws");
  mkdirSync(root);
  const first = join(root, "a-failing");
  const next = join(root, "b-next");
  for (const dir of [first, next]) {
    result = await run([jj, "workspace", "add", "--name", dir === first ? "a-failing" : "b-next", "-r", "main", "--no-colocate", dir]);
    expect(result.code, result.err).toBe(0);
  }
  writeFileSync(join(next, "untracked"), "keep the next workspace");
  const wrapper = join(parent, "inject.ts");
  writeFileSync(wrapper, `import { mock } from "bun:test";
const fs = await import("node:fs/promises");
const target = ${JSON.stringify(join(first, "tracked"))};
const originalReadFile = fs.readFile;
const originalLstat = fs.lstat;
mock.module("node:fs/promises", () => ({ ...fs, readFile: (...args) => {
  if (${JSON.stringify(failure)} === "read" && args[0] === target) throw Object.assign(new Error("injected missing"), { code: "ENOENT" });
  return originalReadFile(...args);
}, lstat: (...args) => {
  if (${JSON.stringify(failure)} === "exception" && args[0] === target) throw new Error("injected unexpected classification error");
  return originalLstat(...args);
} }));
await import(${JSON.stringify(cli)});
`);
  // Throw outside the guarded file operations, while classifyGc is running.
  if (failure === "exception") writeFileSync(wrapper, `const now = performance.now.bind(performance);
let thrown = false;
Object.defineProperty(performance, "now", { value: () => { if (!thrown && (new Error().stack ?? "").includes("classifyGc")) { thrown = true; throw new Error("injected unexpected classification error"); } return now(); } });
await import(${JSON.stringify(cli)});
`);
  result = await run(["bun", wrapper, "gc", "--include-unrecorded", "--legacy", "--grace-minutes", "0", "--json", "--repo", repo]);
  const parsed = jsonOf(z.object({ rows: z.array(z.array(z.string())) })).safeParse(result.out);
  expect(parsed.success, `${result.err}\n${result.out}`).toBe(true);
  if (!parsed.success) return;
  const failed = parsed.data.rows.find((row) => row[0] === first);
  const other = parsed.data.rows.find((row) => row[0] === next);
  expect(failed?.[2], JSON.stringify(failed)).toBe(failure === "read" ? "keep" : "unknown");
  expect(failed?.[5]).toContain(failure === "read" ? "sparse or missing tracked file: tracked" : "injected unexpected classification error");
  expect(other?.[2], result.out).toBe("keep");
  expect(other?.[5]).toContain("untracked content");
  expect(result.code, result.err).toBe(0);
  expect(existsSync(first)).toBe(true);
  expect(result.err).not.toContain("Unhandled");
}, 30000);

afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
