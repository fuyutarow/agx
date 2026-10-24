import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeChangeset } from "../changeset/changeset.ts";
import { applyChangesets } from "../changeset/apply.ts";
import { jsonOf, z } from "../zod.ts";
import {
  build as productionBuild,
  changelogSection,
  packageInfo,
  platform,
  packages,
  suiteNotes,
  repository,
  run as productionRun,
} from "./release.ts";

import { fixtureRun as run } from "./fixture-runner.ts";

const build = (pkg: string, target: string | undefined, root: string) =>
  productionBuild(pkg, target, root, run);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(pkg = "agx-status") {
  const root = await mkdtemp(join(tmpdir(), "package-release-"));
  roots.push(root);
  const dir = join(root, "tools", pkg);
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@agx/${pkg}`,
      version: "2.3.4",
      bin: { [pkg]: "src/main.ts" },
    }),
  );
  await Bun.write(
    join(dir, "src/main.ts"),
    'process.stdout.write("fixture executable\\n");\n',
  );
  await Bun.write(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## 2.3.4\n\n- This version only.\n\n## 2.3.3\n\n- Earlier version.\n",
  );
  await Bun.write(join(root, "package.json"), '{"version":"99.99.99"}');
  await mkdir(join(root, "tools/release"), { recursive: true });
  for (const file of [
    "build.ts",
    "publish.ts",
    "release.ts",
    "fixture-runner.ts",
    "fake-gh.ts",
  ])
    await Bun.write(
      join(
        root,
        "tools/release",
        file === "release.ts" ? "implementation.ts" : file,
      ),
      Bun.file(join(import.meta.dir, file)),
    );
  await Bun.write(
    join(root, "tools/release/release.ts"),
    `
import * as release from "./implementation.ts";
import { fixtureRun } from "./fixture-runner.ts";
export const build = (pkg, target) => release.build(pkg, target, ${JSON.stringify(root)}, fixtureRun);
export const publish = (pkg, yes, target) => release.publish(pkg, yes, target, ${JSON.stringify(root)}, fixtureRun);
`,
  );
  await symlink(join(repository, "tools/zod.ts"), join(root, "tools/zod.ts"));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await Bun.write(join(root, ".gitignore"), "dist/\ncalls\n");
  return { root, dir, pkg };
}

async function preview(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(f.root, "tools/release/publish.ts"),
      f.pkg,
      ...args,
    ],
    {
      cwd: f.root,
      env: {
        ...process.env,
        RELEASE_TEST_FAST_LIBRARY: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

async function git(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const result = await run(["git", ...args], f.root, true);
  expect(result.exit, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function gitSuiteFixture() {
  const f = await suiteFixture();
  await git(f, ["init", "-b", "alpha"]);
  await git(f, ["config", "user.email", "release-test@example.invalid"]);
  await git(f, ["config", "user.name", "Release test"]);
  await git(f, ["add", "-A"]);
  await git(f, ["commit", "-m", "fixture"]);
  const alpha = await git(f, ["rev-parse", "HEAD"]);
  await git(f, ["update-ref", "refs/remotes/origin/alpha", alpha]);
  return { ...f, alpha };
}

const realGit = { RELEASE_TEST_REAL_GIT: "1" };

test("command fixtures refuse network Git and unknown processes and intercept gh", async () => {
  const f = await fixture();
  for (const cmd of [
    ["git", "fetch", "https://example.invalid/repo"],
    ["git", "push", "origin", "alpha"],
    ["git", "ls-remote", "origin"],
    ["curl", "https://example.invalid"],
  ]) {
    const result = await run(cmd, f.root, true);
    expect(result.exit).toBe(98);
    expect(result.stderr).toContain("Forbidden");
  }
  const github = await run(
    ["gh", "release", "create", "fixture"],
    f.root,
    true,
  );
  expect(github.exit).toBe(99);
  expect(await Bun.file(join(f.root, "calls")).text()).toContain(
    '["release","create","fixture"]',
  );
});

test("package versions, tags and archive names ignore the repository version", async () => {
  const f = await fixture();
  const info = await packageInfo("agx-status", f.root);
  expect(info.isOk() && info.value.tag).toBe("agx-status@2.3.4");
  const result = await build("agx-status", undefined, f.root);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return;
  expect(result.value.archive).toEndWith(
    `agx-status-2.3.4-${process.platform}-${process.arch}.tar.gz`,
  );
  expect(result.value.sha256).toMatch(/^[a-f\d]{64}$/u);
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  expect(listing.exit).toBe(0);
  expect(listing.stdout.trim().split("\n").toSorted()).toEqual([
    "bin/",
    "bin/agx-status",
  ]);
  const executable = await run(
    [join(f.root, "dist/agx-status/bin/agx-status")],
    f.root,
  );
  expect(executable.exit).toBe(0);
  expect(executable.stdout).toBe("fixture executable\n");
});

test("xmsg archive compiles agx-msg once and preserves its hard-link alias", async () => {
  const f = await fixture("xmsg");
  await mkdir(join(f.root, "dist/xmsg/bin"), { recursive: true });
  await Bun.write(join(f.root, "dist/xmsg/bin/stale"), "old");
  const result = await build("xmsg", undefined, f.root);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return;
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  expect(listing.stdout.trim().split("\n").toSorted()).toEqual([
    "bin/",
    "bin/agx-msg",
    "bin/xmsg",
  ]);
  await messagingAlias(f.root, result.value.archive);
  const calls = (await Bun.file(join(f.root, "calls")).text())
    .trim()
    .split("\n");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/bin/agx-msg");
});

test("unknown packages exit 2 without producing an archive", async () => {
  const f = await fixture("agx-usehooks");
  await Bun.write(join(f.dir, "package.json"), '{"version":"1.0.0"}');
  for (const pkg of ["unknown", "../agx-status"]) {
    const result = await run(
      [process.execPath, join(f.root, "tools/release/build.ts"), pkg],
      f.root,
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("Unknown package");
  }
});

test("publish defaults to dry-run and includes all sections since previous suite tag", async () => {
  const f = await suiteFixture();
  for (const pkg of packages) {
    const path = join(f.root, "tools", pkg, "CHANGELOG.md");
    await Bun.write(
      path,
      (await Bun.file(path).text()) + "\n## 2.3.2\n\n- Oldest version.\n",
    );
  }
  const result = await preview(f, [], { RELEASE_TEST_PREVIOUS: "1" });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("DRY RUN");
  expect(result.stdout.match(/'gh' 'release' 'create'/gu)).toHaveLength(1);
  expect(result.stdout).toContain("agx-usehooks-2.3.4.tgz");
  if (process.env.AGX_RELEASE_PLAN_RECEIPT !== undefined)
    await Bun.write(process.env.AGX_RELEASE_PLAN_RECEIPT, result.stdout);
  expect(result.stdout).toContain("'git' 'tag' 'agx-status@2.3.4'");
  expect(result.stdout).toContain("'gh' 'release' 'create' 'v2.3.4'");
  expect(result.stdout).toContain(
    "'--target' '0123456789012345678901234567890123456789'",
  );
  const calls = await Bun.file(join(f.root, "calls")).text();
  expect(calls).not.toContain('["tag"');
  expect(calls).not.toContain('["release"');
  const notes = await Bun.file(
    join(f.root, "dist/suite/release-notes.md"),
  ).text();
  expect(notes).toContain("This version only");
  expect(notes).toContain("Earlier version");
  expect(notes).not.toContain("Oldest version");
});

test("publish reads precisely the dated section produced by release:version", async () => {
  const f = await suiteFixture();
  expect(
    (
      await writeChangeset(f.root, "agx-status", "minor", "New release entry.")
    ).isOk(),
  ).toBe(true);
  const applied = await applyChangesets(f.root, "agx-status", "2026-10-23");
  expect(applied.isOk() && applied.value.version).toBe("2.4.0");
  const result = await preview(f);
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("'git' 'tag' 'agx-status@2.4.0'");
  expect(
    await Bun.file(join(f.root, "dist/suite/release-notes.md")).text(),
  ).toContain("## 2.4.0 — 2026-10-23\n\n- New release entry.\n");
  expect(
    await Bun.file(join(f.dir, ".changes/new-release-entry.md")).exists(),
  ).toBe(false);
});

test("publish accepts detached alpha and refuses a different HEAD or an ahead alpha", async () => {
  const f = await gitSuiteFixture();
  await git(f, ["checkout", "--detach", f.alpha]);
  const hostileHome = await mkdtemp(join(tmpdir(), "release-hostile-home-"));
  roots.push(hostileHome);
  // Parsing this config would fail immediately if the runner consulted HOME.
  await Bun.write(join(hostileHome, ".gitconfig"), "[invalid config\n");
  const atAlpha = await preview(f, ["--dry-run"], {
    ...realGit,
    HOME: hostileHome,
  });
  expect(atAlpha.exit, atAlpha.stderr).toBe(0);
  expect(atAlpha.stdout).toContain("DRY RUN");
  await rm(join(f.root, "dist"), { recursive: true, force: true });

  await git(f, ["checkout", "-b", "other"]);
  await Bun.write(join(f.root, "other.txt"), "other commit\n");
  await git(f, ["add", "other.txt"]);
  await git(f, ["commit", "-m", "other"]);
  const other = await git(f, ["rev-parse", "HEAD"]);
  await git(f, ["checkout", "--detach", other]);
  const detachedElsewhere = await preview(f, ["--dry-run"], realGit);
  expect(detachedElsewhere.exit).toBe(2);
  expect(detachedElsewhere.stderr).toContain(`HEAD ${other}`);
  expect(detachedElsewhere.stderr).toContain(`refs/heads/alpha ${f.alpha}`);

  await git(f, ["update-ref", "refs/heads/alpha", other]);
  await git(f, ["checkout", "--detach", other]);
  const aheadOfOrigin = await preview(f, ["--dry-run"], realGit);
  expect(aheadOfOrigin.exit).toBe(2);
  expect(aheadOfOrigin.stderr).toContain(`refs/heads/alpha ${other}`);
  expect(aheadOfOrigin.stderr).toContain(
    `refs/remotes/origin/alpha ${f.alpha}`,
  );
});

test("explicit dry-run refuses dirty copies, existing tags and missing version entries", async () => {
  const f = await suiteFixture();
  const dirty = await preview(f, ["--dry-run"], { RELEASE_TEST_DIRTY: "1" });
  expect(dirty.exit).toBe(2);
  expect(dirty.stderr).toContain("dirty");
  const tagged = await preview(f, ["--dry-run"], { RELEASE_TEST_TAG: "1" });
  expect(tagged.exit).toBe(2);
  expect(tagged.stderr).toContain("Tag already exists: v2.3.4");
  await Bun.write(
    join(f.dir, "CHANGELOG.md"),
    "## 2.3.40\n\n- Wrong version\n",
  );
  const missing = await preview(f, ["--dry-run"]);
  expect(missing.exit).toBe(2);
  expect(missing.stderr).toContain("no entry for 2.3.4");
});

test("execution requires --yes; conflicting flags and excess arguments refuse", async () => {
  const f = await suiteFixture();
  for (const args of [["--yes", "--dry-run"], ["extra"]]) {
    const result = await preview(f, args);
    expect(result.exit).toBe(2);
  }
  const result = await preview(f, ["--yes"]);
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("Release stopped");
  expect(await Bun.file(join(f.root, "calls")).text()).toContain(
    '["tag","v2.3.4"]',
  );
});

const ghStateSchema = z.object({
  draft: z.boolean(),
  attempts: z.record(z.string(), z.number()),
  assets: z.array(
    z.object({ name: z.string(), state: z.string(), size: z.number() }),
  ),
});

async function ghState(root: string) {
  const parsed = jsonOf(ghStateSchema).safeParse(
    await Bun.file(join(root, "gh-state.json")).text(),
  );
  expect(parsed.success).toBe(true);
  return parsed.success
    ? parsed.data
    : { draft: true, attempts: {}, assets: [] };
}

for (const mode of ["success", "retry"]) {
  test(`publish creates an empty draft, checks separate uploads and publishes (${mode})`, async () => {
    const f = await suiteFixture();
    const result = await preview(f, ["--yes"], { RELEASE_TEST_GH_MODE: mode });
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stdout).toStartWith("PUBLISHED\n");
    const state = await ghState(f.root);
    expect(state.draft).toBe(false);
    expect(state.assets).toHaveLength(2);
    for (const asset of state.assets) {
      expect(asset.state).toBe("uploaded");
      expect(asset.size).toBe(
        (await stat(join(f.root, "dist", asset.name))).size,
      );
      expect(state.attempts[asset.name]).toBe(
        mode === "retry" && asset.name.endsWith(".tar.gz") ? 2 : 1,
      );
    }
    const calls = (await Bun.file(join(f.root, "calls")).text()).split("\n");
    const ghCalls = calls.filter((line) => line.startsWith('["release"'));
    expect(ghCalls[0]).toContain('["release","create","v2.3.4","--draft"');
    expect(ghCalls[0]).not.toContain(".tar.gz");
    expect(ghCalls[0]).not.toContain(".tgz");
    expect(ghCalls.filter((line) => line.includes('"create"'))).toHaveLength(1);
    expect(ghCalls.at(-2)).toBe(
      '["release","view","v2.3.4","--json","assets"]',
    );
    expect(ghCalls.at(-1)).toBe(
      '["release","edit","v2.3.4","--draft=false","--latest"]',
    );
    const uploads = ghCalls.filter((line) => line.includes('"upload"'));
    expect(uploads).toHaveLength(mode === "retry" ? 3 : 2);
    expect(uploads[0]).not.toContain("--clobber");
    if (mode === "retry") expect(uploads[1]).toContain("--clobber");
  });
}

for (const mode of ["failure", "silent"]) {
  test(`persistent upload failure names asset and preserves a recoverable draft (${mode})`, async () => {
    const f = await suiteFixture();
    const result = await preview(f, ["--yes"], { RELEASE_TEST_GH_MODE: mode });
    const name = `agx-2.3.4-${process.platform}-${process.arch}.tar.gz`;
    expect(result.exit).toBe(2);
    expect(result.stdout).not.toContain("PUBLISHED");
    expect(result.stderr).toContain(
      `Asset upload failed for ${name} after 3 attempts`,
    );
    expect(result.stderr).toContain(
      mode === "silent"
        ? "no stdout or stderr captured"
        : `HTTP 502: upload failed for ${name}`,
    );
    expect(result.stderr).toContain("exited 1");
    expect(result.stderr).toContain("do not re-create the release");
    expect(result.stderr).toContain(
      `'gh' 'release' 'upload' 'v2.3.4' '${join(f.root, "dist", name)}' '--clobber'`,
    );
    expect(result.stderr).toContain(
      "'gh' 'release' 'view' 'v2.3.4' '--json' 'assets'",
    );
    expect(result.stderr).toContain(
      "'gh' 'release' 'edit' 'v2.3.4' '--draft=false' '--latest'",
    );
    const state = await ghState(f.root);
    expect(state.draft).toBe(true);
    expect(state.attempts[name]).toBe(3);
    const calls = await Bun.file(join(f.root, "calls")).text();
    expect(calls).not.toContain('["release","edit"');
    expect(calls).not.toContain('["release","view"');
    // Execute the printed recovery protocol against the SAME fake release.
    const recover = (args: string[]) =>
      productionRun(
        [
          process.execPath,
          join(import.meta.dir, "fake-gh.ts"),
          "release",
          ...args,
        ],
        f.root,
      );
    for (const asset of [name, "agx-usehooks-2.3.4.tgz"]) {
      const uploaded = await recover([
        "upload",
        "v2.3.4",
        join(f.root, "dist", asset),
        "--clobber",
      ]);
      expect(uploaded.exit, uploaded.stderr).toBe(0);
    }
    const inspected = await recover(["view", "v2.3.4", "--json", "assets"]);
    expect(inspected.exit, inspected.stderr).toBe(0);
    const verified = jsonOf(ghStateSchema.pick({ assets: true })).safeParse(
      inspected.stdout,
    );
    expect(verified.success).toBe(true);
    if (!verified.success) return;
    for (const asset of verified.data.assets) {
      expect(asset.state).toBe("uploaded");
      expect(asset.size).toBe(
        (await stat(join(f.root, "dist", asset.name))).size,
      );
    }
    expect(
      (await recover(["edit", "v2.3.4", "--draft=false", "--latest"])).exit,
    ).toBe(0);
    expect((await ghState(f.root)).draft).toBe(false);
    expect(
      (await Bun.file(join(f.root, "calls")).text()).match(
        /\["release","create"/gu,
      ),
    ).toHaveLength(1);
  });
}

for (const mode of ["missing", "wrong-size", "starter", "malformed"]) {
  test(`asset verification refuses publication (${mode})`, async () => {
    const f = await suiteFixture();
    const result = await preview(f, ["--yes"], { RELEASE_TEST_GH_MODE: mode });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain(
      `agx-2.3.4-${process.platform}-${process.arch}.tar.gz`,
    );
    expect(result.stderr).toContain(
      mode === "malformed"
        ? "Cannot verify assets"
        : "Asset verification failed",
    );
    expect(result.stderr).toContain("Draft v2.3.4 retained");
    expect(result.stdout).not.toContain("PUBLISHED");
    expect((await ghState(f.root)).draft).toBe(true);
    expect(await Bun.file(join(f.root, "calls")).text()).not.toContain(
      '["release","edit"',
    );
  });
}

test("production runner captures stderr and stdout with non-TTY pipes on failure", async () => {
  const f = await fixture();
  const result = await productionRun(
    [
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(262144)); process.stderr.write("pipe-only upload error\\n"); process.exitCode = 1;',
    ],
    f.root,
  );
  expect(result.exit).toBe(1);
  expect(result.stdout).toHaveLength(262144);
  expect(result.stderr).toBe("pipe-only upload error\n");
});

test("target parsing and changelog boundaries", () => {
  expect(platform("bun-linux-x64-baseline").isOk()).toBe(true);
  expect(platform("bun-darwin-arm64").isOk()).toBe(true);
  expect(platform("../../bad").isErr()).toBe(true);
  expect(
    changelogSection(
      "## [2.3.4] - today\n\n- Entry\n## 2.3.3\n- Old",
      "2.3.4",
    ).isOk(),
  ).toBe(true);
  expect(changelogSection("## 2.3.4\n\n## 2.3.3\n- Old", "2.3.4").isErr()).toBe(
    true,
  );
});

async function libraryFixture() {
  const f = await fixture("agx-usehooks");
  for (const path of ["tools/shared", "agents/hooks/vendor"])
    await cp(join(repository, path), join(f.root, path), { recursive: true });
  await cp(join(repository, "tools/agx-usehooks/src"), join(f.dir, "src"), {
    recursive: true,
  });
  for (const file of ["package.json", "README.md", "tsconfig.release.json"])
    await Bun.write(
      join(f.dir, file),
      Bun.file(join(repository, "tools/agx-usehooks", file)),
    );
  const manifest = await Bun.file(join(f.dir, "package.json")).text();
  await Bun.write(
    join(f.dir, "package.json"),
    manifest.replace(/"version": "[^"\n]+"/u, '"version": "2.3.4"'),
  );
  await Bun.write(
    join(f.root, "tsconfig.json"),
    Bun.file(join(repository, "tsconfig.json")),
  );
  await Bun.write(
    join(f.dir, "tests/should-not-ship.ts"),
    "throw new Error('test');",
  );
  await Bun.write(join(f.dir, ".changes/should-not-ship.md"), "pending change");
  return f;
}

test("library tarball installs offline, imports and supplies checked public declarations", async () => {
  const f = await libraryFixture();
  const result = await build(f.pkg, undefined, f.root);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return;
  expect(result.value.archive).toEndWith("agx-usehooks-2.3.4.tgz");
  expect(result.value.sha256).toMatch(/^[a-f\d]{64}$/u);
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  expect(listing.exit).toBe(0);
  const files = listing.stdout.trim().split("\n");
  for (const file of [
    "package.json",
    "index.js",
    "README.md",
    "CHANGELOG.md",
    "types/tools/agx-usehooks/src/index.d.ts",
    "types/agents/hooks/vendor/deps.d.ts",
  ])
    expect(files).toContain(`package/${file}`);
  expect(
    files.every((file) =>
      /^package\/(?:package\.json|index\.js|README\.md|CHANGELOG\.md|types\/.+\.d\.ts)$/u.test(
        file,
      ),
    ),
  ).toBe(true);
  expect(listing.stdout).not.toMatch(/(?:tests|\.changes)\//u);
  const packed = await run(
    ["tar", "-xOzf", result.value.archive, "package/package.json"],
    f.root,
  );
  expect(packed.exit, packed.stderr).toBe(0);
  const manifest = jsonOf(
    z.object({
      dependencies: z.record(z.string(), z.string()),
      peerDependencies: z.record(z.string(), z.string()),
      peerDependenciesMeta: z.record(
        z.string(),
        z.object({ optional: z.boolean() }),
      ),
    }),
  ).safeParse(packed.stdout);
  expect(manifest.success, packed.stdout).toBe(true);
  if (!manifest.success) return;
  expect(
    Object.keys(manifest.data.dependencies).filter(
      (name) => name.startsWith("@types/") || name === "typescript",
    ),
  ).toEqual([]);
  expect(manifest.data.dependencies.neverthrow).toBe("8.2.0");
  expect(manifest.data.dependencies.zod).toBe("4.6.5");
  expect(manifest.data.peerDependencies["@types/node"]).toBe("*");
  expect(manifest.data.peerDependenciesMeta["@types/node"]).toEqual({
    optional: true,
  });
  const consumer = await mkdtemp(join(tmpdir(), "library-consumer-"));
  roots.push(consumer);
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "consumer",
      type: "module",
      private: true,
      devDependencies: { "@types/node": "22.20.2" },
    }),
  );
  // Lock an older major BEFORE adding the tarball, preferring the caller's cache
  // and falling back to the registry when a package is missing.
  const baseline = await run(
    [process.execPath, "install", "--prefer-offline"],
    consumer,
  );
  expect(baseline.exit, baseline.stdout + baseline.stderr).toBe(0);
  expect(await Bun.file(join(consumer, "bun.lock")).exists()).toBe(true);
  const nodeVersion = async () => {
    const parsed = jsonOf(z.object({ version: z.string() })).safeParse(
      await Bun.file(
        join(consumer, "node_modules/@types/node/package.json"),
      ).text(),
    );
    expect(parsed.success).toBe(true);
    return parsed.success ? parsed.data.version : undefined;
  };
  const before = await nodeVersion();
  expect(before).toBe("22.20.2");
  const installed = await run(
    [process.execPath, "add", "--prefer-offline", result.value.archive],
    consumer,
  );
  expect(installed.exit, installed.stderr).toBe(0);
  expect(await nodeVersion()).toBe(before);
  const lockfile = await Bun.file(join(consumer, "bun.lock")).text();
  expect(lockfile).toContain("@types/node@22.20.2");
  // A nested newer copy would also defeat the consumer's ownership of Node types.
  expect(lockfile.match(/@types\/node@\d+\.[\d.]+/gu)).toEqual([
    "@types/node@22.20.2",
  ]);
  await Bun.write(
    join(consumer, "consumer.ts"),
    `
import { onPrompt, runningRuns, RunSchema, type HookContext, type Run } from "agx-usehooks";
const ctx: HookContext = { cwd: "/tmp", repoRoot: "/tmp", payload: {} };
const runs: Run[] = await runningRuns(ctx, { stateDirs: [] });
// @ts-expect-error public Run.row must remain a string
const invalid: Run = { id: "fixture", lane: "test", row: 123 };
void invalid;
if (runs.length !== 0 || typeof onPrompt !== "function" || !RunSchema.safeParse({ id: "fixture", lane: "test", row: "fixture" }).success) throw new Error("public API failed");
`,
  );
  const imported = await run([process.execPath, "consumer.ts"], consumer);
  expect(imported).toEqual({ exit: 0, stdout: "", stderr: "" });
  const typed = await run(
    [
      process.execPath,
      "x",
      "--bun",
      "--offline",
      "--package",
      "typescript@6.0.3",
      "tsc",
      "--noEmit",
      "--strict",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "esnext",
      "consumer.ts",
    ],
    consumer,
  );
  expect(typed.exit, typed.stdout + typed.stderr).toBe(0);
}, 30_000);

test("single member publishing refuses with suite pointer", async () => {
  const f = await fixture();
  for (const pkg of packages) {
    const result = await preview({ ...f, pkg });
    expect(result.exit).toBe(2);
    expect(result.stderr).toBe("FATAL: Use release:publish -- suite\n");
  }
});

async function suiteFixture() {
  const f = await libraryFixture();
  for (const pkg of packages) {
    if (pkg === "agx-usehooks") continue;
    const dir = join(f.root, "tools", pkg);
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ version: "2.3.4", bin: { [pkg]: "src/main.ts" } }),
    );
    await Bun.write(
      join(dir, "src/main.ts"),
      `process.stdout.write("${pkg === "xmsg" ? "agx msg" : pkg} 2.3.4\\n");`,
    );
    await Bun.write(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## 2.3.4\n\n- This version only.\n\n## 2.3.3\n\n- Earlier version.\n",
    );
  }
  return { ...f, pkg: "suite", dir: join(f.root, "tools/agx") };
}

test("suite archive contains all commands with member versions and exactly two assets", async () => {
  const f = await suiteFixture();
  const result = await build("suite", undefined, f.root);
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  if (result.isErr()) return;
  expect(result.value.assets).toHaveLength(2);
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  const names = [...packages]
    .filter((pkg) => pkg !== "agx-usehooks")
    .concat("agx-msg");
  expect(listing.stdout.trim().split("\n").toSorted()).toEqual(
    ["bin/", ...names.map((name) => `bin/${name}`)].toSorted(),
  );
  for (const name of names) {
    const version = await run(
      [join(f.root, "dist/suite/bin", name), "--version"],
      f.root,
    );
    expect(version.exit).toBe(0);
    expect(version.stdout).toBe(
      `${name === "agx-msg" || name === "xmsg" ? "agx msg" : name} 2.3.4\n`,
    );
  }
  await messagingAlias(f.root, result.value.archive);
  const calls = (await Bun.file(join(f.root, "calls")).text()).split("\n");
  const messagingCompiles = calls.filter(
    (line) => line.includes("--compile") && line.includes("/tools/xmsg/"),
  );
  expect(messagingCompiles).toHaveLength(1);
  expect(messagingCompiles[0]).toContain("/bin/agx-msg");
  const archives = await Array.fromAsync(
    new Bun.Glob("*.tar.gz").scan(join(f.root, "dist")),
  );
  expect(archives).toHaveLength(1);
}, 30_000);

test("suite notes reject unavailable history", async () => {
  const f = await suiteFixture();
  expect((await suiteNotes(f.root, "v0.0.0", run)).isErr()).toBe(true);
});

async function messagingAlias(root: string, archive: string) {
  const extracted = join(root, "dist", "extracted");
  await mkdir(extracted, { recursive: true });
  const unpacked = await run(["tar", "-xzf", archive, "-C", extracted], root);
  expect(unpacked.exit, unpacked.stderr).toBe(0);
  const canonical = join(extracted, "bin/agx-msg");
  const alias = join(extracted, "bin/xmsg");
  const [original, linked] = await Promise.all([stat(canonical), stat(alias)]);
  expect(linked.dev).toBe(original.dev);
  expect(linked.ino).toBe(original.ino);
  expect(linked.nlink).toBe(2);
  const a = await run([canonical, "--version"], root);
  const b = await run([alias, "--version"], root);
  expect(a.exit).toBe(0);
  expect(b).toEqual(a);
}
