import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const StatusSchema = z.object({ workspaces: z.object({ here: z.number() }) });

const root = await mkdtemp(join(tmpdir(), "agx-status-repo-flag-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const repo = join(root, "repo");
const state = join(root, "state");
const bin = join(root, "bin");
await Promise.all([mkdir(repo), mkdir(state), mkdir(bin)]);
const init = Bun.spawn(["git", "init", "--quiet", repo], {
  stdout: "ignore",
  stderr: "pipe",
  timeout: 10000,
});
const [initError, initExit] = await Promise.all([
  init.stderr.text(),
  init.exited,
]);
expect(initExit, initError).toBe(0);
await symlink(
  join(import.meta.dir, "../../src/status.ts"),
  join(bin, "agx-status"),
);
const counts = { total: 2, unlanded: 1, collectable: 0, legacy: 0 };
await writeFile(
  join(state, "workspace-verdicts.json"),
  JSON.stringify({
    counts,
    capturedAt: 1,
    complete: true,
    repos: { [repo]: { counts, capturedAt: 1 } },
  }),
);
const env: NodeJS.ProcessEnv = {
  ...subprocessEnvironment(),
  AGX_STATE_DIR: state,
  PATH: `${bin}:${process.env.PATH ?? ""}`,
};
delete env.AGX_NEXT_STATE_DIR;

async function run(args: string[], overrides: Record<string, string> = {}) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../../agx/src/agx.ts"),
      "status",
      ...args,
    ],
    {
      cwd: repo,
      env: { ...env, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("repo and cwd identify the same repository and default to the current directory", async () => {
  const old = await run(["--json", "--cwd", repo]);
  const alias = await run(["--json", "--repo", repo]);
  const reverse = await run(["--repo", repo, "--json"]);
  const equals = await run(["--json", `--repo=${repo}`]);
  const implicit = await run(["--json"]);
  for (const result of [old, alias, reverse, equals, implicit]) {
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const actual = jsonOf(StatusSchema).safeParse(result.stdout);
    const expected = jsonOf(StatusSchema).safeParse(old.stdout);
    expect(actual.success).toBe(true);
    expect(expected.success).toBe(true);
    if (!actual.success || !expected.success) continue;
    expect(actual.data).toEqual(expected.data);
    expect(actual.data.workspaces.here).toBe(2);
  }
});

test("both flags are refused before checking state", async () => {
  for (const args of [
    ["--json", "--repo", repo, "--cwd", join(root, "other")],
    ["--json", `--cwd=${repo}`, `--repo=${repo}`],
  ]) {
    const result = await run(args, { AGX_NEXT_STATE_DIR: "retired" });
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--repo");
    expect(result.stderr).toContain("--cwd");
    expect(result.stderr).not.toContain("AGX_NEXT_STATE_DIR");
  }
});

test("help identifies the preferred flag and its older name", async () => {
  const result = await run(["--help"]);
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("--repo");
  expect(result.stdout).toContain(
    "any workspace or the main checkout of the repository",
  );
  expect(result.stdout).toContain("older name for --repo");
});
