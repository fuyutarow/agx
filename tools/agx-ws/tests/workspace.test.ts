// Fixtures use real jj repositories in a scratch directory, a fake `agx` on PATH, and a `stat`
// shim whose answer decides whether the graveyard looks RAM-backed.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import {
  mkdir,
  chmod,
  unlink,
  lstat,
  symlink,
  truncate,
} from "node:fs/promises";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { rootFileFileset, untrackedContent } from "../src/workspace.ts";

setDefaultTimeout(60_000);
const WS = join(import.meta.dir, "../src/ws.ts");
const scratch = mkdtempSync(join(tmpdir(), "ws-test-"));
const bin = join(scratch, "bin");
const graveyard = join(scratch, "graveyard");
const records = join(scratch, "agx.json");
const home = join(scratch, "home");

const baseEnv = (
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  ...stateTestEnv(),
  PATH: `${bin}:${process.env.PATH}`,
  HOME: home,
  XDG_STATE_HOME: join(home, "state"),
  AGX_STATE_DIR: join(home, "state/agx"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  MISE_STATE_DIR: join(scratch, "mise-state"),
  MISE_CONFIG_DIR: join(scratch, "mise-config"),
  MISE_CEILING_PATHS: scratch,
  MISE_TRUSTED_CONFIG_PATHS: "",
  MISE_PARANOID: "1",
  RIP_GRAVEYARD: graveyard,
  GRAVEYARD: graveyard,
  JJ_USER: "t",
  JJ_EMAIL: "t@example.com",
  FAKE_FS: "ext4",
  ...extra,
});

async function run(cmd: string[], cwd: string, env = baseEnv()) {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}
// Existing GC fixtures predate the default grace contract; opt them out unless a test sets it.
const ws = (args: string[], cwd: string, env = baseEnv()) =>
  run(
    [
      "bun",
      WS,
      ...args,
      ...(args[0] === "gc" &&
      !args.includes("--grace-minutes") &&
      !args.includes("--help")
        ? ["--grace-minutes", "0"]
        : []),
    ],
    cwd,
    env,
  );
const jj = (args: string[], cwd: string) => run(["jj", ...args], cwd);

async function pushBookmark(path: string, name: string): Promise<string> {
  const remote = join(scratch, `remote-${name}.git`);
  const init = Bun.spawn(["git", "init", "--bare", remote], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, , initCode] = await Promise.all([
    new Response(init.stdout).text(),
    new Response(init.stderr).text(),
    init.exited,
  ]);
  expect(initCode).toBe(0);
  expect(
    (await jj(["git", "remote", "add", "origin", remote], path)).code,
  ).toBe(0);
  expect((await jj(["bookmark", "create", name, "-r", "@-"], path)).code).toBe(
    0,
  );
  const pushed = await jj(
    ["git", "push", "--remote", "origin", "--bookmark", name],
    path,
  );
  expect(pushed.code, pushed.err).toBe(0);
  return remote;
}

function shim(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}
const setRecords = (rows: object[]): void => {
  writeFileSync(records, JSON.stringify(rows));
};

let counter = 0;
/** A fresh repo `<scratch>/n/<name>` with one landed commit on bookmark `main`; returns its path. */
async function repo(config?: string, colocate = true): Promise<string> {
  const parent = join(scratch, `r${++counter}`);
  mkdirSync(parent);
  const path = join(parent, "proj");
  expect(
    (
      await jj(
        ["git", "init", ...(colocate ? [] : ["--no-colocate"]), path],
        parent,
      )
    ).code,
  ).toBe(0);
  writeFileSync(join(path, "a.txt"), "a\n");
  if (config !== undefined) writeFileSync(join(path, ".ws.toml"), config);
  await jj(["commit", "-m", "base"], path);
  expect(
    (await jj(["bookmark", "create", "main", "-r", "@-"], path)).code,
  ).toBe(0);
  return path;
}
const wsDir = (path: string, slug: string): string =>
  join(path, "..", "proj.ws", `ws_${slug}`);

describe("workspace contract: trunk marker", () => {
  test("creates from alpha@origin when its git copy is behind local alpha", async () => {
    const path = await repo(undefined, false);
    const remote = await pushBookmark(path, "alpha");
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "alpha"],
          path,
        )
      ).code,
    ).toBe(0);
    const origin = await jj(
      ["log", "--no-graph", "-r", "alpha@origin", "-T", "commit_id"],
      path,
    );
    expect(origin.code, origin.err).toBe(0);
    const exported = await jj(["git", "export"], path);
    expect(exported.code, exported.err).toBe(0);
    const remoteWriter = join(scratch, "remote-alpha-writer");
    const cloned = await jj(["git", "clone", remote, remoteWriter], scratch);
    expect(cloned.code, cloned.err).toBe(0);
    expect((await jj(["new", "alpha"], remoteWriter)).code).toBe(0);
    await Bun.write(join(remoteWriter, "ahead.txt"), "remote alpha is ahead\n");
    expect(
      (await jj(["commit", "-m", "advance remote alpha"], remoteWriter)).code,
    ).toBe(0);
    expect(
      (await jj(["bookmark", "set", "alpha", "-r", "@-"], remoteWriter)).code,
    ).toBe(0);
    const pushed = await jj(
      ["git", "push", "--remote", "origin", "--bookmark", "alpha"],
      remoteWriter,
    );
    expect(pushed.code, pushed.err).toBe(0);
    const fetched = await jj(["git", "fetch", "--remote", "origin"], path);
    expect(fetched.code, fetched.err).toBe(0);
    const [local, gitCopy, remoteNow] = await Promise.all([
      jj(["log", "--no-graph", "-r", "alpha", "-T", "commit_id"], path),
      jj(["log", "--no-graph", "-r", "alpha@git", "-T", "commit_id"], path),
      jj(["log", "--no-graph", "-r", "alpha@origin", "-T", "commit_id"], path),
    ]);
    expect(local.code, local.err).toBe(0);
    expect(gitCopy.code, gitCopy.err).toBe(0);
    expect(remoteNow.code, remoteNow.err).toBe(0);
    expect(gitCopy.out.trim()).toBe(origin.out.trim());
    expect(local.out.trim()).toBe(remoteNow.out.trim());
    expect(gitCopy.out.trim()).not.toBe(remoteNow.out.trim());

    const added = await ws(["add", "trunk-marker"], path);
    expect(added.code, added.err).toBe(0);
    expect(added.err).toContain("ws: warning:");
    expect(added.err).toContain("alpha@git");

    const workspaceBase = await jj(
      ["log", "--no-graph", "-r", "@-", "-T", "commit_id"],
      wsDir(path, "trunk-marker"),
    );
    expect(workspaceBase.code, workspaceBase.err).toBe(0);
    expect(workspaceBase.out.trim()).toBe(remoteNow.out.trim());
    expect(workspaceBase.out.trim()).not.toBe(gitCopy.out.trim());
  });
});

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  shim("agx", `cat "${records}"`);
  shim("stat", `echo "$FAKE_FS"`);
  setRecords([]);
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const listing = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).toSorted() : [];
const symlinkTargets = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const link = join(directory, entry);
    return lstatSync(link).isSymbolicLink() ? [readlinkSync(link)] : [];
  });
const pathExists = (dir: string): Promise<boolean> =>
  lstat(dir).then(
    () => true,
    () => false,
  );
const gcRows = jsonOf(
  z.object({
    rows: z.array(z.array(z.string())),
    broken: z.array(z.string()),
    complete: z.boolean(),
  }),
);

describe("AGX-GC-UNTRACKED-KEEP-1024", () => {
  test("counts every entry, samples five paths and refuses expired inventories", async () => {
    const path = await repo('trunk = "main"\n');
    for (let index = 0; index < 7; index++)
      await Bun.write(join(path, `.state/plan-${index}.json`), "live\n");
    await symlink("missing-target", join(path, "live-link"));
    const result = await untrackedContent(path, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(8);
    expect(result.value.paths).toHaveLength(5);
    expect((await untrackedContent(path, [], 0)).ok).toBe(false);
  });

  for (const [artifact, declaration, kept] of [
    [".state/plan.json", "", true],
    ["loose.txt", "", true],
    ["nested/node_modules/pkg/index.js", "", true],
    ["cache/build.bin", 'regenerable = ["cache/"]\n', false],
    ["cache-other/live.json", 'regenerable = ["cache"]\n', true],
  ] as const) {
    test(`${artifact}: dry and real GC preserve only non-regenerable content`, async () => {
      const path = await repo(`trunk = "main"\n${declaration}`);
      setRecords([]);
      expect((await ws(["add", "inventory"], path)).code).toBe(0);
      const dir = wsDir(path, "inventory");
      // Ignore the artifact without creating a tracked diff in the workspace.
      await Bun.write(
        join(dir, ".gitignore"),
        artifact === "loose.txt"
          ? "# keep loose.txt untracked\n"
          : `${artifact.split("/")[0]}\n`,
      );
      await jj(["commit", "-m", "ignore"], dir);
      await jj(["bookmark", "set", "main", "-r", "@-"], dir);
      await Bun.write(join(dir, artifact), "live artifact\n");
      for (const dry of [true, false]) {
        const result = await ws(
          ["gc", "--include-unrecorded", ...(dry ? ["--dry-run"] : [])],
          path,
        );
        expect(result.code, result.err).toBe(0);
        if (kept) {
          expect(result.out).toContain("\tkeep\t");
          expect(result.out).toContain(
            `untracked content: 1 files (${artifact})`,
          );
        } else expect(result.out).toContain("\tremovable\t");
      }
      expect(existsSync(dir)).toBe(kept);
    });
  }

  test("inventory does not invoke per-workspace jj file list", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "inventory-error"], path)).code).toBe(0);
    const realJj = Bun.which("jj");
    const errorBin = join(scratch, "inventory-error-bin");
    mkdirSync(errorBin);
    const trace = join(scratch, "inventory-error-trace");
    const fake = join(errorBin, "jj");
    await Bun.write(
      fake,
      `#!/usr/bin/env bun\nconst args = process.argv.slice(2); if (args.includes("list") && args.includes("file")) { await Bun.write(${JSON.stringify(trace)}, "called"); process.stderr.write("unexpected per-workspace inventory"); process.exit(1); } const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exitCode = await child.exited;\n`,
    );
    chmodSync(fake, 0o755);
    const result = await ws(
      ["gc", "--include-unrecorded", "--dry-run", "--json"],
      path,
      baseEnv({ PATH: `${errorBin}:${bin}:${process.env.PATH}` }),
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('"removable"');
    expect(result.out).toContain('"complete":true');
    expect(await Bun.file(trace).exists()).toBe(false);
    expect(existsSync(wsDir(path, "inventory-error"))).toBe(true);
  });

  test("a delayed per-workspace inventory call cannot delay the aggregate walk", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "inventory-timeout"], path)).code).toBe(0);
    const realJj = Bun.which("jj");
    const slowBin = join(scratch, "inventory-slow-bin");
    mkdirSync(slowBin);
    const trace = join(scratch, "inventory-slow-trace");
    const fake = join(slowBin, "jj");
    await Bun.write(
      fake,
      `#!/usr/bin/env bun\nconst args = process.argv.slice(2); if (args.includes("list") && args.includes("file")) { await Bun.write(${JSON.stringify(trace)}, "called"); await Bun.sleep(1250); } const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exitCode = await child.exited;\n`,
    );
    chmodSync(fake, 0o755);
    const env = baseEnv({ PATH: `${slowBin}:${bin}:${process.env.PATH}` });
    const completed = await ws(
      ["gc", "--include-unrecorded", "--dry-run", "--inventory-seconds", "1"],
      path,
      env,
    );
    expect(completed.code, completed.err).toBe(0);
    expect(completed.out).toContain("\tremovable\t");
    expect(await Bun.file(trace).exists()).toBe(false);
    expect(existsSync(wsDir(path, "inventory-timeout"))).toBe(true);
  });
});

describe("WS-CONFIG-ONE-SOURCE-1023", () => {
  for (const source of [
    "untracked-only",
    "committed-only",
    "working-over-committed",
  ]) {
    test(`${source}: add, rm, gc and doctor share readiness, trunk and keep policy`, async () => {
      const policy =
        'trunk = "main"\nready = ["printf chosen-ready"]\nkeep = ["ws_safe"]\n';
      const committed = source === "committed-only" ? policy : undefined;
      const path = await repo(
        source === "working-over-committed"
          ? 'trunk = "missing-trunk"\nready = ["printf wrong-ready"]\nkeep = ["ws_other"]\n'
          : committed,
      );
      if (source === "untracked-only")
        await Bun.write(join(path, ".gitignore"), "/.ws.toml\n");
      if (source === "committed-only") await unlink(join(path, ".ws.toml"));
      else await Bun.write(join(path, ".ws.toml"), policy);

      const added = await ws(["add", "safe"], path);
      expect(added.code, added.err).toBe(0);
      expect(added.out).toContain("chosen-ready");
      expect(added.out).not.toContain("wrong-ready");
      if (source === "untracked-only") {
        const tracked = await jj(["file", "list"], path);
        expect(tracked.code, tracked.err).toBe(0);
        expect(tracked.out).not.toContain(".ws.toml");
      }
      if (source === "committed-only")
        expect(existsSync(join(path, ".ws.toml"))).toBe(false);
      const safe = wsDir(path, "safe");
      // Doctor discovers checkout gitdir files; advertise the secondary fixture.
      await Bun.write(join(safe, ".git"), `gitdir: ${join(path, ".git")}\n`);
      // A secondary checkout's file is never the policy source, even when invoked there.
      await Bun.write(
        join(safe, ".ws.toml"),
        'trunk = "wrong-checkout"\nkeep = []\n',
      );
      const refused = await ws(["rm", "safe"], safe);
      expect(refused.code, refused.err).toBe(1);
      expect(refused.err).toContain("is kept by .ws.toml");
      const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], safe);
      expect(dry.code, dry.err).toBe(0);
      expect(dry.out).toContain(`${safe}\tws\tkeep\t`);

      const inventory = `import { doctorInventory } from ${JSON.stringify(join(import.meta.dir, "../src/workspace.ts"))}; console.log(JSON.stringify(await doctorInventory()));`;
      const doctor = await run(
        ["bun", "-e", inventory],
        safe,
        baseEnv({
          AGX_REPOS_ROOT: join(path, "..", "proj.ws"),
        }),
      );
      expect(doctor.code, doctor.err).toBe(0);
      expect(doctor.out).toContain('"ok":true');
      expect(doctor.out).toContain('"name":"ws_safe"');
      expect(doctor.out).toContain('"verdict":"kept"');

      // Include an eligible candidate so real GC also exercises its locked config refresh.
      const spare = await ws(["add", "spare"], path);
      expect(spare.code, spare.err).toBe(0);
      expect(spare.out).toContain("chosen-ready");
      const collected = await ws(["gc", "--include-unrecorded"], safe);
      expect(collected.code, collected.err).toBe(0);
      expect(collected.out).toContain(`${safe}\tws\tkeep\t`);
      expect(collected.out).toContain(
        `${wsDir(path, "spare")}\tws\tremovable\t`,
      );
      expect(existsSync(safe)).toBe(true);
      expect(existsSync(wsDir(path, "spare"))).toBe(false);
    });
  }

  test("invalid working policy fails closed instead of using committed policy", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "safe"], path)).code).toBe(0);
    await Bun.write(
      join(wsDir(path, "safe"), ".git"),
      `gitdir: ${join(path, ".git")}\n`,
    );
    await Bun.write(join(path, ".ws.toml"), 'keep = "invalid"\n');
    for (const args of [
      ["add", "other"],
      ["rm", "safe"],
      ["gc", "--include-unrecorded"],
    ]) {
      const result = await ws(args, path);
      expect(result.code, result.err).toBe(1);
      expect(result.err).toContain(".ws.toml");
    }
    const doctor = await ws(
      ["doctor"],
      path,
      baseEnv({ AGX_REPOS_ROOT: join(path, "..", "proj.ws") }),
    );
    expect(doctor.code, doctor.err).toBe(1);
    expect(doctor.err).toContain(".ws.toml");
    expect(existsSync(wsDir(path, "safe"))).toBe(true);
  });
});

