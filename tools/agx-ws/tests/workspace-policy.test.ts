// trunk marker, untracked content and the shared [ws] policy. Split from workspace.test.ts so that the gate runs the parts side by side.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readlinkSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { mkdir, chmod, unlink, symlink } from "node:fs/promises";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { untrackedContent } from "../src/workspace.ts";
import {
  scratch,
  localPolicyFiles,
  bin,
  baseEnv,
  run,
  ws,
  jj,
  pushBookmark,
  setRecords,
  repo,
  wsDir,
  brokenFixture,
} from "./workspace-fixture.ts";

setDefaultTimeout(60_000);

const writeL2 = async (path: string, name: string, policy: string) => {
  const directory = join(scratch, "config", "agx", "repos");
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, `${name}.toml`);
  await Bun.write(
    configPath,
    `schema = 1\nroot = ${JSON.stringify(path)}\n[ws]\n${policy}`,
  );
  localPolicyFiles.push(configPath);
};

test("ws contract: rm help names the discard-broken patch path and the landed rule", async () => {
  const fixture = await brokenFixture("help-patch");
  const help = await ws(["rm", "--help"], fixture.path, fixture.env);
  expect(help.code, help.err).toBe(0);
  expect(help.out).toContain("$AGX_STATE_DIR/ws-rm/<slug>-<UTC>-<UUID>.patch");
  expect(help.out).toContain("~/.local/state/agx");
  expect(help.out).toContain("reachable from trunk or a remote bookmark");
  expect(help.out).toContain("content already landed on trunk");
  expect(help.out).toContain("a verified landed record still matches");
  const removed = await ws(
    ["rm", "--discard-broken", "help-patch"],
    fixture.path,
    fixture.env,
  );
  expect(removed.code, removed.err).toBe(0);
  const patch = removed.err.match(/ws: saved patch ([^\n]+)/u)?.[1];
  expect(patch).toBeDefined();
  expect(dirname(patch ?? "")).toBe(
    join(fixture.env.AGX_STATE_DIR ?? "", "ws-rm"),
  );
});

test("ws contract: rm --discard-broken saves the patch then removes a broken workspace", async () => {
  const fixture = await brokenFixture("save-patch");
  await Bun.write(
    join(fixture.dir, "binary.dat"),
    new Uint8Array([0, 1, 2, 255]),
  );
  const result = await ws(
    ["rm", "--discard-broken", "save-patch"],
    fixture.path,
    fixture.env,
  );
  expect(result.code, result.err).toBe(0);
  const patch = result.err.match(/ws: saved patch ([^\n]+)/u)?.[1];
  expect(patch).toBeDefined();
  expect(await Bun.file(patch ?? "").text()).toContain("+disk change");
  const applied = await run(["git", "apply", "-p2", patch ?? ""], fixture.path);
  expect(applied.code, applied.err).toBe(0);
  expect(await Bun.file(join(fixture.path, "a.txt")).text()).toBe(
    "disk change\n",
  );
  expect([
    ...new Uint8Array(
      await Bun.file(join(fixture.path, "binary.dat")).arrayBuffer(),
    ),
  ]).toEqual([0, 1, 2, 255]);
  expect(existsSync(fixture.dir)).toBe(false);
  expect((await jj(["workspace", "list"], fixture.path)).out).not.toContain(
    "ws_save-patch:",
  );
});

test("ws contract: rm --discard-broken saves a patch for a broken workspace with tracked symlinks", async () => {
  const fixture = await brokenFixture("link-patch");
  await symlink("old-target", join(fixture.path, "link"));
  expect((await jj(["commit", "-m", "track link"], fixture.path)).code).toBe(0);
  expect(
    (await jj(["bookmark", "set", "main", "-r", "@-"], fixture.path)).code,
  ).toBe(0);
  await symlink("missing-target", join(fixture.dir, "link"));
  const state = join(scratch, "link-patch-state", "nested");
  const result = await ws(
    ["rm", "--discard-broken", "link-patch"],
    fixture.path,
    {
      ...fixture.env,
      AGX_STATE_DIR: state,
    },
  );
  expect(result.code, result.err).toBe(0);
  const patch = result.err.match(/ws: saved patch ([^\n]+)/u)?.[1];
  expect(patch).toBeDefined();
  const contents = await Bun.file(patch ?? "").text();
  expect(contents).toContain("-old-target");
  expect(contents).toContain("+missing-target");
  expect(contents).toContain("120000");
  const applied = await run(["git", "apply", "-p2", patch ?? ""], fixture.path);
  expect(applied.code, applied.err).toBe(0);
  expect(readlinkSync(join(fixture.path, "link"))).toBe("missing-target");
  expect(existsSync(fixture.dir)).toBe(false);
});

