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
  await Bun.write(join(root, "CHANGELOG.md"), "# Changelog\n");
  return { root, dir, changes: join(root, ".changes") };
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

test("generator supports suite and scoped forms, keeps duplicate summaries, and lints both", async () => {
  const f = await fixture();
  for (const args of [
    ["minor", "Same summary"],
    ["sample", "patch", "Same summary"],
  ])
    expect((await invoke(f.root, "changeset.ts", args)).exit).toBe(0);
  expect(await readdir(f.changes)).toEqual([
    "same-summary-2.md",
    "same-summary.md",
  ]);
  expect(await lintChangesets(f.root)).toEqual([]);
  const applied = await invoke(f.root, "apply.ts");
  expect(applied.exit, applied.stderr).toBe(0);
  expect(applied.stdout).toBe("VERSIONED suite@1.3.0 (2 changesets)\n");
  expect((await invoke(f.root, "apply.ts")).exit).toBe(2);
});
test.each(["changeset.ts", "apply.ts", "lint.ts"])(
  "CLI %s rejects unknown flags and excess args",
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
test("malformed legacy changeset refuses before writing or consuming valid suite changes", async () => {
  const f = await fixture();
  await writeChangeset(f.root, "sample", "minor", "Valid");
  await Bun.write(join(f.dir, ".changes/bad.md"), "bump: huge\n\nBad\n");
  const before = await releaseBytes(f.dir);
  expect((await applyChangesets(f.root)).isErr()).toBe(true);
  expect(await releaseBytes(f.dir)).toEqual(before);
  expect(await readdir(f.changes)).toEqual(["valid.md"]);
  expect(await lintChangesets(f.root)).toHaveLength(1);
});

test("one suite apply consumes every in-flight member file with the highest bump", async () => {
  const f = await fixture();
  await writeChangeset(f.root, "agx", "patch", "Suite fix");
  await Bun.write(
    join(f.dir, ".changes/a.md"),
    "bump: minor\n\nMember feature\n",
  );
  await Bun.write(
    join(f.root, "tools/agx/.changes/a.md"),
    "bump: major\n\nLegacy suite break\n",
  );
  const frozen = await Bun.file(join(f.dir, "CHANGELOG.md")).text();
  const result = await applyChangesets(f.root);
  expect(result.isOk() && result.value).toEqual({
    pkg: "suite",
    version: "2.0.0",
    entries: 3,
  });
  expect(await readdir(f.changes)).toEqual([]);
  expect(await readdir(join(f.dir, ".changes"))).toEqual([]);
  expect(await readdir(join(f.root, "tools/agx/.changes"))).toEqual([]);
  expect(await Bun.file(join(f.dir, "CHANGELOG.md")).text()).toBe(frozen);
  const log = await Bun.file(join(f.root, "CHANGELOG.md")).text();
  for (const entry of ["Suite fix", "Member feature", "Legacy suite break"])
    expect(log).toContain(entry);
  expect(await Bun.file(join(f.dir, "package.json")).text()).toContain(
    '"version": "2.0.0"',
  );
});
