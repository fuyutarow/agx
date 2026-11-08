import { jsonOf, z } from "../../shared/src/zod.ts";
const Envelope = z.object({
  rows: z.array(z.array(z.string())),
  counts: z.record(z.string(), z.number()),
  broken: z.array(z.unknown()),
  complete: z.boolean(),
});
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

setDefaultTimeout(60_000);
const scratch = await mkdtemp(join(tmpdir(), "tkt-lifecycle-"));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const cli = join(import.meta.dir, "../src/tkt.ts");
const bun = process.execPath;
let sequence = 0;
async function fixture(custom?: string) {
  const root = join(scratch, String(++sequence));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const records = join(root, "runs.json");
  const localDirectory = join(root, "config/agx/repos");
  await mkdir(localDirectory, { recursive: true });
  const local = join(localDirectory, "repo.toml");
  const home = join(root, "home");
  await mkdir(bin, { recursive: true });
  await mkdir(home);
  const env = {
    ...stateTestEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "transpiler-cache"),
    AGX_STATE_DIR: home,
    JJ_CONFIG: "",
    JJ_USER: "Fixture",
    JJ_EMAIL: "fixture@example.com",
    PATH: `${bin}:${process.env.PATH}`,
    TKT_RECORDS: records,
  };
  async function run(
    args: string[],
    cwd = repo,
    overrides: NodeJS.ProcessEnv = {},
  ) {
    const p = Bun.spawn(args, {
      cwd,
      env: { ...env, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { out, err, code };
  }
  async function register(name: string, repoRoot: string) {
    await writeFile(
      join(localDirectory, `${name}.toml`),
      `schema = 1\nroot = ${JSON.stringify(repoRoot)}\n`,
    );
  }
  expect((await run(["jj", "git", "init", repo], root)).code).toBe(0);
  if (custom !== undefined)
    await writeFile(join(repo, "agx.toml"), `schema = 1\n${custom}`);
  await writeFile(join(repo, "base"), "base\n");
  expect((await run(["jj", "commit", "-m", "base"])).code).toBe(0);
  expect(
    (await run(["jj", "bookmark", "create", "main", "-r", "@-"])).code,
  ).toBe(0);
  expect(
    (
      await run([
        "jj",
        "config",
        "set",
        "--repo",
        'revset-aliases."trunk()"',
        "bookmarks(main)",
      ])
    ).code,
  ).toBe(0);
  const shim = join(bin, "agx");
  await writeFile(
    shim,
    `#!${bun}\nif (process.argv.slice(2).join(' ') !== 'worker ls --json --all') process.exit(9);\nprocess.stdout.write(await Bun.file(process.env.TKT_RECORDS).text());\n`,
  );
  await chmod(shim, 0o755);
  await writeFile(records, "[]");
  const tkt = (args: string[]) => run([bun, cli, ...args, "--repo", repo]);
  const record = (ticket: string, extra: object = {}) => ({
    id: `run-${ticket}`,
    ticket,
    started_at: "2026-10-16T00:00:00Z",
    state: "ended",
    judgment: null,
    cwd: repo,
    workspace: repo,
    workspace_name: "default",
    ...extra,
  });
  return {
    root,
    repo,
    home,
    initialHome: await readdir(home),
    local,
    register,
    records,
    run,
    tkt,
    record,
  };
}
test("gc modes preserve effects and JSON uses the workspace envelope", async () => {
  for (const [flags, removes] of [
    [[], true],
    [["--apply"], true],
    [["--dry-run"], false],
    [["--apply", "--dry-run", "--json"], false],
    [["--dry-run", "--json"], false],
  ] satisfies [string[], boolean][]) {
    const f = await fixture();
    const created = await f.tkt(["new", "eligible"]);
    expect(created.code, created.err).toBe(0);
    const path = created.out.trim();
    await writeFile(
      f.records,
      JSON.stringify([
        f.record("eligible", { judgment: { decision: "accept" } }),
      ]),
    );
    const result = await f.tkt(["gc", ...flags]);
    expect(result.code, result.err).toBe(
      flags.includes("--apply") && flags.includes("--dry-run") ? 2 : 0,
    );
    expect(await Bun.file(path).exists()).toBe(!removes);
    if (result.code === 2) {
      expect(result.out).toBe("");
      expect(result.err).toContain("--apply");
      expect(result.err).toContain("--dry-run");
      continue;
    }
    if (flags.includes("--json")) {
      const human = await f.tkt(["gc", "--dry-run"]);
      expect(human.code, human.err).toBe(0);
      const lines = human.out.trimEnd().split("\n");
      const value = envelope(result.out);
      expect(value.rows.length).toBe(1);
      expect(value.counts["would-collect"]).toBe(
        lines.filter((line) => line.startsWith("would-collect\t")).length,
      );
      expect(value.broken).toEqual([]);
      expect(value.complete).toBe(true);
    }
  }
});
function stateTestEnv(): NodeJS.ProcessEnv {
  const env = { ...subprocessEnvironment() };
  delete env.AGX_NEXT_STATE_DIR;
  return env;
}

function envelope(text: string) {
  const parsed = jsonOf(Envelope).safeParse(text);
  expect(parsed.success).toBe(true);
  return parsed.success
    ? parsed.data
    : { rows: [], counts: { total: 0 }, broken: [], complete: false };
}