for (const flag of [true, false]) {
  test(
    flag
      ? "ws contract: rm --discard-broken still refuses an unlanded change"
      : "ws contract: plain rm of a broken workspace refuses an unlanded change",
    async () => {
      const fixture = await brokenFixture(
        flag ? "unlanded-flag" : "unlanded-plain",
        true,
      );
      const slug = flag ? "unlanded-flag" : "unlanded-plain";
      const result = await ws(
        ["rm", ...(flag ? ["--discard-broken"] : []), slug],
        fixture.path,
        fixture.env,
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain("unlanded fixture");
      expect(existsSync(fixture.dir)).toBe(true);
      expect((await jj(["workspace", "list"], fixture.path)).out).toContain(
        `ws_${slug}:`,
      );
    },
  );
}

test("ws contract: rm --discard-broken accepts a landed copy and saves disk changes", async () => {
  const fixture = await brokenFixture("landed-copy", true);
  await Bun.write(join(fixture.path, "a.txt"), "revision change\n");
  expect((await jj(["commit", "-m", "landed copy"], fixture.path)).code).toBe(
    0,
  );
  expect(
    (await jj(["bookmark", "set", "main", "-r", "@-"], fixture.path)).code,
  ).toBe(0);
  const result = await ws(
    ["rm", "--discard-broken", "landed-copy"],
    fixture.path,
    fixture.env,
  );
  expect(result.code, result.err).toBe(0);
  const patch = result.err.match(/ws: saved patch ([^\n]+)/u)?.[1];
  expect(patch).toBeDefined();
  expect(await Bun.file(patch ?? "").text()).toContain("+disk change");
  expect(existsSync(fixture.dir)).toBe(false);
});

test("ws contract: rm --discard-broken removes nothing when the patch cannot be written", async () => {
  const fixture = await brokenFixture("patch-failure");
  const blocked = join(scratch, "not-a-directory");
  await Bun.write(blocked, "file");
  const result = await ws(
    ["rm", "--discard-broken", "patch-failure"],
    fixture.path,
    { ...fixture.env, AGX_STATE_DIR: blocked },
  );
  expect(result.code).toBe(1);
  expect(result.err).toContain("cannot save broken workspace patch");
  expect(existsSync(fixture.dir)).toBe(true);
  expect((await jj(["workspace", "list"], fixture.path)).out).toContain(
    "ws_patch-failure:",
  );
});

test("ws contract: a tracked symlink to a directory is compared as a link", async () => {
  const path = await repo();
  await mkdir(join(path, "target"));
  await symlink("target", join(path, "link"));
  expect((await jj(["commit", "-m", "track link"], path)).code).toBe(0);
  expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
    0,
  );
  const clean = wsDir(path, "link-clean");
  const changed = wsDir(path, "link-changed");
  for (const dir of [clean, changed]) {
    await mkdir(join(dir, "target"), { recursive: true });
    await Bun.write(join(dir, "a.txt"), "a\n");
  }
  await symlink("target", join(clean, "link"));
  await symlink("other", join(changed, "link"));
  const refused = await ws(["rm", "link-changed"], path);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("tracked files differ from trunk(): link");
  expect(existsSync(changed)).toBe(true);
  const removed = await ws(["rm", "link-clean"], path);
  expect(removed.code, removed.err).toBe(0);
  expect(existsSync(clean)).toBe(false);
});

