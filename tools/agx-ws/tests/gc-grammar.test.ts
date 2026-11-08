const Envelope = z.object({
  rows: z.array(z.array(z.string())),
  counts: z.object({
    total: z.number(),
    unlanded: z.number(),
    collectable: z.number(),
    removed: z.number(),
    kept: z.record(z.string(), z.number()),
  }),
  broken: z.array(z.unknown()),
  complete: z.boolean(),
});
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
setDefaultTimeout(120_000);
const scratch = mkdtempSync(join(tmpdir(), "agx-ws-gc-contract-"));
const wsCli = process.env.GC_WS_CLI ?? join(import.meta.dir, "../src/ws.ts");
const jj = Bun.which("jj") ?? "jj";
let repoCount = 0;

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
  await jjRun(
    ["bookmark", "create", "main", "-r", initialCommit ? "@-" : "@"],
    repo,
    baseEnv,
  );
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

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
test("gc modes preserve effects and JSON envelope", async () => {
  for (const [flags, removes] of [
    [[], false],
    [["--apply"], true],
    [["--dry-run"], false],
    [["--apply", "--dry-run", "--json"], false],
    [["--dry-run", "--json"], false],
    [["--json"], false],
  ] satisfies [string[], boolean][]) {
    const f = await fixture(1);
    const rip = join(f.bin, "rip");
    writeFileSync(rip, '#!/bin/sh\nrm -rf -- "$@"\n');
    chmodSync(rip, 0o755);
    const result = await run(
      [
        "bun",
        wsCli,
        "gc",
        "--include-unrecorded",
        "--grace-minutes",
        "0",
        "--repo",
        f.repo,
        ...flags,
      ],
      f.repo,
      f.baseEnv,
    );
    expect(result.code, result.err).toBe(
      flags.includes("--apply") && flags.includes("--dry-run") ? 2 : 0,
    );
    expect(existsSync(f.workspaces[0]!)).toBe(!removes);
    if (result.code === 2) {
      expect(result.out).toBe("");
      expect(result.err).toContain("--apply");
      expect(result.err).toContain("--dry-run");
      continue;
    }
    if (flags.length === 0 || (flags.length === 1 && flags[0] === "--json")) {
      const explicit = await run(
        [
          "bun",
          wsCli,
          "gc",
          "--include-unrecorded",
          "--grace-minutes",
          "0",
          "--repo",
          f.repo,
          "--dry-run",
          ...flags,
        ],
        f.repo,
        f.baseEnv,
      );
      expect(explicit.code, explicit.err).toBe(0);
      if (flags.includes("--json")) {
        const actual = envelope(result.out);
        const expected = envelope(explicit.out);
        expect({ ...actual, rows: withoutAge(actual.rows) }).toEqual({
          ...expected,
          rows: withoutAge(expected.rows),
        });
      } else {
        const rows = (out: string) =>
          out
            .trimEnd()
            .split("\n")
            .map((line) => line.split("\t"));
        expect(withoutAge(rows(result.out))).toEqual(
          withoutAge(rows(explicit.out)),
        );
      }
    }
    if (flags.includes("--json")) {
      const human = await run(
        [
          "bun",
          wsCli,
          "gc",
          "--include-unrecorded",
          "--grace-minutes",
          "0",
          "--repo",
          f.repo,
          "--dry-run",
        ],
        f.repo,
        f.baseEnv,
      );
      expect(human.code, human.err).toBe(0);
      const rows = human.out
        .trimEnd()
        .split("\n")
        .map((line) => line.split("\t"));
      const original = rows.filter(
        (row) => row[1] !== "repo" && row[2] !== "collected",
      );
      const workspaces = rows.filter(
        (row) => row[1] !== "repo" && row[1] !== "main",
      );
      const value = envelope(result.out);
      expect(value.rows.length).toBe(2);
      expect(value.counts.total).toBe(original.length);
      expect(value.counts.unlanded).toBe(
        original.filter(
          (row) =>
            row[2] === "keep" && row[5]?.includes("unlanded change ") === true,
        ).length,
      );
      expect(value.counts.collectable).toBe(
        original.filter((row) => row[2] === "removable").length,
      );
      expect(value.counts.removed).toBe(
        workspaces.filter(
          (row) =>
            row[2] === "collected" || row[5]?.endsWith("; removed") === true,
        ).length,
      );
      expect(value.counts.kept.removable).toBe(
        workspaces.filter((row) => row[2] === "removable").length,
      );
      const retained = workspaces.filter(
        (row) =>
          row[2] !== "collected" && row[5]?.endsWith("; removed") !== true,
      );
      const indicators: Record<string, (row: string[]) => boolean> = {
        broken: (row) => row[2] === "broken",
        unlanded: (row) => row[5]?.includes("unlanded change ") === true,
        unjudged_run: (row) => row[5]?.includes(" is unjudged; keep") === true,
        untracked_content: (row) =>
          row[5]?.includes("untracked content:") === true,
        inventory_budget_exhausted: (row) =>
          row[5]?.includes("inventory budget exhausted") === true,
        removable: (row) => row[2] === "removable",
        unrecorded: (row) => row[5]?.includes("unrecorded workspace;") === true,
        unsnapshotted: (row) =>
          row[5]?.includes("unsnapshotted working-copy changes:") === true,
        abandoned: (row) =>
          row[5]?.includes(
            "all runs ended without acceptance over 24h ago:",
          ) === true,
        active_processes: (row) =>
          row[5]?.includes("processes are working inside ") === true,
        configured_keep: (row) =>
          row[5]?.includes("declared in [ws].keep") === true,
      };
      Object.entries(indicators).forEach(([key, matches]) => {
        expect(value.counts.kept[key]).toBe(
          retained.filter((row) => matches(row)).length,
        );
      });
      expect(value.counts.kept.other).toBe(
        retained.filter(
          (row) => !Object.values(indicators).some((matches) => matches(row)),
        ).length,
      );
      expect(value.broken).toEqual([]);
      expect(value.complete).toBe(true);
    }
  }
});

function withoutAge(rows: string[][]) {
  return rows.map((row) =>
    row.map((value, index) => (index === 4 ? "AGE" : value)),
  );
}

test("report comparison ignores only the changing age column", () => {
  const row = ["/workspace", "ws", "removable", "change", "now", "reason"];
  expect(withoutAge([row])).toEqual(
    withoutAge([[...row.slice(0, 4), "1 second ago", "reason"]]),
  );
  expect(withoutAge([row])).toEqual(
    withoutAge([[...row.slice(0, 4), "2 minutes ago", "reason"]]),
  );
  expect(withoutAge([row])).not.toEqual(
    withoutAge([[...row.slice(0, 2), "keep", ...row.slice(3)]]),
  );
});

function envelope(text: string) {
  const parsed = jsonOf(Envelope).safeParse(text);
  expect(parsed.success).toBe(true);
  return parsed.success
    ? parsed.data
    : {
        rows: [],
        counts: {
          total: 0,
          unlanded: 0,
          collectable: 0,
          removed: 0,
          kept: {},
        },
        broken: [],
        complete: false,
      };
}