describe("agx ws adopt", () => {
  test("WS-ADOPT-2: strips layout prefixes, preserves run suffixes and re-homes adopted changes", async () => {
    const path = await repo('trunk = "main"\n');
    for (const [old, slug] of [
      ["proj-arm-foo_bar", "foo-bar"],
      ["proj-ws-run_name-deadbeef", "run-name-deadbeef"],
      ["consumer-arm-impl_learner", "impl-learner"],
      ["proj.ws/ws_proj-arm-foo", "foo"],
    ]) {
      const dir = join(path, "..", old ?? "");
      await mkdir(join(dir, ".."), { recursive: true });
      expect(
        (await jj(["workspace", "add", "--name", `old-${slug}`, dir], path))
          .code,
      ).toBe(0);
      await Bun.write(join(dir, "work.txt"), `${old}\n`);
      const before = await jj(
        ["log", "--no-graph", "-r", "@", "-T", "change_id"],
        dir,
      );
      const moved = await ws(
        ["adopt", dir],
        path,
        baseEnv({ AGX_WS_LEGACY_PREFIX: "consumer-arm-" }),
      );
      expect(moved.code, moved.err + moved.out).toBe(0);
      const target = wsDir(path, slug ?? "");
      expect(
        (await jj(["log", "--no-graph", "-r", "@", "-T", "change_id"], target))
          .out,
      ).toBe(before.out);
      expect(await Bun.file(join(target, "work.txt")).text()).toBe(`${old}\n`);
      expect(await pathExists(dir)).toBe(false);
    }
  });

  test("WS-ADOPT-2: fix-names plans and moves only prefixed adopted workspaces", async () => {
    const path = await repo('trunk = "main"\n');
    for (const slug of ["proj-arm-one", "proj-arm-two-deadbeef", "retained"])
      expect((await ws(["add", slug], path)).code).toBe(0);
    const old = wsDir(path, "proj-arm-one");
    const before = await jj(
      ["log", "--no-graph", "-r", "@", "-T", "change_id"],
      old,
    );
    const dry = await ws(
      ["adopt", "--fix-names", "--repo", path, "--dry-run"],
      path,
    );
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out.split("\n").filter(Boolean)).toHaveLength(2);
    expect(dry.out).toContain(`${old}\t${wsDir(path, "one")}\twould-adopt`);
    const moved = await ws(["adopt", "--fix-names", "--repo", path], path);
    expect(moved.code, moved.err + moved.out).toBe(0);
    expect(
      (
        await jj(
          ["log", "--no-graph", "-r", "@", "-T", "change_id"],
          wsDir(path, "one"),
        )
      ).out,
    ).toBe(before.out);
    expect(await pathExists(wsDir(path, "two-deadbeef"))).toBe(true);
    expect(await pathExists(wsDir(path, "retained"))).toBe(true);
    expect(await pathExists(old)).toBe(false);
    for (const args of [
      ["--fix-names"],
      ["--fix-names", "--all", "--repo", path],
      ["--fix-names", "--repo", path, old],
      ["--fix-names", "--repo", path, "--slug", "x"],
    ])
      expect((await ws(["adopt", ...args], path)).code).toBe(1);
  });

  test("WS-ADOPT-2: every failure after add removes registration and directory, retaining source", async () => {
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    for (const stage of ["add", "edit", "status", "diff", "forget", "bury"]) {
      const path = await repo('trunk = "main"\n');
      const dir = join(path, "..", "proj-arm-failure");
      expect(
        (await jj(["workspace", "add", "--name", "legacy", dir], path)).code,
      ).toBe(0);
      await Bun.write(join(dir, "work.txt"), "retain source\n");
      const before = await jj(
        ["log", "--no-graph", "-r", "@", "-T", "change_id"],
        dir,
      );
      const registered = await jj(
        ["--ignore-working-copy", "workspace", "list"],
        path,
      );
      const tree = listing(join(path, ".."));
      const wrapper = join(scratch, `fail-${stage}`);
      await mkdir(wrapper);
      await Bun.write(
        join(wrapper, "jj"),
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
const stage = ${JSON.stringify(stage)};
const target = ${JSON.stringify(wsDir(path, "failure"))};
const fail = (stage === "edit" || stage === "status" || stage === "diff") && process.cwd() === target && args.includes(stage)
  || stage === "forget" && args.includes("forget") && args.includes("legacy");
if (fail) { process.stderr.write("injected Entry too large\\n"); process.exit(1); }
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
const code = await child.exited;
process.exitCode = stage === "add" && args.includes("add") && code === 0 ? 1 : code;
`,
      );
      await chmod(join(wrapper, "jj"), 0o755);
      if (stage === "bury") {
        await Bun.write(
          join(wrapper, "rip"),
          "#!/bin/sh\necho 'injected burial failure' >&2\nexit 1\n",
        );
        await chmod(join(wrapper, "rip"), 0o755);
      }
      const failed = await ws(
        ["adopt", dir],
        path,
        baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
      );
      expect(failed.code, failed.out + failed.err).toBe(1);
      expect(failed.out).toContain("new workspace removed");
      expect(
        (await jj(["--ignore-working-copy", "workspace", "list"], path)).out,
      ).toBe(registered.out);
      expect(listing(join(path, ".."))).toEqual(tree);
      expect(await pathExists(wsDir(path, "failure"))).toBe(false);
      expect(
        (await jj(["log", "--no-graph", "-r", "@", "-T", "change_id"], dir))
          .out,
      ).toBe(before.out);
      expect(await Bun.file(join(dir, "work.txt")).text()).toBe(
        "retain source\n",
      );
    }
  });

  test("dry-run inventories forgotten and plain orphan directories without adopting them", async () => {
    const path = await repo('trunk = "main"\n');
    const parent = join(path, "..");
    const equal = join(parent, "proj-arm-equal");
    const changed = join(parent, "proj-arm-changed");
    const plain = join(parent, "proj-arm-plain");
    const nested = join(parent, "proj-ws", "orphan");
    const crossNamed = join(parent, "consumer-arm-impl_learner");
    for (const [name, dir] of [
      ["equal", equal],
      ["changed", changed],
      ["cross-named", crossNamed],
    ] as const) {
      expect(
        (
          await jj(
            ["workspace", "add", "--name", name, "-r", "main", dir],
            path,
          )
        ).code,
      ).toBe(0);
      expect((await jj(["workspace", "forget", name], path)).code).toBe(0);
    }
    await Bun.write(join(changed, "a.txt"), new Uint8Array([0, 255, 128]));
    await mkdir(plain);
    await mkdir(nested, { recursive: true });
    await Bun.write(join(plain, "leftover.txt"), "owner decision\n");
    const op = () =>
      jj(
        [
          "--ignore-working-copy",
          "op",
          "log",
          "--no-graph",
          "-n",
          "1",
          "-T",
          "id",
        ],
        path,
      );
    const before = await op();
    const dry = await ws(
      ["adopt", "--all", "--repo", path, "--dry-run"],
      path,
      baseEnv({ AGX_WS_LEGACY_PREFIX: "consumer-arm-" }),
    );
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out.split("\n").filter(Boolean)).toHaveLength(5);
    expect(dry.out).toContain(
      `${crossNamed}\t${wsDir(path, "impl-learner")}\torphan:`,
    );
    expect(dry.out).toContain(
      `${equal}\t${wsDir(path, "equal")}\torphan: files differ from main: no`,
    );
    expect(dry.out).toContain(
      `${changed}\t${wsDir(path, "changed")}\torphan: files differ from main: yes: bytes differ at a.txt`,
    );
    expect(dry.out).toContain(`${plain}\t${wsDir(path, "plain")}\torphan:`);
    expect(dry.out).toContain(`${nested}\t${wsDir(path, "orphan")}\torphan:`);
    expect((await op()).out).toBe(before.out);
    expect((await ws(["adopt", equal], path)).code).toBe(1);
    const actual = await ws(["adopt", "--all", "--repo", path], path);
    expect(actual.code, actual.err).toBe(0);
    expect(actual.out).toBe("");
    expect(await Bun.file(join(equal, "a.txt")).text()).toBe("a\n");
    expect(await Bun.file(join(plain, "leftover.txt")).text()).toBe(
      "owner decision\n",
    );
  });

  test("WS-ADOPT: unlanded and nested workspaces move intact; kept and live ones are refused", async () => {
    const path = await repo('trunk = "main"\nkeep = ["../Legacy_Kept"]\n');
    const parent = join(path, "..");
    const old = [
      "Legacy_Unlanded",
      "Legacy_Kept",
      "Legacy_Live",
      "plain/Nested_Work",
    ];
    await mkdir(join(parent, "plain"));
    const changes: string[] = [];
    for (const [i, name] of old.entries()) {
      const dir = join(parent, name);
      expect(
        (await jj(["workspace", "add", "--name", `legacy-${i}`, dir], path))
          .code,
      ).toBe(0);
      await Bun.write(join(dir, "unlanded.txt"), `${name}\n`);
      const change = await jj(
        ["log", "--no-graph", "-r", "@", "-T", "change_id"],
        dir,
      );
      expect(change.code, change.err).toBe(0);
      changes.push(change.out);
    }
    const live = join(parent, "Legacy_Live", "inside");
    await mkdir(live);
    const child = Bun.spawn(["sleep", "30"], {
      cwd: live,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 35_000,
    });
    await Bun.sleep(100);
    const dry = await ws(["adopt", "--all", "--repo", path, "--dry-run"], path);
    const moved = await ws(["adopt", "--all", "--repo", path], path);
    child.kill();
    await child.exited;
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out.split("\n").filter(Boolean)).toHaveLength(4);
    expect(dry.out).toContain("would-adopt");
    expect(dry.out).toContain('kept by .ws.toml keep: "../Legacy_Kept"');
    expect(dry.out).toContain("processes are working inside");
    expect(moved.code).toBe(1);
    expect(moved.out).toContain("processes are working inside");
    expect(moved.out).toContain("kept by .ws.toml");
    const registered = await jj(["workspace", "list"], path);
    for (const [i, slug] of [
      [0, "legacy-unlanded"],
      [3, "nested-work"],
    ] as const) {
      const target = wsDir(path, slug);
      expect(registered.out).toContain(`ws_${slug}`);
      expect((await jj(["status"], target)).code).toBe(0);
      expect(
        (
          await jj(["workspace", "root", "--name", `ws_${slug}`], path)
        ).out.trim(),
      ).toBe(target);
      expect(
        (await jj(["log", "--no-graph", "-r", "@", "-T", "change_id"], target))
          .out,
      ).toBe(changes[i] ?? "missing change id");
      expect(await Bun.file(join(target, "unlanded.txt")).text()).toBe(
        `${old[i]}\n`,
      );
      expect(
        await Bun.file(join(parent, old[i] ?? "", ".jj", "repo")).exists(),
      ).toBe(false);
    }
    for (const name of ["Legacy_Kept", "Legacy_Live"])
      expect((await jj(["status"], join(parent, name))).code).toBe(0);
    const kept = await ws(
      [
        "adopt",
        join(parent, "Legacy_Kept"),
        "--include-kept",
        "--slug",
        "Chosen_Name",
      ],
      path,
    );
    expect(kept.code, kept.err).toBe(0);
    expect(kept.out).toContain(
      'update .ws.toml keep "../Legacy_Kept" to "../proj.ws/ws_chosen-name"',
    );
    expect((await jj(["status"], wsDir(path, "chosen-name"))).code).toBe(0);
  });

  test("dry run leaves files and operation unchanged; refuses collisions and invalid selection", async () => {
    const path = await repo();
    const dir = join(path, "..", "Legacy");
    expect(
      (await jj(["workspace", "add", "--name", "legacy", dir], path)).code,
    ).toBe(0);
    const op = () =>
      jj(
        [
          "--ignore-working-copy",
          "op",
          "log",
          "--no-graph",
          "-n",
          "1",
          "-T",
          "id",
        ],
        path,
      );
    const before = await op();
    const pointer = await Bun.file(join(dir, ".jj", "repo")).text();
    const dry = await ws(["adopt", dir, "--dry-run"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\t${wsDir(path, "legacy")}\twould-adopt`);
    expect((await op()).out).toBe(before.out);
    expect(await Bun.file(join(dir, ".jj", "repo")).text()).toBe(pointer);
    await mkdir(wsDir(path, "legacy"), { recursive: true });
    await Bun.write(join(wsDir(path, "legacy"), "sentinel"), "retain");
    const conflict = await ws(["adopt", dir], path);
    expect(conflict.code).toBe(1);
    expect(conflict.out).toContain("target already exists");
    expect(await Bun.file(join(wsDir(path, "legacy"), "sentinel")).text()).toBe(
      "retain",
    );
    expect((await jj(["status"], dir)).code).toBe(0);
    for (const args of [
      ["adopt"],
      ["adopt", "--all"],
      ["adopt", "--all", "--repo", path, dir],
      ["adopt", path],
      ["adopt", "--all", "--repo", path, "--slug", "x"],
    ])
      expect((await ws(args, path)).code).toBe(1);
  });
});