test("ws contract: a refused rm leaves the directory and the jj entry untouched", async () => {
  const path = await repo('trunk = "main"\n');
  setRecords([]);
  expect((await ws(["add", "compare-failure"], path)).code).toBe(0);
  const dir = wsDir(path, "compare-failure");
  const before = (await jj(["workspace", "list"], path)).out;
  const realJj = Bun.which("jj");
  const wrapper = join(scratch, "compare-failure-bin");
  const marker = join(scratch, "compare-failure-once");
  await mkdir(wrapper);
  await Bun.write(
    join(wrapper, "jj"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log")) process.exit(1);
if (args.includes("file") && args.includes("show") && args.includes("a.txt") && !await Bun.file(${JSON.stringify(marker)}).exists()) {
  await Bun.write(${JSON.stringify(marker)}, "failed");
  process.stderr.write("injected comparison failure\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit", stderr:"inherit"});
process.exitCode = await child.exited;
`,
  );
  await chmod(join(wrapper, "jj"), 0o755);
  const result = await ws(
    ["rm", "compare-failure"],
    path,
    baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
  );
  expect(result.code).toBe(1);
  expect(result.err).toContain("injected comparison failure");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("a\n");
  expect((await jj(["workspace", "list"], path)).out).toBe(before);
});

test("ws contract: rm finishes a workspace whose directory is already gone", async () => {
  const path = await repo('trunk = "main"\n');
  setRecords([]);
  expect((await ws(["add", "missing"], path)).code).toBe(0);
  expect((await ws(["add", "neighbor"], path)).code).toBe(0);
  rmSync(wsDir(path, "missing"), { recursive: true });
  const result = await ws(["rm", "missing"], path);
  expect(result.code, result.err).toBe(0);
  const names = (await jj(["workspace", "list"], path)).out;
  expect(names).not.toContain("ws_missing:");
  expect(names).toContain("ws_neighbor:");
  expect(await Bun.file(join(wsDir(path, "neighbor"), "a.txt")).text()).toBe(
    "a\n",
  );
});

test("ws contract: rm finishes a workspace forgotten before rename", async () => {
  const path = await repo('trunk = "main"\n');
  setRecords([]);
  expect((await ws(["add", "forgotten"], path)).code).toBe(0);
  const dir = wsDir(path, "forgotten");
  expect((await jj(["workspace", "forget", "ws_forgotten"], path)).code).toBe(
    0,
  );
  expect(existsSync(dir)).toBe(true);
  const result = await ws(["rm", "forgotten"], path);
  expect(result.code, result.err).toBe(0);
  expect(existsSync(dir)).toBe(false);
  expect((await jj(["workspace", "list"], path)).out).not.toContain(
    "ws_forgotten:",
  );
});

test("ws contract: cleanup failure reports the already removed workspace as removed", async () => {
  const path = await repo('trunk = "main"\n');
  setRecords([]);
  expect((await ws(["add", "cleanup-failure"], path)).code).toBe(0);
  const wrapper = join(scratch, "cleanup-failure-bin");
  await mkdir(wrapper);
  await Bun.write(
    join(wrapper, "rip"),
    "#!/bin/sh\necho injected cleanup failure >&2\nexit 1\n",
  );
  await chmod(join(wrapper, "rip"), 0o755);
  const result = await ws(
    ["rm", "cleanup-failure"],
    path,
    baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
  );
  expect(result.code, result.err).toBe(0);
  expect(result.err).toContain("tombstone cleanup failed");
  expect(existsSync(wsDir(path, "cleanup-failure"))).toBe(false);
  expect((await jj(["workspace", "list"], path)).out).not.toContain(
    "ws_cleanup-failure:",
  );
});

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

  // Since 1.22.32 ignored and declared regenerable paths do not retain a workspace.
  for (const [artifact, declaration, kept] of [
    [".state/plan.json", "", false],
    ["loose.txt", "", true],
    ["nested/node_modules/pkg/index.js", "", false],
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
        artifact === "loose.txt" || artifact === "cache-other/live.json"
          ? "# keep loose.txt untracked\n"
          : `${artifact.split("/")[0]}\n`,
      );
      await jj(["commit", "-m", "ignore"], dir);
      await jj(["bookmark", "set", "main", "-r", "@-"], dir);
      await Bun.write(join(dir, artifact), "live artifact\n");
      for (const dry of [true, false]) {
        const result = await ws(
          [
            "gc",
            "--include-unrecorded",
            ...(dry ? ["--dry-run"] : ["--apply"]),
          ],
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
      `#!/usr/bin/env bun\nconst args = process.argv.slice(2); const perWorkspaceInventory = process.cwd() !== ${JSON.stringify(path)} && args.includes("list") && args.includes("file"); if (perWorkspaceInventory) { await Bun.write(${JSON.stringify(trace)}, "called"); process.stderr.write("unexpected per-workspace inventory"); process.exit(1); } const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exitCode = await child.exited;\n`,
    );
    chmodSync(fake, 0o755);
    const workspaceList = await run(
      [
        "jj",
        "--ignore-working-copy",
        "--at-operation=@",
        "-R",
        path,
        "workspace",
        "list",
        "-T",
        'json({"name" => self.name(), "root" => self.root(), "target" => self.target().commit_id(), "change" => self.target().change_id().short(12), "age" => self.target().committer().timestamp().ago()}) ++ "\\n"',
      ],
      path,
      baseEnv({ PATH: `${errorBin}:${bin}:${process.env.PATH}` }),
    );
    console.log(`workspace list debug: ${JSON.stringify(workspaceList)}`);
    const result = await ws(
      ["gc", "--include-unrecorded", "--dry-run", "--json"],
      path,
      baseEnv({ PATH: `${errorBin}:${bin}:${process.env.PATH}` }),
    );
    expect(result.code, result.err + result.out).toBe(0);
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
      `#!/usr/bin/env bun\nconst args = process.argv.slice(2); const perWorkspaceInventory = process.cwd() !== ${JSON.stringify(path)} && args.includes("list") && args.includes("file"); if (perWorkspaceInventory) { await Bun.write(${JSON.stringify(trace)}, "called"); await Bun.sleep(1250); } const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exitCode = await child.exited;\n`,
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

describe("ws contract: shared agx.toml [ws] policy", () => {
  for (const source of ["L1", "L2 ready override and keep union"]) {
    // Both policy cases measured over 5 seconds across workspace subprocesses.
    test(`${source}: add, rm, gc and doctor use the shared policy`, async () => {
      const l1 =
        source === "L1"
          ? 'trunk = "main"\nready = ["printf chosen-ready"]\nkeep = ["ws_safe"]\n'
          : 'trunk = "main"\nready = ["printf wrong-ready"]\nkeep = ["ws_other"]\n';
      const path = await repo(l1);
      if (source === "L2 ready override and keep union")
        await writeL2(
          path,
          "shared-policy-l2",
          'ready = ["printf chosen-ready"]\nkeep = ["ws_safe"]\n',
        );

      const added = await ws(["add", "safe"], path);
      expect(added.code, added.err).toBe(0);
      expect(added.out).toContain("chosen-ready");
      expect(added.out).not.toContain("wrong-ready");
      const tracked = await jj(["file", "list"], path);
      expect(tracked.code, tracked.err).toBe(0);
      expect(tracked.out).toContain("agx.toml");
      expect(tracked.out).not.toContain(".ws.toml");

      const safe = wsDir(path, "safe");
      await Bun.write(
        join(safe, "agx.toml"),
        'schema = 1\n[ws]\ntrunk = "wrong-checkout"\nkeep = []\n',
      );
      const refused = await ws(["rm", "safe"], safe);
      expect(refused.code, refused.err).toBe(1);
      expect(refused.err).toContain("is kept by [ws].keep");
      const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], safe);
      expect(dry.code, dry.err).toBe(0);
      expect(dry.out).toContain(`${safe}\tws\tkeep\t`);

      const safeGit = join(safe, ".git");
      await Bun.write(safeGit, `gitdir: ${join(path, ".git")}\n`);
      const inventory = `import { doctorInventory } from ${JSON.stringify(join(import.meta.dir, "../src/doctor.ts"))}; console.log(JSON.stringify(await doctorInventory()));`;
      const doctor = await run(
        ["bun", "-e", inventory],
        safe,
        baseEnv({ AGX_REPOS_ROOT: join(path, "..", "proj.ws") }),
      );
      expect(doctor.code, doctor.err).toBe(0);
      expect(doctor.out).toContain('"ok":true');
      expect(doctor.out).toContain('"name":"ws_safe"');
      expect(doctor.out).toContain('"verdict":"kept"');
      await unlink(safeGit);

      // The spare only supplies a removable GC fixture; safe already tests ws add and ready.
      const spare = await jj(
        ["workspace", "add", "--name", "ws_spare", wsDir(path, "spare")],
        path,
      );
      expect(spare.code, spare.err).toBe(0);
      const collected = await ws(
        ["gc", "--apply", "--include-unrecorded"],
        safe,
      );
      expect(collected.code, collected.err + collected.out).toBe(0);
      expect(collected.out).toContain(`${safe}\tws\tkeep\t`);
      expect(collected.out).toContain(
        `${wsDir(path, "spare")}\tws\tremovable\t`,
      );
      expect(existsSync(safe)).toBe(true);
      expect(existsSync(wsDir(path, "spare"))).toBe(false);
    });
  }

  test("rejects invalid L2 policy instead of using L1", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "safe"], path)).code).toBe(0);
    const directory = join(scratch, "config", "agx", "repos");
    await mkdir(directory, { recursive: true });
    const policyPath = join(
      directory,
      `invalid-${path.split("/").at(-2)}.toml`,
    );
    await Bun.write(
      policyPath,
      `schema = 1\nroot = ${JSON.stringify(path)}\n[ws]\nkeep = "invalid"\n`,
    );
    await using _cleanup = {
      [Symbol.asyncDispose]: () => unlink(policyPath),
    };
    for (const args of [
      ["add", "other"],
      ["rm", "safe"],
      ["gc", "--apply", "--include-unrecorded"],
    ]) {
      const result = await ws(args, path);
      expect(result.code, result.err).toBe(1);
      expect(result.err).toContain(policyPath);
    }
    const safeGit = join(wsDir(path, "safe"), ".git");
    await Bun.write(safeGit, `gitdir: ${join(path, ".git")}\n`);
    const doctor = await ws(
      ["doctor"],
      path,
      baseEnv({ AGX_REPOS_ROOT: join(path, "..", "proj.ws") }),
    );
    expect(doctor.code, doctor.err).toBe(1);
    expect(doctor.err).toContain(policyPath);
    expect(existsSync(wsDir(path, "safe"))).toBe(true);
    await unlink(safeGit);
  });
});

