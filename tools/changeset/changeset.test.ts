import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChangesetSchema,
  formatChangeset,
  parseChangeset,
  repository,
  writeChangeset,
} from "./changeset.ts";
import { applyChangesets } from "./apply.ts";
import { lintChangesets } from "./lint.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "package-changesets-"));
  temporary.push(root);
  const dir = join(root, "tools/sample");
  await mkdir(join(dir, ".changes"), { recursive: true });
  await Bun.write(
    join(dir, "package.json"),
    '{\n  "name": "sample",\n  "version": "1.2.3",\n  "private": true\n}\n',
  );
  await Bun.write(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## 1.2.3 — 2026-10-01\n\n- Existing entry\n",
  );
  await Bun.write(
    join(root, "package.json"),
    '{"private":true,"version":"99.99.99"}',
  );
  await mkdir(join(root, "tools/changeset"));
  for (const file of ["changeset.ts", "apply.ts", "lint.ts"])
    await Bun.write(
      join(root, "tools/changeset", file),
      Bun.file(join(import.meta.dir, file)),
    );
  await symlink(join(repository, "tools/zod.ts"), join(root, "tools/zod.ts"));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await Bun.write(join(root, "tools/agx/package.json"), '{"version":"1.2.1"}');
  await Bun.write(join(root, "tools/agx/CHANGELOG.md"), "# Changelog\n");
  return { root, dir, changes: join(dir, ".changes") };
}

