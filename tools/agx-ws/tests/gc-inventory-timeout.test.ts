import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const scratch = mkdtempSync(join(tmpdir(), "agx-gc-timeout-"));
const jj = Bun.which("jj") ?? "jj";
const cli = join(import.meta.dir, "../src/ws.ts");
const repo = join(scratch, "project");
const bin = join(scratch, "bin");
const home = join(scratch, "home");
const env = { ...subprocessEnvironment(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(scratch, "state"), AGX_STATE_DIR: join(scratch, "state", "agx"), PATH: `${bin}:${process.env.PATH}`, JJ_USER: "test", JJ_EMAIL: "test@example.test" };

async function run(args: string[], cwd = repo) {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  return { out, err, code };
}
async function setup() {
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, "agx"), "#!/bin/sh\nprintf '%s\\n' '[]'\n");
  writeFileSync(join(bin, "stat"), "#!/bin/sh\nprintf 'ext4\\n'\n");
  chmodSync(join(bin, "agx"), 0o755);
  chmodSync(join(bin, "stat"), 0o755);
  for (const [args, cwd] of [
    [[jj, "git", "init", repo], scratch],
    [[jj, "commit", "-m", "base"], repo],
    [[jj, "bookmark", "create", "main", "-r", "@-"], repo],
  ] satisfies [string[], string][]) {
    const result = await run(args, cwd);
    expect(result.code, result.err).toBe(0);
  }
  writeFileSync(join(repo, "agx.toml"), 'schema = 1\n[ws]\ntrunk = "main"\n');
  const root = join(scratch, "project.ws");
  mkdirSync(root);
  for (const name of ["slow", "broken"]) {
    const result = await run([jj, "workspace", "add", "--name", name, "-r", "main", "--no-colocate", join(root, name)]);
    expect(result.code, result.err).toBe(0);
  }
  return root;
}

test("gc keeps timed-out inventory unknown while reporting a broken working copy", async () => {
  const root = await setup();
  const slow = join(root, "slow");
  const broken = join(root, "broken");
  for (let i = 0; i < 1000; i++) writeFileSync(join(slow, `untracked-${i}`), "x");
  rmSync(broken, { recursive: true });
  // Advance only the inventory's deadline clock, so the timeout is independent of host speed.
  const wrapper = join(scratch, "clock.ts");
  writeFileSync(wrapper, `const now = performance.now.bind(performance);\nObject.defineProperty(performance, "now", { value: () => { const stack = new Error().stack ?? ""; return now() + (stack.includes("timedOut") ? 2000 : 0); } });\nawait import(${JSON.stringify(cli)});\n`);
  const result = await run(["bun", wrapper, "gc", "--include-unrecorded", "--legacy", "--grace-minutes", "0", "--inventory-seconds", "1", "--json", "--repo", repo]);
  const parsed = jsonOf(z.object({ rows: z.array(z.array(z.string())), counts: z.object({ kept: z.object({ broken: z.number() }) }) })).safeParse(result.out);
  expect(parsed.success, `${result.err}\n${result.out}`).toBe(true);
  if (!parsed.success) return;
  const slowRow = parsed.data.rows.find((row) => row[0] === slow);
  const brokenRow = parsed.data.rows.find((row) => row[0] === broken);
  expect(slowRow?.[2], JSON.stringify(slowRow)).toBe("unknown");
  expect(slowRow?.[5]).toContain("inventory timed out");
  expect(existsSync(slow)).toBe(true);
  expect(brokenRow?.[2]).toBe("broken");
  expect(parsed.data.counts.kept.broken).toBe(1);
  expect(result.code).toBe(1);
}, 30000);

afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