test("ws contract: ws add runs every declared ready command in order", async () => {
  const path = await repo(
    'trunk = "main"\nready = ["mkdir -p node_modules/neverthrow && printf installed > node_modules/neverthrow/.ready", "test -s node_modules/neverthrow/.ready && printf verified > ready-order.txt"]\n',
  );
  const added = await ws(["add", "ready-order"], path);
  expect(added.code, added.err).toBe(0);
  const dir = wsDir(path, "ready-order");
  expect(
    await Bun.file(join(dir, "node_modules/neverthrow/.ready")).text(),
  ).toBe("installed");
  expect(await Bun.file(join(dir, "ready-order.txt")).text()).toBe("verified");
  expect(added.err).toContain(
    "ws: ready: will run 1/2: mkdir -p node_modules/neverthrow && printf installed > node_modules/neverthrow/.ready",
  );
  expect(added.err).toContain(
    "ws: ready: will run 2/2: test -s node_modules/neverthrow/.ready && printf verified > ready-order.txt",
  );
});

test("ws contract: ws add names the policy revision and an uncommitted agx.toml", async () => {
  const path = await repo('trunk = "main"\n');
  const selected = await jj(
    ["log", "--no-graph", "-r", "trunk()", "-T", "commit_id"],
    path,
  );
  expect(selected.code, selected.err).toBe(0);
  const revision = selected.out.trim();
  expect(revision).not.toBe("");
  await Bun.write(
    join(path, "agx.toml"),
    'schema = 1\n[ws]\ntrunk = "main"\nready = ["touch working-copy-ready.out"]\n',
  );

  const added = await ws(["add", "uncommitted-policy"], path);
  expect(added.code, added.err).toBe(0);
  expect(added.err).toContain(`ws: policy: agx.toml at ${revision}`);
  expect(added.err).toContain(
    `ws: policy: working-copy agx.toml differs from the policy snapshot at ${revision}; working-copy policy is not used`,
  );
  expect(added.err).toContain(
    `ws: ready: none declared in agx.toml at ${revision}`,
  );
  expect(
    await Bun.file(
      join(wsDir(path, "uncommitted-policy"), "working-copy-ready.out"),
    ).exists(),
  ).toBe(false);
});