async function invoke(root: string, file: string, args: string[] = []) {
  const child = Bun.spawn(
    [process.execPath, join(root, "tools/changeset", file), ...args],
    {
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

async function releaseBytes(dir: string) {
  return Promise.all(
    ["package.json", "CHANGELOG.md"].map((name) =>
      Bun.file(join(dir, name)).text(),
    ),
  );
}

test("canonical formatting round-trips through the shared schema", () => {
  const change = { bump: "minor", entry: "Add relay support" } as const;
  const parsed = parseChangeset(formatChangeset(change));
  expect(parsed.isOk() && parsed.value).toEqual(change);
  expect(ChangesetSchema.safeParse(change)).toMatchObject({
    success: true,
    data: change,
  });
});

test.each([
  "---\nbump: patch\n---\n\nFix issue\n",
  "bump: patch\nFix issue\n",
  "---\nbump: patch\n---\nFix issue\n",
  "bump: patch\n\nFix issue\n",
  "bump: patch\n\nFix issue",
  "---\r\nbump: patch\r\n---\r\n\r\nFix issue\r\n",
])("existing changeset bytes remain compatible: %j", (text) => {
  const parsed = parseChangeset(text);
  expect(parsed.isOk() && parsed.value).toEqual({
    bump: "patch",
    entry: "Fix issue",
  });
});

test.each([
  "bump: huge\n\nEntry\n",
  "bump: patch\n\nFirst\nSecond\n",
  "bump: patch\n\n\n",
  "bump: patch\n\n- Bullet\n",
  "bump: patch\n\n# Heading\n",
  "---\nbump: patch\n\nEntry\n",
  "package: missing\nbump: patch\n\nEntry\n",
])("parser rejects malformed changesets: %j", (text) => {
  expect(parseChangeset(text).isErr()).toBe(true);
});

test("create writes canonical bytes, lint accepts, and duplicate slugs preserve the first file", async () => {
  const f = await fixture();
  const before = await releaseBytes(f.dir);
  const first = await invoke(f.root, "changeset.ts", [
    "sample",
    "patch",
    "Fix an issue",
  ]);
  const second = await invoke(f.root, "changeset.ts", [
    "sample",
    "minor",
    "Fix an issue",
  ]);
  expect(first.exit).toBe(0);
  expect(first.stdout).toBe("WROTE tools/sample/.changes/fix-an-issue.md\n");
  expect(second.stdout).toBe("WROTE tools/sample/.changes/fix-an-issue-2.md\n");
  expect(await Bun.file(join(f.changes, "fix-an-issue.md")).text()).toBe(
    "---\nbump: patch\n---\n\nFix an issue\n",
  );
  expect(await lintChangesets(f.root)).toEqual([]);
  expect((await invoke(f.root, "lint.ts")).exit).toBe(0);
  expect(await releaseBytes(f.dir)).toEqual(before);
});

test("generator normalizes non-ASCII and punctuation slugs without losing entry bytes", async () => {
  const f = await fixture();
  const change = await writeChangeset(
    f.root,
    "sample",
    "patch",
    "  Café output!  ",
  );
  expect(change.isOk() && change.value).toBe(
    "tools/sample/.changes/cafe-output.md",
  );
  const fallback = await writeChangeset(f.root, "sample", "patch", "修正");
  expect(fallback.isOk() && fallback.value).toBe(
    "tools/sample/.changes/change.md",
  );
});

test.each([
  ["missing", "patch", "Entry"],
  ["changeset", "patch", "Entry"],
  ["../sample", "patch", "Entry"],
  ["sample", "huge", "Entry"],
  ["sample", "patch", "First\nSecond"],
])("create refuses invalid input %j", async (pkg, level, entry) => {
  const f = await fixture();
  expect((await invoke(f.root, "changeset.ts", [pkg, level, entry])).exit).toBe(
    2,
  );
  expect(await readdir(f.changes)).toEqual([]);
});

test("empty and whitespace-only entries are refused before any write", async () => {
  const f = await fixture();
  expect((await writeChangeset(f.root, "sample", "patch", "")).isErr()).toBe(
    true,
  );
  expect(
    (await invoke(f.root, "changeset.ts", ["sample", "patch", "   "])).exit,
  ).toBe(2);
  expect(await readdir(f.changes)).toEqual([]);
});

test.each([
  [["patch"], "1.2.4"],
  [["minor", "patch"], "1.3.0"],
  [["patch", "major", "minor"], "2.0.0"],
] as const)(
  "apply takes the highest pending level %j",
  async (levels, version) => {
    const f = await fixture();
    for (const [index, level] of levels.entries())
      expect(
        (
          await writeChangeset(f.root, "sample", level, `Entry ${index}`)
        ).isOk(),
      ).toBe(true);
    await Bun.write(join(f.changes, ".keep"), "Keep non-changeset files\n");
    const result = await applyChangesets(f.root, "sample", "2026-10-23");
    expect(result.isOk() && result.value).toEqual({
      pkg: "sample",
      version,
      entries: levels.length,
    });
    const [manifest, changelog] = await releaseBytes(f.dir);
    expect(manifest).toBe(
      `{\n  "name": "sample",\n  "version": "${version}",\n  "private": true\n}\n`,
    );
    expect(changelog).toBe(
      `# Changelog\n\n## ${version} — 2026-10-23\n\n${levels.map((_level, index) => `- Entry ${index}`).join("\n")}\n\n## 1.2.3 — 2026-10-01\n\n- Existing entry\n`,
    );
    expect(await readdir(f.changes)).toEqual([".keep"]);
  },
);

test("apply consumes only the selected package and ignores all repository version metadata", async () => {
  const f = await fixture();
  const other = join(f.root, "tools/neighbor");
  await mkdir(join(other, ".changes"), { recursive: true });
  await Bun.write(join(other, "package.json"), '{"version":"8.9.10"}');
  await Bun.write(join(other, "CHANGELOG.md"), "# Changelog\n");
  const pending = "bump: major\n\nNeighbor entry\n";
  await Bun.write(join(other, ".changes/pending.md"), pending);
  const before = await releaseBytes(other);
  const repositoryBefore = await Bun.file(join(f.root, "package.json")).text();
  await writeChangeset(f.root, "sample", "patch", "Selected entry");
  const applied = await invoke(f.root, "apply.ts", ["sample"]);
  expect(applied.exit).toBe(0);
  expect(applied.stdout).toBe("VERSIONED sample@1.2.4 (1 changesets)\n");
  expect(await releaseBytes(other)).toEqual(before);
  expect(await Bun.file(join(other, ".changes/pending.md")).text()).toBe(
    pending,
  );
  expect(await Bun.file(join(f.root, "package.json")).text()).toBe(
    repositoryBefore,
  );
  expect(await Bun.file(join(f.dir, "CHANGELOG.md")).text()).not.toContain(
    "Neighbor entry",
  );
  const after = await releaseBytes(f.dir);
  expect((await invoke(f.root, "apply.ts", ["sample"])).exit).toBe(2);
  expect(await releaseBytes(f.dir)).toEqual(after);
});

test("no pending files refuses with exit 2, even when another package has a changeset", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "tools/neighbor/.changes"), { recursive: true });
  await Bun.write(
    join(f.root, "tools/neighbor/.changes/pending.md"),
    "bump: major\n\nOther entry\n",
  );
  const before = await releaseBytes(f.dir);
  for (const missingDir of [false, true]) {
    if (missingDir) await rm(f.changes, { recursive: true });
    const result = await invoke(f.root, "apply.ts", ["sample"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("No pending changesets for sample");
    expect(await releaseBytes(f.dir)).toEqual(before);
  }
});

test("lint refuses unknown packages and levels with paths and generator guidance", async () => {
  const f = await fixture();
  await Bun.write(join(f.changes, "unknown-level.md"), "bump: huge\n\nEntry\n");
  await mkdir(join(f.root, "tools/missing/.changes"), { recursive: true });
  await Bun.write(
    join(f.root, "tools/missing/.changes/unknown-package.md"),
    "bump: patch\n\nEntry\n",
  );
  const problems = await lintChangesets(f.root);
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).toContain("Unknown package: missing");
  expect(problems.join("\n")).toContain("bump must be patch, minor, or major");
  for (const problem of problems)
    expect(problem).toContain("mise run changeset -- <pkg>");
  const result = await invoke(f.root, "lint.ts");
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("tools/missing/.changes/unknown-package.md");
  expect(result.stderr).toContain("tools/sample/.changes/unknown-level.md");
});

test.each([
  ["malformed changeset", "bad.md", "bump: huge\n\nEntry\n"],
  ["invalid version", "../package.json", '{"version":"1.2.3-beta.1"}'],
  ["invalid package JSON", "../package.json", "{"],
  ["invalid changelog", "../CHANGELOG.md", "# Other heading\n"],
])(
  "apply validates all selected inputs before writes: %s",
  async (_name, path, text) => {
    const f = await fixture();
    await writeChangeset(f.root, "sample", "patch", "Valid entry");
    await Bun.write(join(f.changes, path), text);
    const before = await releaseBytes(f.dir);
    const names = await readdir(f.changes);
    expect((await invoke(f.root, "apply.ts", ["sample"])).exit).toBe(2);
    expect(await releaseBytes(f.dir)).toEqual(before);
    expect(await readdir(f.changes)).toEqual(names);
  },
);

test("apply creates a missing changelog and supports library packages without commands", async () => {
  const f = await fixture();
  await rm(join(f.dir, "CHANGELOG.md"));
  await writeChangeset(f.root, "sample", "patch", "Library change");
  expect((await invoke(f.root, "apply.ts", ["sample"])).exit).toBe(0);
  expect(await Bun.file(join(f.dir, "CHANGELOG.md")).text()).toMatch(
    /^# Changelog\n\n## 1\.2\.4 — \d{4}-\d{2}-\d{2}\n\n- Library change\n$/u,
  );
  expect((await invoke(f.root, "apply.ts", ["missing"])).exit).toBe(2);
  expect((await invoke(f.root, "apply.ts", ["../sample"])).exit).toBe(2);
});

test.each(["changeset.ts", "apply.ts", "lint.ts"])(
  "CLI %s owns help, flags and positional counts",
  async (file) => {
    const f = await fixture();
    expect((await invoke(f.root, file, ["--help"])).exit).toBe(0);
    expect((await invoke(f.root, file, ["--unknown"])).exit).toBe(1);
    expect((await invoke(f.root, file, ["--__proto__"])).exit).toBe(2);
    expect(
      (await invoke(f.root, file, ["sample", "patch", "Entry", "extra"])).exit,
    ).toBe(2);
  },
);

test.each([
  ["patch", "1.2.2"],
  ["minor", "1.3.0"],
  ["major", "2.0.0"],
])("member %s bump forces suite version %s", async (level, version) => {
  const f = await fixture();
  await writeChangeset(f.root, "sample", level, "Member change");
  const result = await applyChangesets(f.root, "sample", "2026-10-23");
  expect(result.isOk()).toBe(true);
  expect(
    await Bun.file(join(f.root, "tools/agx/package.json")).text(),
  ).toContain(`"version": "${version}"`);
  expect(
    await Bun.file(join(f.root, "tools/agx/CHANGELOG.md")).text(),
  ).toContain(
    `Update suite member sample to ${result.isOk() ? result.value.version : ""}.`,
  );
  expect(await lintChangesets(f.root)).toEqual([]);
});

test("invalid suite input prevents member writes; pending suite level participates", async () => {
  const f = await fixture();
  await writeChangeset(f.root, "sample", "patch", "Member change");
  const before = await releaseBytes(f.dir);
  await Bun.write(join(f.root, "tools/agx/CHANGELOG.md"), "# Invalid\n");
  expect((await applyChangesets(f.root, "sample")).isErr()).toBe(true);
  expect(await releaseBytes(f.dir)).toEqual(before);
  await Bun.write(join(f.root, "tools/agx/CHANGELOG.md"), "# Changelog\n");
  await writeChangeset(f.root, "agx", "major", "Suite change");
  expect((await applyChangesets(f.root, "sample")).isOk()).toBe(true);
  expect(
    await Bun.file(join(f.root, "tools/agx/package.json")).text(),
  ).toContain('"version": "2.0.0"');
});