describe("agx ws add", () => {
  test("JSON output stays machine readable through install chatter and reuse", async () => {
    const chatter =
      "30 packages installed …\n$HOME/consumer.ws/ws_fleet-line-real'\n";
    const command = `printf '%s' '${chatter.replaceAll("'", "'\\''")}'`;
    const path = await repo(`ready = [${JSON.stringify(command)}]\n`);
    const created = await ws(["add", "fleet-line-real", "--json"], path);
    expect(created.code, created.err).toBe(0);
    const createdJson = jsonOf(
      z.looseObject({
        workspace: z.string(),
        base: z.looseObject({
          change_id: z.string(),
          commit_id: z.string(),
          ref: z.string(),
          fetch_succeeded: z.null(),
          fetch: z.literal("no remote"),
        }),
      }),
    ).safeParse(created.out);
    expect(createdJson.success).toBe(true);
    if (!createdJson.success) return;
    expect(createdJson.data).toMatchObject({
      workspace: wsDir(path, "fleet-line-real"),
    });
    expect(created.err).toContain(chatter);
    const reused = await ws(
      ["add", "fleet-line-real", "--reuse", "--json"],
      path,
    );
    expect(reused.code, reused.err).toBe(0);
    const reusedJson = jsonOf(
      z.looseObject({ workspace: z.string() }),
    ).safeParse(reused.out);
    expect(reusedJson.success).toBe(true);
    if (!reusedJson.success) return;
    expect(reusedJson.data).toEqual({
      workspace: wsDir(path, "fleet-line-real"),
    });
    expect(reused.err).not.toContain(chatter);
  });

  test("fetches remote trunk, prefers a descendant local trunk, and supports failed-fetch recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-fresh-base-"));
    const bare = join(root, "remote.git");
    const seed = join(root, "seed");
    const path = join(root, "clone");
    const git = async (args: string[], cwd = root) =>
      run(["git", ...args], cwd);
    const jjIn = async (args: string[], cwd = path) => jj(args, cwd);
    const gitUser = [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
    ];
    expect((await git(["init", "--bare", bare])).code).toBe(0);
    expect((await git(["clone", bare, seed])).code).toBe(0);
    expect(
      (await git([...gitUser, "-C", seed, "switch", "-c", "alpha"])).code,
    ).toBe(0);
    await Bun.write(join(seed, "base.txt"), "base\n");
    await Bun.write(join(seed, ".ws.toml"), 'trunk = "alpha"\n');
    expect((await git(["-C", seed, "add", "base.txt"])).code).toBe(0);
    expect((await git(["-C", seed, "add", "-f", ".ws.toml"])).code).toBe(0);
    expect(
      (await git([...gitUser, "-C", seed, "commit", "-m", "base"])).code,
    ).toBe(0);
    expect(
      (await git(["-C", seed, "push", "-u", "origin", "alpha"])).code,
    ).toBe(0);
    expect(
      (
        await git([
          "--git-dir",
          bare,
          "symbolic-ref",
          "HEAD",
          "refs/heads/alpha",
        ])
      ).code,
    ).toBe(0);
    expect((await jj(["git", "clone", bare, path], root)).code).toBe(0);
    expect(await Bun.file(join(path, ".ws.toml")).text()).toBe(
      'trunk = "alpha"\n',
    );
    expect(
      (await jjIn(["bookmark", "untrack", "alpha", "--remote", "origin"])).code,
    ).toBe(0);
    const base = (
      await jjIn(["log", "--no-graph", "-r", "alpha@origin", "-T", "commit_id"])
    ).out.trim();

    await Bun.write(join(seed, "remote.txt"), "remote\n");
    expect((await git(["-C", seed, "add", "remote.txt"])).code).toBe(0);
    expect(
      (await git([...gitUser, "-C", seed, "commit", "-m", "remote advance"]))
        .code,
    ).toBe(0);
    expect((await git(["-C", seed, "push", "origin", "alpha"])).code).toBe(0);
    const remote = await ws(["add", "remote-new", "--json"], path);
    expect(remote.code, remote.err).toBe(0);
    const receiptSchema = jsonOf(
      z.looseObject({
        workspace: z.string(),
        base: z.looseObject({
          commit_id: z.string(),
          ref: z.string(),
          fetch: z.string(),
        }),
      }),
    );
    const remoteReceipt = receiptSchema.safeParse(remote.out);
    expect(remoteReceipt.success).toBe(true);
    if (!remoteReceipt.success) return;
    expect(remoteReceipt.data.base.commit_id).not.toBe(base);
    expect(remoteReceipt.data.base.ref).toBe("alpha@origin");
    expect(remoteReceipt.data.base.fetch).toBe("succeeded");

    await jjIn(["new", "alpha@origin"]);
    const setLocalAdvance = await jjIn(["bookmark", "set", "alpha", "-r", "@"]);
    expect(setLocalAdvance.code, setLocalAdvance.err).toBe(0);
    const local = await ws(["add", "local-new", "--json"], path);
    expect(local.code, local.err).toBe(0);
    const localReceipt = receiptSchema.safeParse(local.out);
    expect(localReceipt.success).toBe(true);
    if (!localReceipt.success) return;
    expect(localReceipt.data.base.ref).toBe("alpha");
    expect(localReceipt.data.base.commit_id).toBe(
      (
        await jjIn(["log", "--no-graph", "-r", "alpha", "-T", "commit_id"])
      ).out.trim(),
    );

    expect(
      (
        await jjIn([
          "git",
          "remote",
          "set-url",
          "origin",
          join(root, "missing.git"),
        ])
      ).code,
    ).toBe(0);
    const failed = await ws(["add", "fetch-fails", "--json"], path);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain("--no-fetch");
    const unfetched = await ws(
      ["add", "unfetched", "--json", "--no-fetch"],
      path,
    );
    expect(unfetched.code, unfetched.err).toBe(0);
    const unfetchedReceipt = receiptSchema.safeParse(unfetched.out);
    expect(unfetchedReceipt.success).toBe(true);
    if (!unfetchedReceipt.success) return;
    expect(unfetchedReceipt.data.base.fetch).toBe("unfetched");
    expect(unfetchedReceipt.data.base.commit_id).toBe(
      localReceipt.data.base.commit_id,
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("uses sparse . even when the source workspace is narrowed", async () => {
    const path = await repo('ready = ["jj sparse list > sparse.out"]\n');
    await Bun.write(join(path, "artifact.txt"), "tracked artifact\n");
    expect((await jj(["commit", "-m", "artifact"], path)).code).toBe(0);
    expect(
      (
        await jj(
          ["sparse", "set", "--clear", "--add", "a.txt", "--add", ".ws.toml"],
          path,
        )
      ).code,
    ).toBe(0);
    const r = await ws(["add", "complete"], path);
    expect(r.code, r.err).toBe(0);
    expect(
      (await jj(["sparse", "list"], wsDir(path, "complete"))).out.trim(),
    ).toBe(".");
    expect(
      await Bun.file(join(wsDir(path, "complete"), "artifact.txt")).text(),
    ).toBe("tracked artifact\n");
    expect(
      await Bun.file(join(wsDir(path, "complete"), "sparse.out")).text(),
    ).toBe(".\n");
  });

  test("refreshes a stale source before adding another slug and running readiness", async () => {
    const path = await repo('ready = ["jj status > ready.out"]\n');
    expect((await ws(["add", "source"], path)).code).toBe(0);
    const dir = wsDir(path, "source");
    expect((await jj(["new", "root()"], path)).code).toBe(0);
    await Bun.write(join(path, "destination.txt"), "destination\n");
    await Bun.write(
      join(path, ".ws.toml"),
      'ready = ["jj status > ready.out"]\n',
    );
    expect((await jj(["rebase", "-s", "main", "-d", "@"], path)).code).toBe(0);
    const stale = await jj(["status"], dir);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("working copy is stale");
    const r = await ws(["add", "next"], dir);
    expect(r.code, r.err).toBe(0);
    expect((await jj(["status"], dir)).code).toBe(0);
    expect((await jj(["status"], wsDir(path, "next"))).code).toBe(0);
    expect(
      await Bun.file(join(wsDir(path, "next"), "ready.out")).exists(),
    ).toBe(true);
  });

  test("trusts mise.toml without a readiness declaration", async () => {
    const path = await repo();
    await Bun.write(
      join(path, "mise.toml"),
      '[env]\nWS_TRUST_FIXTURE = "ready"\n',
    );
    expect(
      (await jj(["commit", "-m", "mise without readiness"], path)).code,
    ).toBe(0);
    const r = await ws(["add", "demo"], path);
    expect(r.code, r.err).toBe(0);
    const config = join(wsDir(path, "demo"), "mise.toml");
    const shown = await run(["mise", "trust", "--show"], wsDir(path, "demo"));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`${config}: trusted`);
    expect(r.err).toContain(`ws: ready: trusted ${config}`);
  });

  test.each([
    ["all tools are installed", "0", false],
    ["a tool is missing", "1", true],
  ] as const)(
    "checks mise before install when %s",
    async (_label, code, install) => {
      const path = await repo('ready = ["echo ready > ready.out"]\n');
      await Bun.write(join(path, "mise.toml"), '[tools]\nbun = "1.2.0"\n');
      expect(
        (await jj(["commit", "-m", "mise install fixture"], path)).code,
      ).toBe(0);

      const fakeBin = join(scratch, `fake-mise-${++counter}`);
      const log = join(scratch, `fake-mise-${counter}.log`);
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, "mise"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1 $2" = "install --dry-run-code" ]; then exit "$MISSING_EXIT"; fi\nexit 0\n`,
      );
      chmodSync(join(fakeBin, "mise"), 0o755);
      const result = await ws(
        ["add", "mise-check"],
        path,
        baseEnv({
          PATH: `${fakeBin}:${bin}:${process.env.PATH}`,
          MISSING_EXIT: code,
        }),
      );
      expect(result.code, result.err).toBe(0);
      const calls = await Bun.file(log).text();
      expect(calls).toContain("install --dry-run-code");
      expect(calls.includes("\ninstall\n")).toBe(install);
      expect(
        await Bun.file(join(wsDir(path, "mise-check"), "ready.out")).exists(),
      ).toBe(true);
    },
  );

  test.each(["mise.toml", ".mise.toml"])(
    "trusts %s before readiness with isolated mise state",
    async (config) => {
      const path = await repo('ready = ["mise env --json > ready.json"]\n');
      await Bun.write(
        join(path, config),
        '[env]\nWS_TRUST_FIXTURE = "ready"\n',
      );
      expect((await jj(["commit", "-m", "mise fixture"], path)).code).toBe(0);
      const r = await ws(["add", "demo"], path);
      expect(r.code, r.err).toBe(0);
      const dir = wsDir(path, "demo");
      expect(r.err).toContain(`ws: ready: trusted ${join(dir, config)}`);
      const shown = await run(["mise", "trust", "--show"], dir);
      expect(shown.code).toBe(0);
      expect(shown.out).toContain(`${join(dir, config)}: trusted`);
      const env = jsonOf(
        z.looseObject({ WS_TRUST_FIXTURE: z.literal("ready") }),
      ).safeParse(await Bun.file(join(dir, "ready.json")).text());
      expect(env.success).toBe(true);
    },
  );

  test("runs declared trust for an additional config before returning the workspace", async () => {
    const path = await repo('ready = ["mise trust -q nested/mise.toml"]\n');
    await Bun.write(
      join(path, "mise.toml"),
      '[env]\nWS_TRUST_FIXTURE = "root"\n',
    );
    await Bun.write(
      join(path, "nested/mise.toml"),
      '[env]\nWS_TRUST_NESTED = "nested"\n',
    );
    expect((await jj(["commit", "-m", "nested mise fixture"], path)).code).toBe(
      0,
    );
    const r = await ws(["add", "nested"], path);
    expect(r.code).toBe(0);
    const dir = wsDir(path, "nested");
    expect(r.err).toContain(`ws: ready: trusted ${join(dir, "mise.toml")}`);
    expect(r.err).toContain("ws: ready: mise trust -q nested/mise.toml");
    const shown = await run(["mise", "trust", "--show"], join(dir, "nested"));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`${join(dir, "mise.toml")}: trusted`);
    expect(shown.out).toContain(`${join(dir, "nested/mise.toml")}: trusted`);
  });

  test("a failed mise trust is loud and rolls back before readiness", async () => {
    const path = await repo('ready = ["echo ran > ready.out"]\n');
    await Bun.write(
      join(path, "mise.toml"),
      '[env]\nWS_TRUST_FIXTURE = "ready"\n',
    );
    expect(
      (await jj(["commit", "-m", "mise failure fixture"], path)).code,
    ).toBe(0);
    // A regular file cannot hold mise's state directory, even when tests run as root.
    const blocked = join(scratch, "blocked-state");
    await Bun.write(blocked, "not a directory\n");
    const r = await ws(
      ["add", "blocked"],
      path,
      baseEnv({ MISE_STATE_DIR: blocked }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("mise trust");
    expect(r.err).toContain("the new workspace was removed");
    expect(r.err).not.toContain("ws: ready: echo ran");
    expect(
      await Bun.file(
        join(wsDir(path, "blocked"), ".jj/working_copy/type"),
      ).exists(),
    ).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_blocked",
    );
  });

  test("creates the declared path, names the workspace after it, runs readiness", async () => {
    const path = await repo(
      'trunk = "main"\nready = ["pwd > ready.out", "echo done >> ready.out"]\n',
    );
    const r = await ws(["add", "alpha"], path);
    expect(r.code).toBe(0);
    const dir = wsDir(path, "alpha");
    expect(r.out.trim()).toBe(join(path, "..", "proj.ws", "ws_alpha"));
    expect(existsSync(join(dir, ".jj"))).toBe(true);
    expect(await Bun.file(join(dir, "ready.out")).text()).toContain("done");
    expect((await jj(["workspace", "list"], path)).out).toContain("ws_alpha");
  });

  test("add and dry-run leave verdict publication to real gc outside the repository and workspace directory", async () => {
    const path = await repo('trunk = "main"\n');
    const state = join(scratch, "explicit-verdict-state");
    const env = baseEnv({ AGX_STATE_DIR: state });
    const verdictPath = join(state, "workspace-verdicts.json");
    const before = listing(join(path, ".."));
    const added = await ws(["add", "s1"], path, env);
    expect(added.code, added.err).toBe(0);
    expect(listing(join(path, "..", "proj.ws"))).toEqual(["ws_s1"]);
    expect(
      listing(join(path, "..")).filter((n) => !before.includes(n)),
    ).toEqual(["proj.ws"]);
    expect(await Bun.file(verdictPath).exists()).toBe(false);
    const observed = await ws(["gc", "--dry-run"], path, env);
    expect(observed.code, observed.err).toBe(0);
    expect(await Bun.file(verdictPath).exists()).toBe(false);
    const collected = await ws(["gc"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(await Bun.file(verdictPath).exists()).toBe(true);
    const observation = jsonOf(
      z.object({ fleetComplete: z.boolean() }),
    ).safeParse(await Bun.file(verdictPath).text());
    expect(observation).toMatchObject({
      success: true,
      data: { fleetComplete: false },
    });
  });

  test("WS-ADD-HANG: mise exits with retained pipes, then add returns the readiness status", async () => {
    const path = await repo(`ready = ["exit 7"]\n`);
    await Bun.write(join(path, "mise.toml"), "# fixture\n");
    expect((await jj(["commit", "-m", "mise fixture"], path)).code).toBe(0);
    const pidFile = join(scratch, "retained-pipe.pid");
    shim("mise", `sleep 30 & echo $! > "${pidFile}"; exit 0`);
    const started = performance.now();
    const r = await ws(["add", "retained-pipe"], path);
    process.kill(Number(await Bun.file(pidFile).text()), "SIGKILL");
    await unlink(join(bin, "mise"));
    expect(r.code, r.err).toBe(7);
    expect(r.err).toContain("readiness command failed (exit 7): exit 7");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(existsSync(wsDir(path, "retained-pipe"))).toBe(false);
  });

  test("a failing readiness command is loud, non-zero, and leaves no workspace", async () => {
    const path = await repo('ready = ["echo boom >&2; exit 7"]\n');
    const r = await ws(["add", "bad"], path);
    expect(r.code).toBe(7);
    expect(r.err).toContain("exit 7");
    expect(existsSync(wsDir(path, "bad"))).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain("ws_bad");
  });

  test("fails before work on unmet preconditions", async () => {
    const path = await repo();
    expect((await ws(["add", "bad/slug"], path)).code).toBe(1);
    expect((await ws(["add", "x", "--rev", "nope_no_such"], path)).code).toBe(
      1,
    );
    expect(
      (await ws(["add", "x"], path, baseEnv({ FAKE_FS: "tmpfs" }))).err,
    ).toContain("RAM-backed");
    expect(existsSync(join(path, "..", "proj.ws"))).toBe(false);
    writeFileSync(join(path, ".ws.toml"), "ready = 3\n");
    expect((await ws(["add", "x"], path)).code).toBe(1);
    expect(existsSync(join(path, "..", "proj.ws"))).toBe(false);
    expect((await ws(["add", "x"], tmpdir())).code).toBe(1);
  });

  test("refuses an existing slug", async () => {
    const path = await repo();
    expect((await ws(["add", "dup"], path)).code).toBe(0);
    expect((await ws(["add", "dup"], path)).code).toBe(1);
    const reused = await ws(["add", "dup", "--reuse"], path);
    expect(reused.code, reused.err).toBe(0);
    expect(reused.out.trim()).toBe(wsDir(path, "dup"));
  });

  test("new workspace slugs use hyphens; legacy names remain refreshable", async () => {
    const path = await repo();
    for (const slug of ["arena_g3", "Arena-G3"]) {
      const refused = await ws(["add", slug], path);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("agx ws add arena-g3");
      expect(await Bun.file(join(wsDir(path, slug), ".jj/repo")).exists()).toBe(
        false,
      );
    }
    const accepted = await ws(["add", "arena-g3"], path);
    expect(accepted.code, accepted.err).toBe(0);
    expect(accepted.out).toContain("ws_arena-g3");
    const legacy = wsDir(path, "old_name");
    expect(
      (await jj(["workspace", "add", "--name", "ws_old_name", legacy], path))
        .code,
    ).toBe(0);
    expect((await ws(["refresh", "old_name"], path)).code).toBe(0);
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_old_name",
    );
  });
});

describe("agx ws refresh", () => {
  test("updates a rebased workspace without rerunning readiness or widening sparse", async () => {
    const path = await repo('ready = ["echo ready >> ready.out"]\n');
    expect((await ws(["add", "stale"], path)).code).toBe(0);
    const dir = wsDir(path, "stale");
    expect(
      (
        await jj(
          ["sparse", "set", "--clear", "--add", "a.txt", "--add", "ready.out"],
          dir,
        )
      ).code,
    ).toBe(0);
    expect((await jj(["new", "root()"], path)).code).toBe(0);
    await Bun.write(join(path, "destination.txt"), "destination\n");
    expect((await jj(["rebase", "-s", "main", "-d", "@"], path)).code).toBe(0);
    expect((await jj(["status"], dir)).err).toContain("working copy is stale");
    const r = await ws(["refresh", "stale"], path);
    expect(r.code, r.err).toBe(0);
    expect((await jj(["status"], dir)).code).toBe(0);
    expect((await jj(["sparse", "list"], dir)).out.trim()).toBe(
      "a.txt\nready.out",
    );
    expect(await Bun.file(join(dir, "ready.out")).text()).toBe("ready\n");
    expect((await ws(["refresh", "stale"], path)).code).toBe(0);
  });

  test("refuses missing and invalid slugs", async () => {
    const path = await repo();
    expect((await ws(["refresh", "missing"], path)).code).toBe(1);
    expect((await ws(["refresh", "bad/slug"], path)).code).toBe(1);
  });
});