test("config contract: printed .ws.toml migration is accepted", async () => {
  const path = await repo('trunk = "main"\nkeep = ["ws_safe"]\n');
  expect((await ws(["add", "safe"], path)).code).toBe(0);
  const legacy =
    'ready = ["printf old-ready"]\ntrunk = "main"\nkeep = ["ws_safe"]\nregenerable = ["build/generated"]\n';
  await Bun.write(join(path, ".ws.toml"), legacy);
  const renderedMigration = Bun.TOML.stringify({
    schema: 1,
    ws: Bun.TOML.parse(legacy),
  });
  expect(renderedMigration).toBeDefined();
  if (renderedMigration === undefined) return;
  const migration = renderedMigration.trimEnd();
  expect(migration.startsWith("schema = 1\n")).toBe(true);
  const expected = `ws: ${join(path, ".ws.toml")} is retired. Replace agx.toml with:\n${migration}\nThen delete .ws.toml.\n`;
  const commands = [
    ["add", "blocked"],
    ["refresh", "safe"],
    ["rm", "safe"],
    ["gc", "--dry-run", "--repo", path],
  ];
  for (const args of commands) {
    const result = await ws(args, path);
    expect(result.code, `${args.join(" ")}: ${result.err}`).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toBe(expected);
  }
  const safeGit = join(wsDir(path, "safe"), ".git");
  await Bun.write(safeGit, `gitdir: ${join(path, ".git")}\n`);
  const doctor = await ws(
    ["doctor"],
    path,
    baseEnv({ AGX_REPOS_ROOT: join(path, "..", "proj.ws") }),
  );
  expect(doctor.code, doctor.err).toBe(2);
  expect(doctor.out).toBe("");
  expect(doctor.err).toBe(expected);
  expect(existsSync(wsDir(path, "safe"))).toBe(true);
  await unlink(safeGit);

  await Bun.write(join(path, "agx.toml"), migration);
  await unlink(join(path, ".ws.toml"));
  const commit = await jj(
    ["commit", "-m", "Commit migrated workspace config"],
    path,
  );
  expect(commit.code, commit.err).toBe(0);
  const bookmark = await jj(["bookmark", "set", "main", "-r", "@-"], path);
  expect(bookmark.code, bookmark.err).toBe(0);
  const migrated = await ws(["gc", "--dry-run", "--repo", path], path);
  expect(migrated.code, migrated.err).toBe(0);
});

