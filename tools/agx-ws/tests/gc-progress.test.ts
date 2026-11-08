import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gcOrderPath,
  opStoreSize,
  orderGcCandidates,
  readGcOrder,
} from "../src/gc-order.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const root = mkdtempSync(join(tmpdir(), "agx-gc-progress-"));
const repo = join(root, "project");
const bin = join(root, "bin");
const env = {
  ...subprocessEnvironment(),
  HOME: join(root, "home"),
  AGX_STATE_DIR: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  PATH: `${bin}:${process.env.PATH}`,
  JJ_USER: "test",
  JJ_EMAIL: "test@example.test",
};
const jj = Bun.which("jj") ?? "jj";
async function run(args: string[], cwd = repo) {
  const child = Bun.spawn(args, {
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

test("budget-limited runs advance and never remove deferred workspaces", async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(env.HOME, { recursive: true });
  for (const name of ["agx", "stat"]) {
    writeFileSync(
      join(bin, name),
      name === "agx"
        ? "#!/bin/sh\nprintf '[]\\n'\n"
        : "#!/bin/sh\nprintf 'ext4\\n'\n",
    );
    chmodSync(join(bin, name), 0o755);
  }
  for (const [args, cwd] of [
    [[jj, "git", "init", repo], root],
    [[jj, "commit", "-m", "base"], repo],
    [[jj, "bookmark", "create", "main", "-r", "@-"], repo],
  ] satisfies [string[], string][]) {
    const result = await run(args, cwd);
    expect(result.code, result.err).toBe(0);
  }
  writeFileSync(join(repo, "agx.toml"), 'schema = 1\n[ws]\ntrunk = "main"\n');
  const paths = ["ws_a", "ws_b", "ws_c"].map((name) =>
    join(root, "project.ws", name),
  );
  mkdirSync(join(root, "project.ws"), { recursive: true });
  for (const path of paths) {
    const result = await run([
      jj,
      "workspace",
      "add",
      "--name",
      path.split("/").at(-1) ?? "",
      "-r",
      "main",
      "--no-colocate",
      path,
    ]);
    expect(result.code, result.err).toBe(0);
  }
  const cli = join(import.meta.dir, "../src/ws.ts");
  // Slow removal consumes the budget after the first classified candidate.
  writeFileSync(join(bin, "rip"), "#!/bin/sh\nsleep 3.2\nexit 0\n");
  chmodSync(join(bin, "rip"), 0o755);
  const args = [
    "bun",
    cli,
    "gc",
    "--apply",
    "--include-unrecorded",
    "--grace-minutes",
    "0",
    "--repo-budget-seconds",
    "3",
    "--json",
    "--repo",
    repo,
  ];
  const first = await run(args);
  expect(first.code, first.err).toBe(0);
  const rows1: string[][] = JSON.parse(first.out).rows;
  const deferred = rows1
    .filter((row) => row[5] === "repository time budget exhausted")
    .map((row) => row[0]);
  expect(deferred.length).toBeGreaterThan(0);
  for (const path of deferred) expect(existsSync(path ?? "")).toBe(true);
  expect(first.err).toContain(
    `gc: ${deferred.length} workspaces deferred by the repository budget; the next run starts with them`,
  );
  const second = await run(args);
  expect(second.code, second.err).toBe(0);
  const rows2: string[][] = JSON.parse(second.out).rows;
  expect(
    rows2.some(
      (row) =>
        deferred.includes(row[0]) &&
        row[5] !== "repository time budget exhausted",
    ),
  ).toBe(true);
  const view = join(repo, ".jj", "repo", "op_store", "views", "gc-test-large");
  writeFileSync(view, "x");
  truncateSync(view, 1024 ** 3 + 1);
  const full = await run([
    "bun",
    cli,
    "gc",
    "--dry-run",
    "--json",
    "--repo",
    repo,
  ]);
  expect(full.code, full.err).toBe(0);
  expect(full.err).not.toContain(
    "workspaces deferred by the repository budget",
  );
  expect(full.err).toContain("jj op_store is at least");
  expect(full.err).toContain(
    "jj operations in this repository are slowed by it",
  );
  rmSync(view);
  const small = await run([
    "bun",
    cli,
    "gc",
    "--dry-run",
    "--json",
    "--repo",
    repo,
  ]);
  expect(small.code, small.err).toBe(0);
  expect(small.err).not.toContain("jj op_store is at least");
}, 60000);

test("missing and corrupt state use path order", async () => {
  const isolated = { ...env, AGX_STATE_DIR: join(root, "isolated") };
  const candidates = [{ dir: "/z" }, { dir: "/a" }];
  expect(
    orderGcCandidates(candidates, await readGcOrder(repo, isolated)).map(
      (x) => x.dir,
    ),
  ).toEqual(["/a", "/z"]);
  const path = gcOrderPath(repo, isolated);
  mkdirSync(join(root, "isolated", "ws-gc-classified"), { recursive: true });
  writeFileSync(path, "{bad");
  expect(
    orderGcCandidates(candidates, await readGcOrder(repo, isolated)).map(
      (x) => x.dir,
    ),
  ).toEqual(["/a", "/z"]);
});

test("op store threshold counts sparse file logical size", async () => {
  const fake = join(root, "fake");
  const store = join(fake, ".jj", "repo", "op_store", "views");
  mkdirSync(store, { recursive: true });
  const file = join(store, "view");
  writeFileSync(file, "x");
  expect(await opStoreSize(fake, 10)).toBe(1);
  truncateSync(file, 11);
  expect(await opStoreSize(fake, 10)).toBeGreaterThan(10);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
