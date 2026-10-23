import { afterEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeChangeset } from "../changeset/changeset.ts";
import { applyChangesets } from "../changeset/apply.ts";
import {
  build,
  changelogSection,
  packageInfo,
  platform,
  repository,
  run,
} from "./release.ts";

// Budget two compiles at 45 seconds each plus 30 seconds for fixture and archive I/O under load.
const COMPILE_TEST_TIMEOUT_MS = 120_000;
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
    JSON.stringify({ version: "2.3.4", bin: { [pkg]: "src/main.ts" } }),
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
  for (const file of ["build.ts", "publish.ts", "release.ts"])
    await Bun.write(
      join(root, "tools/release", file),
      Bun.file(join(import.meta.dir, file)),
    );
  await symlink(join(repository, "tools/zod.ts"), join(root, "tools/zod.ts"));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  const fake = join(root, "fake-bin");
  await mkdir(fake);
  const executable = `#!${process.execPath}\nconst args = process.argv.slice(2);\nawait Bun.write(${JSON.stringify(join(root, "calls"))}, (await Bun.file(${JSON.stringify(join(root, "calls"))}).text().catch(() => "")) + JSON.stringify(args) + "\\n");\nif (args[0] === "status") process.stdout.write(process.env.RELEASE_TEST_DIRTY === "1" ? " M changed\\n" : "");\nif (args[0] === "show-ref") process.exit(process.env.RELEASE_TEST_TAG === "1" ? 0 : 1);\nif (args[0] === "rev-parse") process.stdout.write("0123456789012345678901234567890123456789\\n");\nif (args[0] === "tag" || args[0] === "release") process.exit(99);\n`;
  await Bun.write(join(fake, "git"), executable);
  await Bun.write(join(fake, "gh"), executable);
  await chmod(join(fake, "git"), 0o755);
  await chmod(join(fake, "gh"), 0o755);
  return { root, dir, fake, pkg };
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
        PATH: `${f.fake}:${process.env.PATH ?? ""}`,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

test(
  "package versions, tags and archive names ignore the repository version",
  async () => {
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
  },
  COMPILE_TEST_TIMEOUT_MS,
);

test(
  "xmsg archive contains both executable names and removes stale files",
  async () => {
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
    const alias = await run([join(f.root, "dist/xmsg/bin/agx-msg")], f.root);
    expect(alias.exit).toBe(0);
  },
  COMPILE_TEST_TIMEOUT_MS,
);

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

test(
  "publish defaults to dry-run and prints exact commands with only current notes",
  async () => {
    const f = await fixture();
    const result = await preview(f);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("'git' 'tag' 'agx-status@2.3.4'");
    expect(result.stdout).toContain(
      "'gh' 'release' 'create' 'agx-status@2.3.4'",
    );
    expect(result.stdout).toContain(
      "'--target' '0123456789012345678901234567890123456789'",
    );
    const calls = await Bun.file(join(f.root, "calls")).text();
    expect(calls).not.toContain('["tag"');
    expect(calls).not.toContain('["release"');
    const notes = await Bun.file(
      join(f.root, "dist/agx-status/release-notes.md"),
    ).text();
    expect(notes).toContain("This version only");
    expect(notes).not.toContain("Earlier version");
  },
  COMPILE_TEST_TIMEOUT_MS,
);

test(
  "publish reads precisely the dated section produced by release:version",
  async () => {
    const f = await fixture();
    expect(
      (
        await writeChangeset(
          f.root,
          "agx-status",
          "minor",
          "New release entry.",
        )
      ).isOk(),
    ).toBe(true);
    const applied = await applyChangesets(f.root, "agx-status", "2026-10-23");
    expect(applied.isOk() && applied.value.version).toBe("2.4.0");
    const result = await preview(f);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("'git' 'tag' 'agx-status@2.4.0'");
    expect(
      await Bun.file(join(f.root, "dist/agx-status/release-notes.md")).text(),
    ).toBe("## 2.4.0 — 2026-10-23\n\n- New release entry.\n");
    expect(
      await Bun.file(join(f.dir, ".changes/new-release-entry.md")).exists(),
    ).toBe(false);
  },
  COMPILE_TEST_TIMEOUT_MS,
);

test("explicit dry-run refuses dirty copies, existing tags and missing version entries", async () => {
  const f = await fixture();
  const dirty = await preview(f, ["--dry-run"], { RELEASE_TEST_DIRTY: "1" });
  expect(dirty.exit).toBe(2);
  expect(dirty.stderr).toContain("dirty");
  const tagged = await preview(f, ["--dry-run"], { RELEASE_TEST_TAG: "1" });
  expect(tagged.exit).toBe(2);
  expect(tagged.stderr).toContain("Tag already exists: agx-status@2.3.4");
  await Bun.write(
    join(f.dir, "CHANGELOG.md"),
    "## 2.3.40\n\n- Wrong version\n",
  );
  const missing = await preview(f, ["--dry-run"]);
  expect(missing.exit).toBe(2);
  expect(missing.stderr).toContain("no entry for 2.3.4");
});

test(
  "execution requires --yes; conflicting flags and excess arguments refuse",
  async () => {
    const f = await fixture();
    for (const args of [["--yes", "--dry-run"], ["extra"]]) {
      const result = await preview(f, args);
      expect(result.exit).toBe(2);
    }
    const result = await preview(f, ["--yes"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("Release stopped");
    expect(await Bun.file(join(f.root, "calls")).text()).toContain(
      '["tag","agx-status@2.3.4"]',
    );
  },
  COMPILE_TEST_TIMEOUT_MS,
);

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

test(
  "library tarball installs offline, imports and supplies checked public declarations",
  async () => {
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
    const consumer = await mkdtemp(join(tmpdir(), "library-consumer-"));
    roots.push(consumer);
    await Bun.write(
      join(consumer, "package.json"),
      '{"name":"consumer","type":"module","private":true}',
    );
    const installed = await run(
      [process.execPath, "add", "--offline", result.value.archive],
      consumer,
    );
    expect(installed.exit, installed.stderr).toBe(0);
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
  },
  COMPILE_TEST_TIMEOUT_MS,
);

test(
  "library publish previews its own tag and tarball and retains refusals",
  async () => {
    const f = await libraryFixture();
    const result = await preview(f);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain(
      "'gh' 'release' 'create' 'agx-usehooks@2.3.4'",
    );
    expect(result.stdout).toContain("agx-usehooks-2.3.4.tgz'");
    const calls = await Bun.file(join(f.root, "calls")).text();
    expect(calls).not.toContain('["tag"');
    expect(calls).not.toContain('["release"');
    expect((await preview(f, [], { RELEASE_TEST_DIRTY: "1" })).exit).toBe(2);
    expect((await preview(f, [], { RELEASE_TEST_TAG: "1" })).exit).toBe(2);
    await Bun.write(join(f.dir, "CHANGELOG.md"), "## 2.3.3\n\n- Earlier.\n");
    expect((await preview(f)).exit).toBe(2);
  },
  COMPILE_TEST_TIMEOUT_MS,
);