test("config contract: gc names committed revision when working copy differs", async () => {
  const path = await repo('trunk = "main"\n');
  const configPath = join(path, "agx.toml");
  const committed = '[ws]\ntrunk = "main"\n';
  await Bun.write(configPath, committed);
  const commit = await jj(["commit", "-m", "Commit schema-less policy"], path);
  expect(commit.code, commit.err).toBe(0);
  const bookmark = await jj(["bookmark", "set", "main", "-r", "@-"], path);
  expect(bookmark.code, bookmark.err).toBe(0);

  await Bun.write(configPath, `schema = 1\n${committed}`);
  const identity = await jj(
    [
      "log",
      "--no-graph",
      "-r",
      "trunk()",
      "-T",
      'bookmarks.join(", ") ++ " " ++ commit_id.short(8)',
    ],
    path,
  );
  expect(identity.code, identity.err).toBe(0);
  expect(identity.out.trim()).toMatch(/^main [a-f0-9]{8}$/u);

  const result = await ws(["gc", "--dry-run", "--repo", path], path);
  expect(result.code, result.err).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain(`agx.toml at ${identity.out.trim()}`);
  expect(result.err).toContain("working copy differs from this revision");
  expect(result.err).toContain("working copy policy is not read");
  expect(result.err).toContain("missing required schema; expected schema = 1");
});