describe("agx ws rm", () => {
  test("removes only the removed workspace's tracked and trusted mise entries", async () => {
    const path = await repo(
      'trunk = "main"\nready = ["mise trust -q mise.toml"]\n',
    );
    await Bun.write(join(path, "mise.toml"), '[env]\nWS_FIXTURE = "yes"\n');
    expect(
      (await jj(["commit", "-m", "mise workspace fixture"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@"], path)).code).toBe(
      0,
    );
    const env = baseEnv({
      MISE_STATE_DIR: join(scratch, `mise-state-untrack-${++counter}`),
    });
    expect((await ws(["add", "removed"], path, env)).code).toBe(0);
    expect((await ws(["add", "live"], path, env)).code).toBe(0);

    const removedDir = wsDir(path, "removed");
    const liveDir = wsDir(path, "live");
    const trackedDir = join(env.MISE_STATE_DIR ?? "", "tracked-configs");
    const trustedDir = join(env.MISE_STATE_DIR ?? "", "trusted-configs");
    const trackedTargets = (): string[] => symlinkTargets(trackedDir);
    const trustedTargets = (): string[] => symlinkTargets(trustedDir);
    const removedConfig = join(removedDir, "mise.toml");
    const liveConfig = join(liveDir, "mise.toml");
    expect(trackedTargets()).toContain(removedConfig);
    expect(trackedTargets()).toContain(liveConfig);
    expect(trustedTargets()).toContain(removedConfig);
    expect(trustedTargets()).toContain(liveConfig);

    const result = await ws(["rm", "removed"], path, env);
    expect(result.code, result.err).toBe(0);
    expect(trackedTargets()).not.toContain(removedConfig);
    expect(trustedTargets()).not.toContain(removedConfig);
    expect(trackedTargets()).toContain(liveConfig);
    expect(trustedTargets()).toContain(liveConfig);
  });

  test("removes matching mise links when mise is absent from PATH", async () => {
    const path = await repo(
      'trunk = "main"\nready = ["mise trust -q mise.toml"]\n',
    );
    await Bun.write(join(path, "mise.toml"), '[env]\nWS_FIXTURE = "yes"\n');
    expect(
      (await jj(["commit", "-m", "mise no-command fixture"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@"], path)).code).toBe(
      0,
    );
    const env = baseEnv({
      MISE_STATE_DIR: join(scratch, `mise-state-no-command-${++counter}`),
    });
    expect((await ws(["add", "no-command"], path, env)).code).toBe(0);

    const misePath = Bun.which("mise");
    expect(misePath).not.toBeNull();
    const noMiseBin = join(scratch, `no-mise-bin-${counter}`);
    mkdirSync(noMiseBin);
    for (const command of ["bun", "jj", "rip"]) {
      const resolved = Bun.which(command);
      expect(resolved).not.toBeNull();
      await symlink(realpathSync(resolved ?? ""), join(noMiseBin, command));
    }
    const withoutMise = [
      noMiseBin,
      ...(env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => !existsSync(join(directory, "mise"))),
    ].join(delimiter);
    const dir = wsDir(path, "no-command");
    const config = join(dir, "mise.toml");
    const state = env.MISE_STATE_DIR ?? "";
    const removed = await ws(["rm", "no-command"], path, {
      ...env,
      PATH: withoutMise,
    });
    expect(removed.code, removed.err).toBe(0);
    expect(removed.err).toContain("mise command cleanup skipped");
    expect(symlinkTargets(join(state, "tracked-configs"))).not.toContain(
      config,
    );
    expect(symlinkTargets(join(state, "trusted-configs"))).not.toContain(
      config,
    );
  });

  test("removes a landed workspace: forgotten and ripped", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "clean"], path);
    const r = await ws(["rm", "clean"], path);
    expect(r.code).toBe(0);
    expect(existsSync(wsDir(path, "clean"))).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_clean",
    );
  });

  test("removes a workspace whose only non-trunk change is on a remote bookmark", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "pushed"], path)).code).toBe(0);
    const dir = wsDir(path, "pushed");
    await Bun.write(join(dir, "pushed.txt"), "remote has this\n");
    expect((await jj(["commit", "-m", "pushed work"], dir)).code).toBe(0);
    await pushBookmark(dir, "feature-pushed");
    const removed = await ws(["rm", "pushed"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("refuses an unlanded commit and an uncommitted edit; nothing is lost", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "dirty"], path);
    const dir = wsDir(path, "dirty");
    writeFileSync(join(dir, "work.txt"), "w\n");
    const edit = await ws(["rm", "dirty"], path);
    expect(edit.code).toBe(1);
    expect(edit.err).toContain("unlanded");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
    await jj(["commit", "-m", "work"], dir);
    const committed = await ws(["rm", "dirty"], path);
    expect(committed.code).toBe(1);
    expect(committed.err).toContain("work");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).toContain("ws_dirty");
  });

  test("uses the registered commit when the workspace-local @ cannot be read", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "registered-fallback"], path);
    const dir = wsDir(path, "registered-fallback");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-local-log-failure");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log")) {
  process.stderr.write("injected missing workspace @\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const removed = await ws(
      ["rm", "registered-fallback"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("preserves disk edits when local @ fails but the registered revision resolves", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "registered-disk-diff"], path);
    const dir = wsDir(path, "registered-disk-diff");
    await Bun.write(join(dir, "a.txt"), "unlanded disk edit\n");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-local-log-failure-with-diff");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log")) {
  process.stderr.write("injected missing workspace @\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const refused = await ws(
      ["rm", "registered-disk-diff"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("tracked files differ from main: a.txt");
    expect(existsSync(dir)).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe(
      "unlanded disk edit\n",
    );
  });

  test("refuses broken-workspace removal when a trunk-tracked file differs on disk", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "broken-diff"], path);
    const dir = wsDir(path, "broken-diff");
    await Bun.write(join(dir, "a.txt"), "changed on disk\n");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-broken-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const local = process.cwd() === ${JSON.stringify(dir)} && args.includes("log");
const registered = args.includes("log") && args.some((arg) => arg.includes("broken-diff@"));
if (local || registered) {
  process.stderr.write("injected missing working-copy revision\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const refused = await ws(
      ["rm", "broken-diff"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("tracked files differ from main: a.txt");
    expect(existsSync(dir)).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("changed on disk\n");
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_broken-diff",
    );
  });

  test("forgets and buries a broken workspace when trunk-tracked files match", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "broken-clean"], path);
    const dir = wsDir(path, "broken-clean");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-broken-clean-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const local = process.cwd() === ${JSON.stringify(dir)} && args.includes("log");
const registered = args.includes("log") && args.some((arg) => arg.includes("broken-clean@"));
if (local || registered) {
  process.stderr.write("injected missing working-copy revision\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const removed = await ws(
      ["rm", "broken-clean"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_broken-clean",
    );
  });

  test("removes unregistered broken directories only when trunk files match", async () => {
    const path = await repo();
    const changed = wsDir(path, "orphan-changed");
    const clean = wsDir(path, "orphan-clean");
    await mkdir(changed, { recursive: true });
    await mkdir(clean, { recursive: true });
    await Bun.write(join(changed, "a.txt"), "unlanded disk edit\n");
    await Bun.write(join(clean, "a.txt"), "a\n");
    const refused = await ws(["rm", "orphan-changed"], path);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("tracked files differ from trunk(): a.txt");
    expect(existsSync(changed)).toBe(true);
    const removed = await ws(["rm", "orphan-clean"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(clean)).toBe(false);
  });

  test("gc classifies from aggregate revisions without a local @ query", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "missing-revision"], path);
    setRecords([]);
    const dir = wsDir(path, "missing-revision");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-missing-working-copy-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log") && args.includes("@")) {
  process.stderr.write("working copy revision missing\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const report = await ws(
      ["gc", "--dry-run", "--include-unrecorded"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(report.code, report.err).toBe(0);
    expect(report.out).toContain(`${dir}\tws\tremovable\t`);
  });

  test("gc classifies from aggregate revisions without a local status query", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "status-missing-revision"], path);
    setRecords([]);
    const dir = wsDir(path, "status-missing-revision");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-status-missing-working-copy-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("status")) {
  process.stderr.write("working copy revision missing\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const report = await ws(
      ["gc", "--dry-run", "--include-unrecorded"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(report.code, report.err).toBe(0);
    expect(report.out).toContain(`${dir}\tws\tremovable\t`);
  });

  test("gc reports broken metadata when jj no longer has the workspace checkout pointer", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "missing-checkout-pointer"], path);
    await ws(["add", "healthy"], path);
    setRecords([]);
    const dir = wsDir(path, "missing-checkout-pointer");
    const healthy = wsDir(path, "healthy");
    await unlink(join(dir, ".jj", "working_copy", "checkout"));
    const report = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(report.code, report.err).toBe(1);
    expect(report.out).toContain(`${dir}\tws\tbroken\t`);
    expect(report.out).toContain("workspace metadata is invalid");
    expect(report.out).toContain(`${healthy}\tws\tremovable\t`);
  });

  test("gc reports broken when jj cannot resolve a corrupted checkout id", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "corrupt-checkout-id"], path);
    await ws(["add", "healthy"], path);
    setRecords([]);
    const dir = wsDir(path, "corrupt-checkout-id");
    const healthy = wsDir(path, "healthy");
    await Bun.write(
      join(dir, ".jj", "working_copy", "checkout"),
      "not-a-jj-checkout-id\n",
    );
    const status = await jj(["--ignore-working-copy", "status"], dir);
    expect(status.code).not.toBe(0);
    const report = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(report.code, report.err).toBe(1);
    expect(report.out).toContain(`${dir}\tws\tbroken\t`);
    expect(report.out).toContain(
      "checkout does not identify ws_corrupt-checkout-id",
    );
    expect(report.out).toContain(`${healthy}\tws\tremovable\t`);
  });

  test("rm forgets and buries a registered workspace with a missing checkout pointer", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "missing-checkout-rm"], path);
    const dir = wsDir(path, "missing-checkout-rm");
    await unlink(join(dir, ".jj", "working_copy", "checkout"));
    const removed = await ws(["rm", "missing-checkout-rm"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_missing-checkout-rm",
    );
  });

  test("refuses when the graveyard is RAM-backed", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "ram"], path);
    const r = await ws(["rm", "ram"], path, baseEnv({ FAKE_FS: "ramfs" }));
    expect(r.code).toBe(1);
    expect(existsSync(wsDir(path, "ram"))).toBe(true);
  });
});