test("ws contract: an older jj is refused before any call with the required version", async () => {
  const path = await repo('trunk = "main"\n');
  const fakeBin = join(scratch, "old-jj-bin");
  mkdirSync(fakeBin);
  const trace = join(scratch, "old-jj-calls");
  const realJj = Bun.which("jj");
  expect(realJj).not.toBeNull();
  const fake = join(fakeBin, "jj");
  await Bun.write(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(trace)}\nif [ "$1" = "--version" ]; then echo 'jj 0.45.1'; exit 0; fi\nexec ${JSON.stringify(realJj)} "$@"\n`,
  );
  chmodSync(fake, 0o755);
  const directory = join(scratch, "config", "agx", "repos");
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "old-jj.toml");
  await Bun.write(configPath, `schema = 1\nroot = ${JSON.stringify(path)}\n`);
  localPolicyFiles.push(configPath);
  const result = await ws(
    ["gc", "--all", "--dry-run"],
    path,
    baseEnv({ PATH: `${fakeBin}:${bin}:${process.env.PATH}` }),
  );
  expect(result.code).not.toBe(0);
  expect(result.err).toBe(
    "agx: jj 0.46.0 or newer required; found jj 0.45.1\n",
  );
  expect(result.out).toBe("");
  const calls = await Bun.file(trace).text();
  expect(
    calls
      .trim()
      .split("\n")
      .filter((line) => line === "--version"),
  ).toHaveLength(1);
  expect(calls).not.toMatch(/(?:^|\s)-T(?:\s|$)/u);
});

test("ws contract: gc --all reports one refused row and continues", async () => {
  const legacyRepo = await repo('trunk = "main"\n');
  const normalRepo = await repo('trunk = "main"\n');
  await Bun.write(join(legacyRepo, ".ws.toml"), 'trunk = "main"\n');

  const directory = join(scratch, "config", "agx", "repos");
  await mkdir(directory, { recursive: true });
  for (const [name, root] of [
    ["legacy", legacyRepo],
    ["normal", normalRepo],
  ]) {
    const configPath = join(directory, `${name}.toml`);
    await Bun.write(configPath, `schema = 1\nroot = ${JSON.stringify(root)}\n`);
    localPolicyFiles.push(configPath);
  }

  setRecords([]);
  const result = await ws(
    [
      "gc",
      "--all",
      "--dry-run",
      "--include-unrecorded",
      "--grace-minutes",
      "0",
      "--json",
    ],
    normalRepo,
    baseEnv({ AGX_STATE_DIR: join(scratch, "gc-all-state") }),
  );
  expect(result.code, result.err).toBe(2);
  const roots = [legacyRepo, normalRepo].map((root) =>
    root.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  );
  const progress = new RegExp(
    `^gc --all (?:start (?:${roots.join("|")})|end (?:${roots.join("|")}) elapsed=\\d+\\.\\d{3}s (?:rows=\\d+(?: failure=incomplete)?|failure=(?:refused|unreachable|FAILED)))\\n`,
    "gmu",
  );
  expect(result.err.replaceAll(progress, ""), result.out).toBe("");
  expect(`${result.err}unexpected stderr\n`.replaceAll(progress, "")).toBe(
    "unexpected stderr\n",
  );
  const parsed = jsonOf(
    z.object({
      rows: z.array(z.array(z.string())),
      refused: z.array(z.string()),
      complete: z.boolean(),
      repositories: z.array(z.object({ root: z.string(), status: z.string() })),
    }),
  ).safeParse(result.out);
  expect(parsed.success, result.out).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.refused).toEqual([legacyRepo]);
  expect(parsed.data.complete).toBe(false);
  expect(
    parsed.data.rows.filter(
      (row) =>
        row[0] === legacyRepo && row[1] === "repo" && row[2] === "refused",
    ),
  ).toHaveLength(1);
  expect(
    parsed.data.repositories.find((row) => row.root === normalRepo)?.status,
  ).toBe("complete");
});