describe("agx ws gc", () => {
  test("broken workspace rows do not stop dry-run or real gc", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    await ws(["add", "broken"], path);
    await ws(["add", "healthy"], path);
    const missing = wsDir(path, "broken");
    const healthy = wsDir(path, "healthy");
    rmSync(missing, { recursive: true, force: true });

    const dry = await ws(["gc", "--dry-run", "--json"], path);
    const plain = await ws(["gc", "--dry-run"], path);
    expect(plain.code, plain.err).toBe(1);
    const plainRows = plain.out
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(plainRows.filter((row) => row[2] === "broken")).toHaveLength(1);
    expect(
      plainRows.some((row) => row[0] === healthy && row[2] === "keep"),
    ).toBe(true);
    expect(dry.code, dry.err).toBe(1);
    const dryResult = gcRows.safeParse(dry.out);
    expect(dryResult.success, dry.out).toBe(true);
    if (!dryResult.success) return;
    const dryBroken = dryResult.data.rows.filter((row) => row[2] === "broken");
    expect(dryBroken).toHaveLength(1);
    expect(dryBroken[0]?.[0]).toBe(missing);
    expect(dryBroken[0]?.[5]).toContain(`directory missing: ${missing}`);
    expect(dryResult.data.broken).toEqual([missing]);
    expect(dryResult.data.complete).toBe(false);
    expect(
      dryResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "keep",
      ),
    ).toBe(true);

    const real = await ws(["gc", "--include-unrecorded", "--json"], path);
    expect(real.code, real.err).toBe(1);
    const realResult = gcRows.safeParse(real.out);
    expect(realResult.success, real.out).toBe(true);
    if (!realResult.success) return;
    expect(
      realResult.data.rows.some(
        (row) => row[0] === missing && row[2] === "broken",
      ),
    ).toBe(true);
    expect(
      realResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "removable",
      ),
    ).toBe(true);
    expect(realResult.data.broken).toEqual([missing]);
    expect(existsSync(healthy)).toBe(false);
  });

  test("multiple missing directories stay as broken rows while real gc forgets reachable records", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    const missing = [
      wsDir(path, "missing-a"),
      wsDir(path, "missing-b"),
    ] as const;
    const healthy = wsDir(path, "healthy");
    mkdirSync(join(path, "..", "proj.ws"), { recursive: true });
    for (const [slug, dir] of [
      ["missing-a", missing[0]],
      ["missing-b", missing[1]],
      ["healthy", healthy],
    ] as const) {
      expect(
        (
          await jj(
            ["workspace", "add", "--name", `ws_${slug}`, "-r", "main", dir],
            path,
          )
        ).code,
      ).toBe(0);
    }
    expect(
      (await jj(["new", "ws_missing-a@", "ws_missing-b@"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@"], path)).code).toBe(
      0,
    );
    for (const dir of missing) rmSync(dir, { recursive: true, force: true });

    const dry = await ws(
      ["gc", "--dry-run", "--include-unrecorded", "--json"],
      path,
    );
    expect(dry.code, dry.err).toBe(1);
    const dryResult = gcRows.safeParse(dry.out);
    expect(dryResult.success, dry.out).toBe(true);
    if (!dryResult.success) return;
    expect(dryResult.data.rows).toHaveLength(4);
    expect(
      dryResult.data.rows.filter((row) => row[2] === "broken"),
    ).toHaveLength(2);
    for (const dir of missing)
      expect(dryResult.data.rows.find((row) => row[0] === dir)?.[5]).toContain(
        `directory missing: ${dir}`,
      );
    expect(
      dryResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "removable",
      ),
    ).toBe(true);

    const real = await ws(["gc", "--include-unrecorded", "--json"], path);
    expect(real.code, real.err).toBe(1);
    const realResult = gcRows.safeParse(real.out);
    expect(realResult.success, real.out).toBe(true);
    if (!realResult.success) return;
    expect(realResult.data.rows).toHaveLength(4);
    expect(
      realResult.data.rows.filter((row) => row[2] === "broken"),
    ).toHaveLength(2);
    expect(
      realResult.data.rows.find((row) => row[0] === missing[0])?.[5],
    ).toContain("workspace record forgotten");
    expect(
      realResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "removable",
      ),
    ).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_missing-a",
    );
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_missing-b",
    );
    expect(existsSync(healthy)).toBe(false);
  });

  test("a missing workspace with an unpushed commit keeps its jj record", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    const missing = wsDir(path, "missing-unpushed");
    mkdirSync(join(path, "..", "proj.ws"), { recursive: true });
    expect(
      (
        await jj(
          [
            "workspace",
            "add",
            "--name",
            "ws_missing-unpushed",
            "-r",
            "main",
            missing,
          ],
          path,
        )
      ).code,
    ).toBe(0);
    await Bun.write(join(missing, "unpushed.txt"), "keep this commit\n");
    expect((await jj(["commit", "-m", "unpushed"], missing)).code).toBe(0);
    rmSync(missing, { recursive: true, force: true });

    const real = await ws(["gc", "--include-unrecorded", "--json"], path);
    expect(real.code, real.err).toBe(1);
    const result = gcRows.safeParse(real.out);
    expect(result.success, real.out).toBe(true);
    if (!result.success) return;
    const row = result.data.rows.find((candidate) => candidate[0] === missing);
    expect(row?.[2]).toBe("broken");
    expect(row?.[5]).toContain(`directory missing: ${missing}`);
    expect(row?.[5]).toContain(
      "workspace commit is not reachable from trunk or a remote bookmark",
    );
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_missing-unpushed",
    );
  });

  test("reports the retaining remote bookmark and collects a pushed-only workspace", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "pushed-gc"], path)).code).toBe(0);
    const dir = wsDir(path, "pushed-gc");
    await Bun.write(join(dir, "pushed.txt"), "remote has this\n");
    expect((await jj(["commit", "-m", "pushed work"], dir)).code).toBe(0);
    await pushBookmark(dir, "feature-gc-pushed");
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tremovable\t`);
    expect(dry.out).toContain("feature-gc-pushed@origin");
    const collected = await ws(["gc", "--include-unrecorded"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("help explains where and how to declare kept workspaces", async () => {
    const path = await repo();
    const result = await ws(["gc", "--help"], path);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('keep = ["ws_<name>"]');
    expect(result.out).toContain('keep = ["ws_reference"]');
    expect(result.out).toContain("main checkout root `.ws.toml`");
    expect(result.out).toContain("parent revision");
    expect(result.out).toContain(
      "Unreadable workspaces are reported as broken",
    );
    expect(result.out).toContain("--inventory-seconds");
    expect(result.out).toContain("default: 10");
  });

  test("reports narrowed sparse patterns even for an unrecorded workspace", async () => {
    const path = await repo('trunk = "main"\n');
    await Bun.write(join(path, "b.txt"), "tracked too\n");
    expect((await jj(["commit", "-m", "second tracked file"], path)).code).toBe(
      0,
    );
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    expect((await ws(["add", "narrow"], path)).code).toBe(0);
    const dir = wsDir(path, "narrow");
    expect(
      (await jj(["sparse", "set", "--clear", "--add", "a.txt"], dir)).code,
    ).toBe(0);
    setRecords([]);
    const r = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toContain(`${dir}\tws\tkeep\t`);
    expect(r.out).toContain("sparse or missing tracked file:");
    expect((await jj(["sparse", "list"], dir)).out.trim()).toBe("a.txt");
  });

  const rec = (path: string, slug: string, over: object) => ({
    id: `run-${slug}`,
    state: "ended",
    cwd: wsDir(path, slug),
    workspace: wsDir(path, slug),
    continues: null,
    judgment: { decision: "reject" },
    ...over,
  });

  test("collects exactly terminal lineages with nothing unlanded; keeps live, continuing, unlanded", async () => {
    const path = await repo('trunk = "main"\n');
    for (const s of ["done", "live", "cont", "dirty", "orph"])
      await ws(["add", s], path);
    writeFileSync(join(wsDir(path, "dirty"), "w.txt"), "w\n");
    // Dry-run classification reads saved jj state; explicitly snapshot this fixture's work.
    expect((await jj(["status"], wsDir(path, "dirty"))).code).toBe(0);
    setRecords([
      rec(path, "done", {}),
      rec(path, "live", { state: "running" }),
      rec(path, "cont", { id: "run-cont-1" }),
      {
        ...rec(path, "cont", {
          id: "run-cont-2",
          state: "running",
          continues: "run-cont-1",
        }),
        cwd: "/elsewhere",
        workspace: "/elsewhere",
      },
      rec(path, "dirty", {}),
      rec(path, "orph", { state: "orphaned" }),
    ]);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.code).toBe(0);
    const verdict = Object.fromEntries(
      dry.out
        .trim()
        .split("\n")
        .map((l) => l.split("\t"))
        .map(([d, , v]) => [d?.split("/").pop() ?? "", v ?? ""] as const),
    );
    expect(verdict).toEqual({
      proj: "keep",
      ws_done: "removable",
      ws_live: "keep",
      ws_cont: "keep",
      ws_dirty: "keep",
      ws_orph: "removable",
    });
    for (const s of ["done", "live", "cont", "dirty", "orph"])
      expect(existsSync(wsDir(path, s))).toBe(true);
    const real = await ws(["gc"], path);
    expect(real.code).toBe(0);
    expect(existsSync(wsDir(path, "done"))).toBe(false);
    expect(existsSync(wsDir(path, "orph"))).toBe(false);
    for (const s of ["live", "cont", "dirty"])
      expect(existsSync(wsDir(path, s))).toBe(true);
    expect(existsSync(join(wsDir(path, "dirty"), "w.txt"))).toBe(true);
    expect(listing(join(path, "..", "proj.ws"))).toEqual([
      "ws_cont",
      "ws_dirty",
      "ws_live",
    ]);
  });

  test("an obsolete run-end commit does not retain a workspace with no current content", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "ended"], path);
    const dir = wsDir(path, "ended");
    writeFileSync(join(dir, "w.txt"), "w\n");
    await jj(["commit", "-m", "run work"], dir);
    const end = (
      await jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], dir)
    ).out.trim();
    await jj(["new", "main"], dir);
    setRecords([rec(path, "ended", { end_commit: end })]);
    const r = await ws(["gc"], path);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${dir}\tws\tremovable\t`);
    expect(existsSync(dir)).toBe(false);
  });

  test("unrecorded workspaces are reported, collected only with --include-unrecorded and no diff", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "clean"], path);
    await ws(["add", "diff"], path);
    writeFileSync(join(wsDir(path, "diff"), "w.txt"), "w\n");
    setRecords([]);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.out).toContain("unrecorded");
    expect(dry.out).not.toContain("would-collect");
    const plain = await ws(["gc"], path);
    expect(plain.code).toBe(0);
    expect(existsSync(wsDir(path, "clean"))).toBe(true);
    const wide = await ws(["gc", "--include-unrecorded"], path);
    expect(wide.code).toBe(0);
    expect(existsSync(wsDir(path, "clean"))).toBe(false);
    expect(existsSync(wsDir(path, "diff"))).toBe(true);
  });

  test("young unrecorded workspaces survive include-unrecorded unless grace is zero", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "young"], path)).code).toBe(0);
    const young = wsDir(path, "young");
    setRecords([]);

    const protectedRun = await run(
      ["bun", WS, "gc", "--include-unrecorded", "--dry-run"],
      path,
      baseEnv(),
    );
    expect(protectedRun.code, protectedRun.err).toBe(0);
    expect(protectedRun.out).toContain(`${young}\tws\tkeep\t`);
    expect(protectedRun.out).toContain("created ");
    expect(protectedRun.out).toContain("; grace 30 min");

    const retained = await run(
      ["bun", WS, "gc", "--include-unrecorded"],
      path,
      baseEnv(),
    );
    expect(retained.code, retained.err).toBe(0);
    expect(retained.out).toContain(`${young}\tws\tkeep\t`);
    expect(existsSync(young)).toBe(true);

    const disabled = await ws(
      ["gc", "--include-unrecorded", "--grace-minutes", "0"],
      path,
    );
    expect(disabled.code, disabled.err).toBe(0);
    expect(disabled.out).toContain(`${young}\tws\tremovable\t`);
    expect(existsSync(young)).toBe(false);
  });

  test("gc help documents the workspace grace period", async () => {
    const path = await repo('trunk = "main"\n');
    const help = await ws(["gc", "--help"], path);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--grace-minutes");
    expect(help.out).toContain("default: 30; 0 disables");
  });

  test("legacy workspaces require --legacy even with --include-unrecorded", async () => {
    const path = await repo('trunk = "main"\n');
    const legacy = join(path, "..", "proj-ws-old");
    expect(
      (await jj(["workspace", "add", "--name", "old", legacy], path)).code,
    ).toBe(0);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.out).toContain(`${legacy}\tlegacy\tkeep\t`);
    expect(dry.out).toContain("pass --legacy to collect");
    expect((await ws(["gc", "--include-unrecorded"], path)).code).toBe(0);
    expect(existsSync(legacy)).toBe(true);
    expect((await ws(["gc", "--legacy"], path)).code).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  });

  test("refuses, even as a dry run, when the graveyard is RAM-backed or agx fails", async () => {
    const path = await repo('trunk = "main"\n');
    const ram = await ws(
      ["gc", "--dry-run"],
      path,
      baseEnv({ FAKE_FS: "tmpfs" }),
    );
    expect(ram.code).toBe(1);
    expect(ram.err).toContain("RAM-backed");
    shim("agx", "echo broken >&2; exit 3");
    const broken = await ws(["gc", "--dry-run"], path);
    expect(broken.code).toBe(1);
    shim("agx", `cat "${records}"`);
  });
});

describe("WS-GC-JJ-LIST", () => {
  test("enumerates six registered layouts, repairs stale, protects keep, forgets before rip", async () => {
    const path = await repo('trunk = "main"\nkeep = ["precious"]\n');
    setRecords([]);
    expect((await ws(["add", "modern"], path)).code).toBe(0);
    const dirs = {
      modern: wsDir(path, "modern"),
      empty: join(scratch, "legacy-empty"),
      landed: join(scratch, "arbitrary-layout", "landed"),
      unlanded: join(scratch, "Workspace", "proj-arm-work"),
      stale: join(scratch, "proj-arm-agx-stale"),
      precious: join(scratch, "owner-must-keep"),
    };
    await mkdir(join(scratch, "arbitrary-layout"), { recursive: true });
    await mkdir(join(scratch, "Workspace"), { recursive: true });
    for (const name of [
      "empty",
      "landed",
      "unlanded",
      "stale",
      "precious",
    ] as const) {
      const added = await jj(
        ["workspace", "add", "--name", name, "-r", "main", dirs[name]],
        path,
      );
      expect(added.code, added.err).toBe(0);
    }
    // A squash-style landing: the same diff on a different commit, without ancestry.
    await Bun.write(join(dirs.landed, "landed.txt"), "landed work\n");
    expect((await jj(["status"], dirs.landed)).code).toBe(0);
    await Bun.write(join(path, "landed.txt"), "landed work\n");
    expect((await jj(["commit", "-m", "squash landing"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    await Bun.write(join(dirs.unlanded, "unlanded.txt"), "must survive\n");
    await Bun.write(join(dirs.stale, "stale.txt"), "stale work\n");
    expect((await jj(["status"], dirs.stale)).code).toBe(0);
    expect((await jj(["status"], dirs.unlanded)).code).toBe(0);
    expect(
      (await jj(["restore", "--from", "unlanded@", "--to", "stale@"], path))
        .code,
    ).toBe(0);
    expect((await jj(["status"], dirs.stale)).err).toContain(
      "working copy is stale",
    );
    const outsider = await repo('trunk = "main"\n');
    expect((await ws(["add", "outside"], outsider)).code).toBe(0);
    const outsideBefore = (await jj(["workspace", "list"], outsider)).out;
    const dry = await ws(["gc", "--dry-run", "--legacy"], path);
    expect(dry.code, dry.err).toBe(0);
    const rows = dry.out
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(rows).toHaveLength(7);
    const machine = await ws(["gc", "--dry-run", "--legacy", "--json"], path);
    expect(machine.code, machine.err).toBe(0);
    expect(
      jsonOf(
        z.object({
          counts: z.object({
            total: z.number(),
            unlanded: z.number(),
            collectable: z.number(),
            legacy: z.number(),
          }),
          complete: z.boolean(),
        }),
      ).safeParse(machine.out),
    ).toMatchObject({
      success: true,
      data: {
        counts: { total: 7, unlanded: 3, collectable: 1, legacy: 5 },
        complete: true,
      },
    });
    expect(
      Object.fromEntries(
        rows.map(([dir, kind, verdict]) => [dir, [kind, verdict]]),
      ),
    ).toEqual({
      [path]: ["main", "keep"],
      [dirs.modern]: ["ws", "keep"],
      [dirs.empty]: ["legacy", "removable"],
      [dirs.landed]: ["legacy", "keep"],
      [dirs.unlanded]: ["legacy", "keep"],
      [dirs.stale]: ["legacy", "keep"],
      [dirs.precious]: ["legacy", "keep"],
    });
    expect(dry.out).toContain("unlanded change");
    expect(dry.out).not.toContain("untracked content: 1 files (stale.txt)");
    // A row retained by aggregate reachability is not walked; stale repair remains explicit.
    expect((await jj(["status"], dirs.stale)).err).toContain(
      "working copy is stale",
    );
    expect((await jj(["workspace", "update-stale"], dirs.stale)).code).toBe(0);
    for (const dir of Object.values(dirs))
      expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    const plain = await ws(["gc"], path);
    expect(plain.code, plain.err).toBe(0);
    expect(await Bun.file(join(dirs.empty, "a.txt")).exists()).toBe(true);

    // A real executable shim refuses burial unless jj has already forgotten that path.
    const tracedBin = join(scratch, "traced-bin");
    await mkdir(tracedBin);
    const trace = join(scratch, "rip-trace");
    const rip = Bun.which("rip");
    expect(rip).not.toBeNull();
    const wrapper = join(tracedBin, "rip");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun
const p = Bun.spawn(["jj", "-R", ${JSON.stringify(path)}, "--ignore-working-copy", "workspace", "list", "-T", 'root ++ "\\n"'], {stdout:"pipe",stderr:"pipe"});
const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
if (code !== 0 || out.split("\\n").includes(process.argv[2])) { process.stderr.write(err || "workspace still registered"); process.exit(9); }
const old = Bun.file(${JSON.stringify(trace)}); await Bun.write(old, ((await old.exists()) ? await old.text() : "") + process.argv[2] + "\\n");
const child = Bun.spawn([${JSON.stringify(rip)}, ...process.argv.slice(2)], {stdout:"inherit",stderr:"inherit"}); process.exit(await child.exited);
`,
    );
    await chmod(wrapper, 0o755);
    const collected = await ws(
      ["gc", "--legacy"],
      path,
      baseEnv({ PATH: `${tracedBin}:${bin}:${process.env.PATH}` }),
    );
    expect(collected.code, collected.err).toBe(0);
    const ripped = (await Bun.file(trace).text()).trim().split("\n");
    expect(ripped).toHaveLength(1);
    const tombstone = ripped[0];
    expect(tombstone).toBeDefined();
    if (tombstone === undefined) return;
    expect(tombstone.startsWith(join(scratch, ".agx-ws-tombstone-"))).toBe(
      true,
    );
    expect(await pathExists(tombstone)).toBe(false);
    const registered = (
      await jj(["workspace", "list", "-T", 'name ++ "\\n"'], path)
    ).out
      .trim()
      .split("\n");
    expect(registered).toEqual([
      "default",
      "landed",
      "precious",
      "stale",
      "unlanded",
      "ws_modern",
    ]);
    for (const name of ["empty"] as const)
      expect(await Bun.file(join(dirs[name], "a.txt")).exists()).toBe(false);
    for (const name of [
      "modern",
      "landed",
      "unlanded",
      "stale",
      "precious",
    ] as const)
      expect(await Bun.file(join(dirs[name], "a.txt")).exists()).toBe(true);
    expect(collected.out).toContain(`${dirs.unlanded}\tlegacy\tkeep\t`);
    expect(await Bun.file(join(dirs.unlanded, "unlanded.txt")).text()).toBe(
      "must survive\n",
    );
    expect((await jj(["workspace", "list"], outsider)).out).toBe(outsideBefore);
    expect(
      await Bun.file(join(wsDir(outsider, "outside"), "a.txt")).exists(),
    ).toBe(true);
  });

  test("uses jj trunk(), keeps root-only repos unclassified, and reads working keep paths", async () => {
    const path = await repo('keep = ["../proj.ws/ws_safe"]\n');
    const configured = await jj(
      ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"],
      path,
    );
    expect(configured.code, configured.err).toBe(0);
    expect((await ws(["add", "safe"], path)).code).toBe(0);
    expect((await ws(["add", "ancestor"], path)).code).toBe(0);
    await Bun.write(join(path, ".ws.toml"), 'keep = ["ws_ancestor"]\n');
    const dry = await ws(
      ["gc", "--dry-run", "--include-unrecorded", "--legacy"],
      path,
    );
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${wsDir(path, "safe")}\tws\tremovable\t`);
    expect(dry.out).toContain(`${wsDir(path, "ancestor")}\tws\tkeep\t`);
    expect((await ws(["rm", "ancestor"], path)).code).toBe(1);
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "root()"],
          path,
        )
      ).code,
    ).toBe(0);
    expect((await jj(["bookmark", "delete", "main"], path)).code).toBe(0);
    const noTrunk = await ws(["gc", "--include-unrecorded", "--legacy"], path);
    expect(noTrunk.code, noTrunk.err).toBe(0);
    expect(noTrunk.out).toContain("trunk resolves to root");
    expect(
      await Bun.file(join(wsDir(path, "ancestor"), "a.txt")).exists(),
    ).toBe(true);
  });
});

describe("AGX-GC-LOCAL-TRUNK-1025", () => {
  for (const names of [
    ["alpha"],
    ["main"],
    ["master"],
    ["trunk"],
    [],
    ["alpha", "main"],
  ]) {
    test(`root trunk with local candidates ${names.length === 0 ? "none" : names.join(",")}`, async () => {
      const path = await repo();
      expect((await jj(["bookmark", "delete", "main"], path)).code).toBe(0);
      for (const name of names)
        expect(
          (await jj(["bookmark", "create", name, "-r", "@-"], path)).code,
        ).toBe(0);
      expect(
        (
          await jj(
            ["config", "set", "--repo", 'revset-aliases."trunk()"', "root()"],
            path,
          )
        ).code,
      ).toBe(0);
      expect((await jj(["git", "remote", "list"], path)).out.trim()).toBe("");
      expect((await ws(["add", "candidate"], path)).code).toBe(0);
      const before = (
        await jj(
          ["operation", "log", "--limit", "1", "--no-graph", "-T", "id"],
          path,
        )
      ).out;
      const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
      expect(dry.code, dry.err).toBe(0);
      if (names.length === 1) {
        expect(dry.out).toContain("\tws\tremovable\t");
        expect(dry.out).toContain(`trunk source: local bookmark ${names[0]}`);
        expect(dry.out).not.toContain("missing trunk setting");
      } else {
        expect(dry.out).toContain("\tkeep\t");
        expect(dry.out).toContain(`${names.length} local candidate bookmarks`);
        expect(dry.out).toContain(
          `missing trunk setting; set trunk in .ws.toml: trunk = "alpha"`,
        );
      }
      expect(
        (
          await jj(
            ["operation", "log", "--limit", "1", "--no-graph", "-T", "id"],
            path,
          )
        ).out,
      ).toBe(before);
    });
  }

  test("real jj trunk wins over local alpha and explicit root disables fallback", async () => {
    const path = await repo();
    expect(
      (await jj(["bookmark", "create", "alpha", "-r", "root()"], path)).code,
    ).toBe(0);
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"],
          path,
        )
      ).code,
    ).toBe(0);
    expect((await ws(["add", "precedence"], path)).code).toBe(0);
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain("\tws\tremovable\t");
    expect(dry.out).toContain("trunk source: jj trunk()");
    await Bun.write(join(path, ".ws.toml"), 'trunk = "root()"\n');
    const explicit = await ws(
      ["gc", "--dry-run", "--include-unrecorded"],
      path,
    );
    expect(explicit.code, explicit.err).toBe(0);
    expect(explicit.out).toContain("\tkeep\t");
    expect(explicit.out).toContain(
      'trunk source: .ws.toml trunk = "root()" resolves to root',
    );
  });
});

const recFor = (dir: string) => ({
  id: dir,
  state: "ended",
  cwd: dir,
  workspace: dir,
  continues: null,
  judgment: { decision: "reject" },
});

describe("gc integration branches", () => {
  test("AGX-WS-HARVEST-1025 copies once, leaves workspace bytes intact, and enables gc", async () => {
    const env = baseEnv({
      AGX_STATE_DIR: join(scratch, "harvest-state"),
      XDG_CONFIG_HOME: join(scratch, "harvest-config"),
    });
    const fixtureWs = (args: string[], cwd: string) => ws(args, cwd, env);
    const path = await repo('trunk = "main"\n');
    await Bun.write(
      join(path, ".gitignore"),
      "*.result.md\n.agent-state/\nmetrics/\n",
    );
    await jj(["commit", "-m", "ignore results"], path);
    await jj(["bookmark", "set", "main", "-r", "@-"], path);
    expect((await fixtureWs(["add", "harvest-reject"], path)).code).toBe(0);
    expect((await fixtureWs(["add", "harvest-running"], path)).code).toBe(0);
    const dir = wsDir(path, "harvest-reject");
    const live = wsDir(path, "harvest-running");
    const files = [
      "worker.result.md",
      ".agent-state/harvest/result.md",
      "metrics/result.json",
    ];
    for (const file of files) await Bun.write(join(dir, file), "measurement");
    await Bun.write(join(live, "worker.result.md"), "still running");
    setRecords([
      {
        ...recFor(dir),
        id: "harvest-reject",
        ticket: "harvest",
        writes: [".agent-state/harvest/**"],
        report_path: join(dir, "metrics/result.json"),
      },
      { ...recFor(live), id: "harvest-running", state: "running" },
    ]);
    const before = await fixtureWs(["gc", "--dry-run"], path);
    expect(before.out).toContain("untracked content: 3 files");
    const preview = await fixtureWs(
      ["harvest", "--repo", path, "--dry-run", "--json"],
      path,
    );
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain('"files":3,"bytes":33');
    const target = join(
      env.AGX_STATE_DIR!,
      "runs",
      "harvest-reject",
      "harvest",
    );
    expect(existsSync(target)).toBe(false);
    const first = await fixtureWs(["harvest", "--repo", path, "--json"], path);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('"files":3,"bytes":33');
    for (const file of files) {
      expect(await Bun.file(join(dir, file)).text()).toBe("measurement");
      expect(await Bun.file(join(target, file)).text()).toBe("measurement");
    }
    expect(
      existsSync(
        join(env.AGX_STATE_DIR!, "runs", "harvest-running", "harvest"),
      ),
    ).toBe(false);
    const second = await fixtureWs(["harvest", "--all", "--json"], path);
    expect(second.code, second.err).toBe(0);
    expect(second.out).toContain('"files":0,"bytes":0');
    await Bun.write(join(dir, "worker.result.md"), "changed result");
    const conflict = await fixtureWs(["harvest", "--repo", path], path);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("harvest conflict");
    expect(await Bun.file(join(target, "worker.result.md")).text()).toBe(
      "measurement",
    );
    expect(await Bun.file(join(dir, "worker.result.md")).text()).toBe(
      "changed result",
    );
    await Bun.write(join(dir, "worker.result.md"), "measurement");
    const collected = await fixtureWs(["gc"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(await Bun.file(join(live, "worker.result.md")).text()).toBe(
      "still running",
    );
  });

  test("GC keeps an empty saved checkout with unsnapshotted disk edits and never snapshots it", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "unsnapshotted"], path)).code).toBe(0);
    const dir = wsDir(path, "unsnapshotted");
    await Bun.write(join(dir, "a.txt"), "edited on disk after snapshot\n");
    const saved = await jj(
      [
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        'commit_id ++ "\\t" ++ committer.timestamp()',
      ],
      dir,
    );
    expect(saved.code, saved.err).toBe(0);

    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tkeep\t`);
    expect(dry.out).toContain(
      "unsnapshotted working-copy changes: yes: bytes differ at a.txt",
    );
    const collected = await ws(["gc", "--include-unrecorded"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${dir}\tws\tkeep\t`);
    expect(collected.out).toContain(
      "unsnapshotted working-copy changes: yes: bytes differ at a.txt",
    );
    const realRow = collected.out
      .split("\n")
      .find((line) => line.startsWith(`${dir}\t`));
    const dryRow = dry.out
      .split("\n")
      .find((line) => line.startsWith(`${dir}\t`));
    expect(realRow?.split("\t").slice(0, 4)).toEqual(
      dryRow?.split("\t").slice(0, 4),
    );
    expect(
      (
        await jj(
          [
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            "@",
            "-T",
            'commit_id ++ "\\t" ++ committer.timestamp()',
          ],
          dir,
        )
      ).out,
    ).toBe(saved.out);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe(
      "edited on disk after snapshot\n",
    );
    setRecords([]);
  });

  test("result preservation requires every file, equal bytes and no symlink escape", async () => {
    const path = await repo('trunk = "main"\n');
    const runDir = join(scratch, "preservation-run");
    await Bun.write(join(path, ".gitignore"), "*.result.md\n");
    await jj(["status"], path);
    for (let i = 0; i < 7; i++) {
      await Bun.write(join(path, `${i}.result.md`), `result-${i}`);
      await Bun.write(join(runDir, "results", `${i}.result.md`), `result-${i}`);
    }
    const inventory = () => untrackedContent(path, [], 10_000, [runDir]);
    const complete = await inventory();
    expect(complete.ok && complete.value.count).toBe(0);
    await Bun.write(join(runDir, "results", "6.result.md"), "different bytes");
    const changed = await inventory();
    expect(changed.ok && changed.value.count).toBe(1);
    await unlink(join(runDir, "results", "6.result.md"));
    await symlink(
      join(path, "6.result.md"),
      join(runDir, "results", "6.result.md"),
    );
    const escaped = await inventory();
    expect(escaped.ok && escaped.value.count).toBe(1);

    const oversizedSource = join(path, "large.result.bin");
    const oversizedCopy = join(runDir, "results", "large.result.bin");
    await Bun.write(oversizedSource, "");
    await Bun.write(oversizedCopy, "");
    await truncate(oversizedSource, 16 * 1024 * 1024 + 1);
    await truncate(oversizedCopy, 16 * 1024 * 1024 + 1);
    const oversized = await inventory();
    expect(oversized.ok && oversized.value.count).toBe(2);
  });

  test("fully rejected runs collect only when reachable and results are preserved", async () => {
    const path = await repo('trunk = "main"\n');
    for (const slug of [
      "reject-clean",
      "reject-copy",
      "reject-other",
      "reject-edit",
      "reject-unjudged",
      "reject-accept",
    ]) {
      expect((await ws(["add", slug], path)).code).toBe(0);
    }
    const rows = [
      "reject-clean",
      "reject-copy",
      "reject-other",
      "reject-edit",
      "reject-unjudged",
      "reject-accept",
    ].map((slug) => ({
      state: "ended",
      cwd: wsDir(path, slug),
      workspace: wsDir(path, slug),
      id: slug,
      ended_at: Temporal.Now.instant().toString(),
      outcome: "ok",
      judgment: { decision: slug === "reject-accept" ? "accept" : "reject" },
    }));
    setRecords([
      ...rows,
      {
        ...recFor(wsDir(path, "reject-unjudged")),
        id: "pending",
        judgment: null,
      },
    ]);
    for (const slug of ["reject-copy", "reject-other"]) {
      // Ignore local results so jj does not turn them into source changes.
      await Bun.write(join(wsDir(path, slug), ".gitignore"), "*.result.md\n");
      await jj(["status"], wsDir(path, slug));
    }
    const landedCopy = (
      await jj(
        ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
        wsDir(path, "reject-copy"),
      )
    ).out.trim();
    expect(
      (await jj(["bookmark", "set", "main", "-r", landedCopy], path)).code,
    ).toBe(0);
    for (const slug of ["reject-copy", "reject-other"]) {
      await Bun.write(
        join(wsDir(path, slug), "worker.result.md"),
        "measurement",
      );
    }
    const copied = join(
      baseEnv().AGX_STATE_DIR!,
      "runs",
      "reject-copy",
      "results",
      "worker.result.md",
    );
    await Bun.write(copied, "measurement");
    await Bun.write(
      join(wsDir(path, "reject-accept"), "a.txt"),
      "accepted but unlanded",
    );
    await jj(["status"], wsDir(path, "reject-accept"));
    await Bun.write(join(wsDir(path, "reject-edit"), "a.txt"), "unlanded edit");
    await jj(["status"], wsDir(path, "reject-edit"));
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(
      wsDir(path, "reject-clean") + "\tws\tremovable\t",
    );
    expect(dry.out).toContain(wsDir(path, "reject-copy") + "\tws\tremovable\t");
    expect(dry.out).toContain("no age wait");
    expect(dry.out).toContain(wsDir(path, "reject-other") + "\tws\tkeep\t");
    expect(dry.out).toContain(wsDir(path, "reject-edit") + "\tws\tkeep\t");
    expect(dry.out).toContain("unjudged; keep");
    const collected = await ws(["gc"], path);
    expect(collected.code, collected.err).toBe(0);
    for (const slug of ["reject-clean", "reject-copy"])
      expect(existsSync(wsDir(path, slug))).toBe(false);
    for (const slug of [
      "reject-other",
      "reject-edit",
      "reject-unjudged",
      "reject-accept",
    ])
      expect(existsSync(wsDir(path, slug))).toBe(true);
    expect(await Bun.file(copied).text()).toBe("measurement");
  });

  test("filesets select literal paths without selecting neighboring files", async () => {
    const path = await repo();
    const names = [
      ".dx/verdicts/20261019_x%2Emd.jsonl",
      'space and "quote".txt',
      "operators (a|b)&~glob:*.txt",
      "back\\slash.txt",
      "日本語.txt",
      "tab\tline\n.txt",
    ];
    for (const name of names) {
      await Bun.write(join(path, name), `literal ${name}`);
      await Bun.write(join(path, `${name}.neighbor`), "wrong file");
    }
    expect((await jj(["status"], path)).code).toBe(0);
    for (const name of names) {
      const shown = await jj(["file", "show", rootFileFileset(name)], path);
      expect(shown.code, shown.err).toBe(0);
      expect(shown.out).toBe(`literal ${name}`);
    }
  });

  test("gc compares saved content for percent and quoted tracked paths", async () => {
    const path = await repo('trunk = "main"\n');
    const firstName = ".dx/verdicts/20261019_x%2Emd.jsonl";
    const names = [firstName, 'space and "quote".txt'];
    for (const name of names)
      await Bun.write(join(path, name), "a\nb\nc\nd\ne\nf\ng\n");
    expect((await jj(["commit", "-m", "literal path base"], path)).code).toBe(
      0,
    );
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    const dir = join(scratch, "literal-paths");
    expect(
      (
        await jj(
          ["workspace", "add", "--name", "literal-paths", "-r", "main", dir],
          path,
        )
      ).code,
    ).toBe(0);
    for (const name of names)
      await Bun.write(join(dir, name), "a\nB\nc\nd\ne\nf\ng\n");
    expect((await jj(["status"], dir)).code).toBe(0);
    const target = (
      await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
    ).out.trim();
    expect(
      (await jj(["bookmark", "set", "main", "-r", target], path)).code,
    ).toBe(0);
    setRecords([]);
    const landed = await ws(["gc", "--dry-run", "--legacy"], path);
    expect(landed.code, landed.err).toBe(0);
    expect(landed.out).toContain(`${dir}\tlegacy\tremovable\t`);
    await Bun.write(join(dir, firstName), "a\nB\nc\nD\ne\nf\ng\n");
    const pending = await ws(["gc", "--dry-run", "--legacy"], path);
    expect(pending.code, pending.err).toBe(0);
    expect(pending.out).toContain(`${dir}\tlegacy\tkeep\t`);
    expect(pending.out).toContain(
      `unsnapshotted working-copy changes: yes: bytes differ at ${firstName}`,
    );
  });

  for (const integration of ["squash", "rebase", "continuation"]) {
    test(`AGX-WS-GC-KEEP-BY-DIFF-1024: accepted ${integration} and real paths`, async () => {
      const path = await repo('trunk = "main"\n');
      setRecords([]);
      expect((await ws(["add", "integrated"], path)).code).toBe(0);
      const dir = wsDir(path, "integrated");
      const changedFile = "trailing space ";
      const files = [" leading space.txt", changedFile, "日本語 [draft].txt"];
      for (const file of files) await Bun.write(join(dir, file), "accepted\n");
      const end = (
        await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
      ).out.trim();
      if (integration === "squash") {
        expect(
          (await jj(["squash", "--from", end, "--into", "@"], path)).code,
        ).toBe(0);
        expect(
          (await jj(["bookmark", "set", "main", "-r", "@"], path)).code,
        ).toBe(0);
        expect((await jj(["workspace", "update-stale"], dir)).code).toBe(0);
        expect((await jj(["new", "main"], dir)).code).toBe(0);
      } else {
        for (const file of files)
          await Bun.write(join(path, file), "accepted\n");
        expect(
          (await jj(["commit", "-m", "independent integrated copy"], path))
            .code,
        ).toBe(0);
        expect(
          (await jj(["bookmark", "set", "main", "-r", "@-"], path)).code,
        ).toBe(0);
        if (integration === "rebase")
          expect(
            (await jj(["rebase", "-s", "@", "-d", "main"], dir)).code,
          ).toBe(0);
        else expect((await jj(["new", "main"], dir)).code).toBe(0);
      }
      setRecords([
        {
          ...recFor(dir),
          id: "old",
          judgment: { decision: "accept" },
          end_commit: end,
        },
        {
          ...recFor(dir),
          id: "continued",
          continues: "old",
          judgment: { decision: "accept" },
        },
      ]);
      const dry = await ws(["gc", "--dry-run"], path);
      expect(dry.code, `${dry.err}\n${dry.out}`).toBe(0);
      expect(dry.out).toContain(`${dir}\tws\tremovable\t`);
      // A locked recheck must see disk edits without recording them into jj.
      await Bun.write(join(dir, changedFile), "still unlanded\n");
      const kept = await ws(["gc"], path);
      expect(kept.code, kept.err).toBe(0);
      expect(kept.out).toContain(`${dir}\tws\tkeep\t`);
      expect(kept.out).toContain(
        `unsnapshotted working-copy changes: yes: bytes differ at ${changedFile}`,
      );
      expect(kept.out).toContain(changedFile);
      expect(await Bun.file(join(dir, changedFile)).text()).toBe(
        "still unlanded\n",
      );
      await Bun.write(join(dir, changedFile), "accepted\n");
      expect((await jj(["status"], dir)).code).toBe(0);
      const collected = await ws(["gc"], path);
      expect(collected.code, collected.err).toBe(0);
      expect(collected.out).toContain(`${dir}\tws\tremovable\t`);
      expect(existsSync(dir)).toBe(false);
      setRecords([]);
    });
  }

  test("WS-GC-IMMUTABLE: collects without abandoning an immutable workspace commit", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "immutable-abandoned"], path)).code).toBe(0);
    const dir = wsDir(path, "immutable-abandoned");
    expect((await jj(["edit", "main"], dir)).code).toBe(0);
    const tip = (
      await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
    ).out.trim();
    expect(
      (
        await jj(
          [
            "config",
            "set",
            "--repo",
            'revset-aliases."immutable_heads()"',
            `builtin_immutable_heads() | ${tip}`,
          ],
          path,
        )
      ).code,
    ).toBe(0);
    const state = join(scratch, "immutable-state");
    const realBin = join(scratch, "immutable-bin");
    await mkdir(state);
    await mkdir(realBin);
    await symlink(
      join(import.meta.dir, "../../agx-worker/src/next/cli.ts"),
      join(realBin, "agx-worker"),
    );
    const wrapper = join(realBin, "agx");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun\nconst p=Bun.spawn([process.execPath,${JSON.stringify(join(import.meta.dir, "../../agx/src/agx.ts"))},...process.argv.slice(2)],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exitCode=await p.exited;\n`,
    );
    await chmod(wrapper, 0o755);
    const env = baseEnv({
      AGX_STATE_DIR: state,
      PATH: `${realBin}:${bin}:${process.env.PATH}`,
    });
    const old = Temporal.Now.instant().subtract({ hours: 48 }).toString();
    const id = "immutable-abandoned-first";
    await Bun.write(
      join(state, "records.jsonl"),
      `${[
        {
          kind: "started",
          id,
          at: old,
          ticket: id,
          writes: [],
          cwd: path,
          workspace: dir,
          row: "fixture",
          dispatcher_session: null,
          vendor_session: null,
          pid: process.pid,
        },
        {
          kind: "ended",
          id,
          at: old,
          exit: 1,
          outcome: "verify-failed",
          report_path: null,
          vendor_session: null,
          verify: [],
        },
        { kind: "judged", id, at: old, decision: "reject", note: "fixture" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    const collected = await ws(["gc", "--abandoned"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${dir}\tws\tremovable\t`);
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_immutable-abandoned",
    );
    expect(
      (
        await jj(
          ["log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"'],
          path,
        )
      ).out,
    ).toContain(tip);
  });

  test("WS-GC-UNACCEPTED: abandonment requires rejection; flags never override unjudged runs", async () => {
    const path = await repo('trunk = "main"\nkeep = ["ws_kept"]\n');
    const slugs = [
      "abandoned",
      "accepted",
      "running",
      "unknown",
      "kept",
      "recent",
      "undated",
    ];
    for (const slug of slugs) {
      expect((await ws(["add", slug], path)).code).toBe(0);
      await Bun.write(join(wsDir(path, slug), "attempt.txt"), `${slug}\n`);
      expect((await jj(["status"], wsDir(path, slug))).code).toBe(0);
    }
    const state = join(scratch, "unaccepted-state");
    const realBin = join(scratch, "unaccepted-bin");
    await mkdir(state);
    await mkdir(realBin);
    await symlink(
      join(import.meta.dir, "../../agx-worker/src/next/cli.ts"),
      join(realBin, "agx-worker"),
    );
    const wrapper = join(realBin, "agx");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun\nconst p=Bun.spawn([process.execPath,${JSON.stringify(join(import.meta.dir, "../../agx/src/agx.ts"))},...process.argv.slice(2)],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exitCode=await p.exited;\n`,
    );
    await chmod(wrapper, 0o755);
    const env = baseEnv({
      AGX_STATE_DIR: state,
      PATH: `${realBin}:${bin}:${process.env.PATH}`,
    });
    const old = Temporal.Now.instant().subtract({ hours: 48 }).toString();
    const recent = Temporal.Now.instant().subtract({ hours: 1 }).toString();
    const events: object[] = [];
    const record = (
      slug: string,
      suffix: string,
      outcome?: string,
      endedAt = old,
      accept = false,
    ) => {
      const id = `${slug}-${suffix}`;
      events.push({
        kind: "started",
        id,
        at: old,
        ticket: id,
        writes: [],
        cwd: path,
        workspace: wsDir(path, slug),
        continues: suffix === "second" ? `${slug}-first` : null,
        row: "fixture",
        dispatcher_session: null,
        vendor_session: null,
        pid: process.pid,
      });
      if (outcome !== undefined)
        events.push({
          kind: "ended",
          id,
          at: endedAt,
          exit: 1,
          outcome,
          report_path: null,
          vendor_session: null,
          verify: [],
        });
      if (accept)
        events.push({
          kind: "judged",
          id,
          at: old,
          decision: "accept",
          note: "fixture",
        });
    };
    record("abandoned", "first", "verify-failed");
    record("abandoned", "second", "malformed");
    events.push({
      kind: "judged",
      id: "abandoned-second",
      at: old,
      decision: "reject",
      note: "fixture",
    });
    record("accepted", "first", "ok", old, true);
    record("accepted", "second", "refused");
    record("running", "first", "timeout");
    record("running", "second");
    record("kept", "first", "lost");
    record("recent", "first", "refused");
    record("recent", "second", "timeout", recent);
    // A dead pid yields derived loss with no ended timestamp, which cannot prove age.
    events.push({
      kind: "started",
      id: "undated-first",
      at: old,
      ticket: "undated",
      writes: [],
      cwd: path,
      workspace: wsDir(path, "undated"),
      row: "fixture",
      dispatcher_session: null,
      vendor_session: null,
      pid: 2147483647,
    });
    await Bun.write(
      join(state, "records.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const abandoned = wsDir(path, "abandoned");
    const tip = (
      await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], abandoned)
    ).out.trim();
    const dry = await ws(["gc", "--dry-run", "--abandoned"], path, env);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${abandoned}\tws\tremovable\t`);
    expect(dry.out).toContain(
      "abandoned-first (verify-failed), abandoned-second (malformed)",
    );
    const plain = await ws(
      ["gc", "--legacy", "--include-unrecorded"],
      path,
      env,
    );
    expect(plain.code, plain.err).toBe(0);
    expect(plain.out).toContain("pass --abandoned");
    expect(await Bun.file(join(abandoned, "attempt.txt")).exists()).toBe(true);
    const collected = await ws(["gc", "--abandoned"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${abandoned}\tws\tremovable\t`);
    expect(await Bun.file(join(abandoned, "attempt.txt")).exists()).toBe(false);
    const registered = (await jj(["workspace", "list"], path)).out;
    expect(registered).not.toContain("ws_abandoned");
    expect(
      (
        await jj(
          ["log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"'],
          path,
        )
      ).out,
    ).not.toContain(tip);
    for (const slug of slugs.filter((candidate) => candidate !== "abandoned")) {
      expect(
        await Bun.file(join(wsDir(path, slug), "attempt.txt")).exists(),
      ).toBe(true);
      expect(registered).toContain(`ws_${slug}`);
    }
    expect(collected.out).toContain(`${wsDir(path, "kept")}\tws\tkeep\t`);
  });

  test("WS-GC-LANDED-CONTENT: equal bytes in a non-ancestor do not count as landing", async () => {
    const path = await repo('trunk = "main"\n');
    for (const slug of ["rebased-copy", "partial-copy"])
      expect((await ws(["add", slug], path)).code).toBe(0);
    const landed = wsDir(path, "rebased-copy");
    const partial = wsDir(path, "partial-copy");
    for (const dir of [landed, partial]) {
      await Bun.write(join(dir, "a.txt"), "changed\n");
      await Bun.write(join(dir, "second.txt"), "new\n");
      await unlink(join(dir, ".ws.toml"));
    }
    await Bun.write(join(partial, "second.txt"), "outstanding\n");
    await Bun.write(join(path, "a.txt"), "changed\n");
    await Bun.write(join(path, "second.txt"), "new\n");
    // Keep the committed config so trunk remains explicit, but delete another tracked file below.
    expect(
      (await jj(["commit", "-m", "independent landing copy"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    // An identical independent copy is not ancestry evidence; both commits remain unlanded.
    for (const dir of [landed, partial])
      expect((await jj(["status"], dir)).code).toBe(0);
    setRecords([recFor(landed), recFor(partial)]);
    const before = await ws(["gc", "--dry-run"], path);
    expect(before.out).toContain(`${landed}\tws\tkeep\t`);
    expect(before.out).toContain("unlanded change");
    await unlink(join(path, ".ws.toml"));
    expect((await jj(["commit", "-m", "land deletion"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    // Neither working nor committed config exists; supply trunk through jj's default alias.
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"],
          path,
        )
      ).code,
    ).toBe(0);
    const env = baseEnv();
    const dry = await ws(["gc", "--dry-run"], path, env);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${landed}\tws\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    const collected = await ws(["gc"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(await Bun.file(join(landed, "a.txt")).exists()).toBe(true);
    expect(await Bun.file(join(partial, "second.txt")).text()).toBe(
      "outstanding\n",
    );
  });

  test("release consumes notes and version metadata; later trunk edits preserve landing evidence", async () => {
    const path = await repo('trunk = "main"\n');
    await Bun.write(
      join(path, "tools/example/package.json"),
      '{"name":"example","version":"0.1.0"}\n',
    );
    await Bun.write(
      join(path, "tools/example/CHANGELOG.md"),
      "# Changelog\n\n## 0.1.0\n\n- Initial\n",
    );
    expect((await jj(["commit", "-m", "tool base"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    expect((await ws(["add", "release-copy"], path)).code).toBe(0);
    const dir = wsDir(path, "release-copy");
    const note = "tools/example/.changes/released.md";
    await Bun.write(
      join(dir, note),
      "---\nbump: patch\n---\n\nReleased feature\n",
    );
    await Bun.write(join(dir, "feature.txt"), "released work\n");
    // Worker edits to release metadata must survive release normalization.
    await Bun.write(
      join(dir, "tools/example/package.json"),
      '{"name":"renamed","version":"0.1.0"}\n',
    );
    await Bun.write(
      join(dir, "tools/example/CHANGELOG.md"),
      "# Changelog\n\n## 0.1.0\n\n- Initial, corrected\n",
    );
    await Bun.write(join(path, "feature.txt"), "released work\n");
    await Bun.write(
      join(path, "tools/example/package.json"),
      '{"name":"renamed","version":"0.1.1"}\n',
    );
    await Bun.write(
      join(path, "tools/example/CHANGELOG.md"),
      "# Changelog\n\n## 0.1.1\n\n- Released feature\n\n## 0.1.0\n\n- Initial, corrected\n",
    );
    expect(
      (await jj(["commit", "-m", "squashed release copy"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    await Bun.write(
      join(path, "feature.txt"),
      "released work, subsequently improved\n",
    );
    expect((await jj(["commit", "-m", "later trunk edit"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    setRecords([recFor(dir)]);
    expect((await jj(["status"], dir)).code).toBe(0);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    await Bun.write(join(dir, "feature.txt"), "unreleased work\n");
    const partial = await ws(["gc"], path);
    expect(partial.code, partial.err).toBe(0);
    expect(partial.out).toContain(`${dir}\tws\tkeep\t`);
    expect(partial.out).toContain("unlanded change");
    expect(await Bun.file(join(dir, "feature.txt")).exists()).toBe(true);
    await Bun.write(join(dir, "feature.txt"), "released work\n");
    await Bun.write(
      join(dir, note),
      "---\nbump: patch\n---\n\nNever released\n",
    );
    expect((await jj(["status"], dir)).code).toBe(0);
    const missing = await ws(["gc"], path);
    expect(missing.out).toContain(`${dir}\tws\tkeep\t`);
    expect(missing.out).toContain("unlanded change");
    expect(await Bun.file(join(dir, note)).exists()).toBe(true);
  });

  test("land staging residue with an unlanded change stays keep after the lock is free", async () => {
    const path = await repo('trunk = "main"\n');
    const state = join(home, "state/agx/land", `fixture-${counter}`);
    const dir = join(state, "workspace");
    await mkdir(state, { recursive: true });
    expect(
      (
        await jj(
          ["workspace", "add", "--name", "lander", "-r", "main", dir],
          path,
        )
      ).code,
    ).toBe(0);
    await Bun.write(join(dir, "temporary.txt"), "land staging residue\n");
    // This test exercises the land lock; the staging residue must be restorable.
    expect((await jj(["status"], dir)).code).toBe(0);
    setRecords([]);
    const dry = await ws(["gc", "--dry-run", "--legacy"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tlegacy\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    expect((await ws(["gc"], path)).code).toBe(0);
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    await Bun.write(
      join(state, "land.lock/owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        what: "land",
        since: Temporal.Now.instant().toString(),
      }),
    );
    const held = await ws(["gc", "--legacy"], path);
    expect(held.code, held.err).toBe(0);
    expect(held.out).toContain("land lock is held");
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    await Bun.write(
      join(state, "land.lock/owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: hostname(),
        what: "land",
        since: Temporal.Now.instant().toString(),
      }),
    );
    const collected = await ws(["gc", "--legacy"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${dir}\tlegacy\tkeep\t`);
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).toContain("lander");
  });

  test("an identical squash copy is still unlanded without commit reachability", async () => {
    const path = await repo('trunk = "main"\n');
    await Bun.write(join(path, "a.txt"), "a\nb\nc\nd\ne\nf\ng\n");
    expect((await jj(["commit", "-m", "multiline base"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    const dir = join(scratch, "contained-diff");
    expect(
      (
        await jj(
          ["workspace", "add", "--name", "contained", "-r", "main", dir],
          path,
        )
      ).code,
    ).toBe(0);
    await Bun.write(join(dir, "a.txt"), "a\nB\nc\nd\ne\nf\ng\n");
    await Bun.write(join(dir, "shared-new.txt"), "same new file\n");
    expect((await jj(["status"], dir)).code).toBe(0);
    await Bun.write(join(path, "a.txt"), "a\nB\nc\nd\ne\nf\nG\n");
    await Bun.write(join(path, "shared-new.txt"), "same new file\n");
    await Bun.write(join(path, "unrelated.txt"), "other integrated work\n");
    expect(
      (await jj(["commit", "-m", "integrated plus other work"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    setRecords([]);
    const dry = await ws(["gc", "--dry-run", "--legacy"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tlegacy\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    // An additional on-disk edit must prevent deletion without being snapshotted.
    await Bun.write(join(dir, "a.txt"), "a\nB\nc\nD\ne\nf\ng\n");
    const partial = await ws(["gc", "--legacy"], path);
    expect(partial.code, partial.err).toBe(0);
    expect(partial.out).toContain(`${dir}\tlegacy\tkeep\t`);
    expect(partial.out).toContain("unlanded change");
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
  });

  test("all unions creation state and L2 repositories once in an isolated config", async () => {
    const allEnv = baseEnv({ AGX_STATE_DIR: join(scratch, "all-state") });
    const primary = await repo('trunk = "main"\n');
    const consumer = await repo('trunk = "main"\n');
    const pending = await repo('trunk = "main"\n');
    for (const path of [primary, consumer, pending])
      expect(
        (
          await ws(
            ["add", "all"],
            path,
            path === pending
              ? baseEnv({
                  AGX_STATE_DIR: join(scratch, "all-historical-state"),
                })
              : allEnv,
          )
        ).code,
      ).toBe(0);
    const configHome = join(scratch, "all-config");
    for (const [index, path] of [primary, consumer, pending].entries())
      await Bun.write(
        join(configHome, "agx/repos", `repo-${index}.toml`),
        `schema = 1\nroot = ${JSON.stringify(path)}\n`,
      );
    const module = join(import.meta.dir, "../src/workspace.ts");
    const result = await run(
      [
        "bun",
        "--eval",
        `import {gcAll} from ${JSON.stringify(module)};const r=await gcAll({dryRun:true,includeUnrecorded:true,legacy:true,graceMinutes:0},${JSON.stringify(primary)});process.stdout.write(JSON.stringify(r));`,
      ],
      primary,
      { ...allEnv, XDG_CONFIG_HOME: configHome },
    );
    expect(result.code, result.err).toBe(0);
    const parsed = jsonOf(
      z.object({
        ok: z.literal(true),
        value: z.object({
          lines: z.array(z.string()),
          failed: z.array(z.string()),
          repositories: z.array(
            z.object({ root: z.string(), sources: z.array(z.string()) }),
          ),
        }),
      }),
    ).safeParse(result.out);
    expect(parsed.success, result.out).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.value.failed, result.out).toEqual([]);
    expect(
      parsed.data.value.repositories.find((r) => r.root === pending)?.sources,
    ).toEqual(["L2"]);
    expect(
      parsed.data.value.repositories.find((r) => r.root === primary)?.sources,
    ).toEqual(["L2", "state"]);
    expect(parsed.data.value.lines).toHaveLength(3);
    const counts = jsonOf(
      z.object({
        value: z.object({
          counts: z.object({
            total: z.number(),
            unlanded: z.number(),
            collectable: z.number(),
            legacy: z.number(),
          }),
        }),
      }),
    ).safeParse(result.out);
    expect(counts).toMatchObject({
      success: true,
      data: {
        value: { counts: { total: 3, unlanded: 0, collectable: 3, legacy: 0 } },
      },
    });
    for (const path of [primary, consumer, pending]) {
      expect(
        parsed.data.value.lines.some((line) =>
          line.startsWith(`${wsDir(path, "all")}\tws\tremovable\t`),
        ),
      ).toBe(true);
      expect(await Bun.file(join(wsDir(path, "all"), "a.txt")).exists()).toBe(
        true,
      );
    }
    const conflict = await ws(["gc", "--all", "--repo", primary], primary);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("cannot be combined");
    const help = await ws(["gc", "--help"], primary);
    expect(help.code).toBe(0);
    expect(help.out).toContain("only creator");
  });
});

// These cases reproduce the incident with an empty saved diff and exercise real CLI effects.
describe("SEP-WS-FORGET-UNJUDGED-1023", () => {
  for (const caller of ["gc", "rm", "adopt"] as const) {
    for (const state of [
      "unjudged",
      "accepted-pending",
      "accepted-landed",
      "rejected",
      "running",
    ] as const) {
      test(`${caller}: ${state} run gates forget and directory removal`, async () => {
        const path = await repo('trunk = "main"\n');
        setRecords([]);
        expect((await ws(["add", "guarded"], path)).code).toBe(0);
        const dir = wsDir(path, "guarded");
        const main = (
          await jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"], path)
        ).out.trim();
        let commit = main;
        if (state === "accepted-pending") {
          // Accepted content in the current working-copy chain must survive.
          await Bun.write(join(dir, "pending.txt"), "unlanded\n");
          commit = (
            await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
          ).out.trim();
        }
        let decision: string | undefined;
        if (state.startsWith("accepted")) decision = "accept";
        if (state === "rejected") decision = "reject";
        setRecords([
          {
            id: "latest",
            started_at: "2026-10-23T01:00:00Z",
            state: state === "running" ? "running" : "ended",
            ended_at: "2020-01-01T00:00:00Z",
            outcome: "ok",
            workspace: dir,
            judgment: decision === undefined ? null : { decision },
            end_commit: commit,
          },
        ]);
        const allowed = state === "accepted-landed" || state === "rejected";
        let args = ["rm", "guarded"];
        if (caller === "adopt") args = ["adopt", dir, "--slug", "moved"];
        if (caller === "gc")
          args = ["gc", "--abandoned", "--legacy", "--include-unrecorded"];
        const result = await ws(args, path);
        expect(result.code, result.out + result.err).toBe(
          allowed || caller === "gc" ? 0 : 1,
        );
        expect(existsSync(dir), result.out + result.err).toBe(!allowed);
        const names = (
          await jj(["--ignore-working-copy", "workspace", "list"], path)
        ).out;
        expect(names.includes("ws_guarded:")).toBe(!allowed);
        let reason = "unlanded";
        if (state === "unjudged") reason = "unjudged";
        if (state === "running") reason = "live or continuing";
        if (!allowed) expect(result.out + result.err).toContain(reason);
        setRecords([]);
      });
    }
  }

  test("latest run wins regardless of inventory order; cwd and continuation links retain work", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "latest"], path)).code).toBe(0);
    const dir = wsDir(path, "latest");
    const old = {
      id: "old",
      state: "ended",
      workspace: dir,
      judgment: { decision: "reject" },
      started_at: "2026-10-22T00:00:00Z",
    };
    const fresh = {
      id: "new",
      state: "ended",
      cwd: join(dir, "nested"),
      judgment: null,
      started_at: "2026-10-23T00:00:00Z",
    };
    for (const rows of [
      [old, fresh],
      [fresh, old],
    ]) {
      setRecords(rows);
      const result = await ws(["gc", "--abandoned"], path);
      expect(result.out).toContain("run new is unjudged");
      expect(existsSync(dir)).toBe(true);
    }
    setRecords([old, { ...fresh, cwd: "/elsewhere", continues: "old" }]);
    expect((await ws(["rm", "latest"], path)).err).toContain(
      "run new is unjudged",
    );
    setRecords([fresh, { ...old, started_at: "2026-10-24T00:00:00Z" }]);
    expect((await ws(["rm", "latest"], path)).code).toBe(0);
    setRecords([]);
  });

  test("failed readiness retains a workspace if readiness published an unjudged run", async () => {
    const command = `printf '%s' '[{"id":"during-ready","state":"ended","workspace":"PLACEHOLDER","judgment":null}]' > ${JSON.stringify(records)}; exit 9`;
    const path = await repo('trunk = "main"\n');
    const dir = wsDir(path, "rollback");
    await Bun.write(
      join(path, ".ws.toml"),
      `trunk = "main"\nready = [${JSON.stringify(command.replace("PLACEHOLDER", dir))}]\n`,
    );
    setRecords([]);
    const result = await ws(["add", "rollback"], path);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("unjudged");
    expect(existsSync(dir)).toBe(true);
    expect(
      (await jj(["--ignore-working-copy", "workspace", "list"], path)).out,
    ).toContain("ws_rollback");
    setRecords([]);
  });

  test("accepted inventory without end_commit permits an empty child of trunk", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "ancestry"], path)).code).toBe(0);
    const dir = wsDir(path, "ancestry");
    setRecords([
      {
        id: "accepted",
        state: "ended",
        workspace: dir,
        judgment: { decision: "accept" },
      },
    ]);
    const removed = await ws(["rm", "ancestry"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    setRecords([]);
  });
});

test("SEP-WS-FORGET-UNJUDGED-1023: adoption rollback retains a newly recorded target", async () => {
  const path = await repo('trunk = "main"\n');
  const source = join(path, "..", "legacy-rollback");
  setRecords([]);
  expect(
    (await jj(["workspace", "add", "--name", "legacy", source], path)).code,
  ).toBe(0);
  const target = wsDir(path, "rollback-target");
  const wrapper = join(scratch, "rollback-run-bin");
  await mkdir(wrapper);
  const realJj = Bun.which("jj");
  expect(realJj).not.toBeNull();
  await Bun.write(
    join(wrapper, "jj"),
    `#!/usr/bin/env bun
const args=process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(target)} && args.includes("edit")) {
  await Bun.write(${JSON.stringify(records)}, JSON.stringify([{id:"during-adoption",state:"ended",workspace:${JSON.stringify(target)},judgment:null}]));
  process.exit(1);
}
const p=Bun.spawn([${JSON.stringify(realJj)},...args],{stdin:"ignore",stdout:"inherit",stderr:"inherit",timeout:20000});
process.exitCode=await p.exited;
`,
  );
  await chmod(join(wrapper, "jj"), 0o755);
  const result = await ws(
    ["adopt", source, "--slug", "rollback-target"],
    path,
    baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
  );
  expect(result.code).toBe(1);
  expect(result.out + result.err).toContain("unjudged");
  expect(existsSync(source)).toBe(true);
  expect(existsSync(target)).toBe(true);
  const names = (await jj(["--ignore-working-copy", "workspace", "list"], path))
    .out;
  expect(names).toContain("legacy:");
  expect(names).toContain("ws_rollback-target:");
  setRecords([]);
});

import * as stateFs from "node:fs/promises";
import { tmpdir as stateTmpdir } from "node:os";
import {
  stateDir as resolvedStateDir,
  stateRefusal,
} from "../src/state-dir.ts";

test("single state directory precedence and startup refusals preserve data", async () => {
  const root = await stateFs.mkdtemp(
    join(stateTmpdir(), "agx-state-contract-"),
  );
  await using _cleanup = {
    [Symbol.asyncDispose]: () =>
      stateFs.rm(root, { recursive: true, force: true }),
  };
  {
    const env = { HOME: root, XDG_STATE_HOME: "", AGX_STATE_DIR: "" };
    expect(resolvedStateDir(env)).toBe(join(root, ".local/state/agx"));
    expect(resolvedStateDir({ ...env, XDG_STATE_HOME: root })).toBe(
      join(root, "agx"),
    );
    const explicit = join(root, "custom");
    expect(
      resolvedStateDir({
        ...env,
        XDG_STATE_HOME: root,
        AGX_STATE_DIR: explicit,
      }),
    ).toBe(explicit);
    expect(await stateRefusal(env)).toBeUndefined();
    await stateFs.mkdir(join(root, "agx-next"));
    await stateFs.writeFile(join(root, "agx-next/sentinel"), "unchanged");
    const migrationEnv = { ...env, XDG_STATE_HOME: root };
    const expected = `agx: state migration required; run: mv ${root}/agx ${root}/agx.legacy-v1.tmp && mv ${root}/agx-next ${root}/agx && mv ${root}/agx.legacy-v1.tmp ${root}/agx/legacy-v1`;
    expect(await stateRefusal(migrationEnv)).toBe(expected);
    expect(
      await stateRefusal({ ...migrationEnv, AGX_STATE_DIR: explicit }),
    ).toBe(expected);
    for (const override of [
      {},
      { AGX_NEXT_STATE_DIR: "" },
      { AGX_NEXT_STATE_DIR: "retired" },
    ]) {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/ws.ts"), "--help"],
        {
          env: { ...stateTestEnv(), ...migrationEnv, ...override },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [out, err, code] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toBe(
        (Object.hasOwn(override, "AGX_NEXT_STATE_DIR")
          ? "agx: AGX_NEXT_STATE_DIR is retired; use AGX_STATE_DIR"
          : expected) + "\n",
      );
    }
    expect(
      await stateFs.readFile(join(root, "agx-next/sentinel"), "utf8"),
    ).toBe("unchanged");
    expect(await stateFs.readdir(root)).toEqual(["agx-next"]);
    await stateFs.mkdir(join(root, "agx"));
    expect(await stateRefusal(migrationEnv)).toBeUndefined();
  }
});

// The shared preload still injects retired configuration; isolate refusal tests.
function stateTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGX_NEXT_STATE_DIR;
  return env;
}

describe("AGX-GC-DISCOVER-REPOS-1025", () => {
  test("state and all records discover no-L2 repositories; unreachable roots stay intact", async () => {
    const stateRepo = await repo('trunk = "main"\nkeep = ["ws_protected"]\n');
    const recordRepo = await repo('trunk = "main"\n');
    const missingRepo = await repo('trunk = "main"\n');
    const env = baseEnv({
      AGX_STATE_DIR: join(scratch, "discover-state"),
      XDG_CONFIG_HOME: join(scratch, "discover-config"),
    });
    setRecords([]);
    expect((await ws(["add", "protected"], stateRepo, env)).code).toBe(0);
    expect((await ws(["add", "missing"], missingRepo, env)).code).toBe(0);
    // Historical workspace, created before the new creation index exists.
    expect(
      (
        await ws(
          ["add", "historic"],
          recordRepo,
          baseEnv({ AGX_STATE_DIR: join(scratch, "old-state") }),
        )
      ).code,
    ).toBe(0);
    setRecords([
      {
        id: "old-record",
        state: "ended",
        cwd: recordRepo,
        workspace: wsDir(recordRepo, "historic"),
      },
    ]);
    const args = ["gc", "--all", "--dry-run", "--include-unrecorded", "--json"];
    const dry = await ws(args, stateRepo, env);
    expect(dry.code, dry.err).toBe(0);
    const schema = jsonOf(
      z.object({
        repositories: z.array(
          z.object({
            root: z.string(),
            sources: z.array(z.string()),
            status: z.string(),
            counts: z.object({ total: z.number() }),
          }),
        ),
        counts: z.object({ total: z.number() }),
        discovery: z.object({
          state: z.number(),
          record: z.number(),
          L2: z.number(),
          note: z.string(),
        }),
        rows: z.array(z.array(z.string())),
      }),
    );
    const checked = schema.safeParse(dry.out);
    expect(checked.success, dry.out).toBe(true);
    if (!checked.success) return;
    const parsed = checked.data;
    expect(parsed.repositories).toHaveLength(3);
    expect(parsed.discovery).toMatchObject({ state: 2, record: 1, L2: 0 });
    expect(parsed.discovery.note).toContain("unindexed historical");
    expect(parsed.counts.total).toBe(3);
    expect(
      parsed.repositories.find((r) => r.root === recordRepo)?.sources,
    ).toEqual(["record"]);
    expect(
      parsed.rows.some(
        (r) => r[0] === wsDir(stateRepo, "protected") && r[2] === "keep",
      ),
    ).toBe(true);
    expect(
      parsed.rows.some((r) => r[0] === wsDir(recordRepo, "historic")),
    ).toBe(true);
    rmSync(missingRepo, { recursive: true, force: true });
    const missing = await ws(args, stateRepo, env);
    expect(missing.code).toBe(1);
    const missingParsed = schema.safeParse(missing.out);
    expect(missingParsed.success, missing.out).toBe(true);
    if (!missingParsed.success) return;
    const unreachable = missingParsed.data.repositories.find(
      (r) => r.root === missingRepo,
    );
    expect(unreachable).toMatchObject({
      status: "unreachable",
      sources: ["state"],
      counts: { total: 0 },
    });
    expect(existsSync(wsDir(missingRepo, "missing"))).toBe(true);
    const real = await ws(
      ["gc", "--all", "--include-unrecorded", "--json"],
      stateRepo,
      env,
    );
    expect(real.code).toBe(1);
    expect(existsSync(wsDir(stateRepo, "protected"))).toBe(true);
    expect(existsSync(wsDir(missingRepo, "missing"))).toBe(true);
    setRecords([]);
  });
});
