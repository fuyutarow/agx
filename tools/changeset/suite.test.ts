import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChangesets, type SuiteHistory } from "./apply.ts";
import { writeChangeset } from "./changeset.ts";
import { subprocessEnvironment } from "../shared/src/subprocess-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(version = "1.3.0") {
  const root = await mkdtemp(join(tmpdir(), "suite-bump-once-"));
  roots.push(root);
  for (const pkg of ["agx", "agx-worker", "agx-usehooks"])
    await Bun.write(
      join(root, "tools", pkg, "package.json"),
      JSON.stringify({
        name: `@agx/${pkg}`,
        version: pkg === "agx" ? version : "1.0.0",
      }),
    );
  await Bun.write(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n## ${version} — 2026-10-23\n\n- Suite update\n`,
  );
  return root;
}

async function apply(
  root: string,
  pkg: string,
  bump: "patch" | "minor" | "major",
  history: SuiteHistory,
) {
  expect((await writeChangeset(root, pkg, bump, `${pkg} change`)).isOk()).toBe(
    true,
  );
  const result = await applyChangesets(root, pkg, "2026-10-24", history);
  expect(result.isOk()).toBe(true);
  return result;
}

async function suite(root: string, version: string, sections: number) {
  expect(await Bun.file(join(root, "tools/agx/package.json")).text()).toContain(
    `"version": "${version}"`,
  );
  const notes = await Bun.file(join(root, "CHANGELOG.md")).text();
  expect(notes.match(/^## /gmu)).toHaveLength(sections);
  expect(notes).toContain("agx-worker change");
  return notes;
}

test("untagged pending 1.3.0 keeps one section across patch member applies", async () => {
  const root = await fixture();
  const history = {
    tags: ["agx@1.2.1", "agx-worker@99.0.0"],
    lastReleaseVersion: "1.2.1",
  };
  await apply(root, "agx-worker", "patch", history);
  await apply(root, "agx-usehooks", "patch", history);
  const notes = await suite(root, "1.3.0", 1);
  expect(notes).toContain("- Suite update\n");
  expect(notes).toContain("agx-usehooks change");
});

test("released 1.3.0 bumps once to 1.3.1 and retains the released notes", async () => {
  const root = await fixture();
  const history = {
    tags: ["v1.2.9", "v1.3.0", "v1.2.10", "agx@99.0.0", "v9.0.0-preview"],
  };
  await apply(root, "agx-worker", "patch", history);
  await apply(root, "agx-usehooks", "patch", history);
  const notes = await suite(root, "1.3.1", 2);
  expect(notes).toContain("agx-usehooks change");
  expect(notes).toContain("## 1.3.0 — 2026-10-23\n\n- Suite update");
});

test("minor after patch raises the pending suite version and replaces its section", async () => {
  const root = await fixture();
  const history = { tags: ["v1.3.0"] };
  await apply(root, "agx-worker", "patch", history);
  await apply(root, "agx-usehooks", "minor", history);
  const notes = await suite(root, "1.4.0", 2);
  expect(notes).not.toContain("## 1.3.1");
  expect(notes).toContain("agx-usehooks change");
  await apply(root, "agx-worker", "patch", history);
  expect(await Bun.file(join(root, "tools/agx/package.json")).text()).toContain(
    '"version": "1.4.0"',
  );
});

test("current-version fallback stays fixed across applies without release history", async () => {
  const root = await fixture("0.0.0");
  const history = { tags: [] };
  await apply(root, "agx-worker", "patch", history);
  await apply(root, "agx-usehooks", "minor", history);
  await suite(root, "0.1.0", 2);
});

test("a new release tag starts a new window without merging released entries", async () => {
  const root = await fixture();
  await apply(root, "agx-worker", "patch", { tags: ["v1.3.0"] });
  await apply(root, "agx-usehooks", "patch", { tags: ["v1.3.0", "v1.3.1"] });
  const notes = await suite(root, "1.3.2", 3);
  expect(notes.slice(0, notes.indexOf("## 1.3.1"))).not.toContain("agx-worker");
});

async function git(root: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    env: {
      ...subprocessEnvironment(),
      GIT_AUTHOR_NAME: "Suite test",
      GIT_AUTHOR_EMAIL: "suite@example.test",
      GIT_COMMITTER_NAME: "Suite test",
      GIT_COMMITTER_EMAIL: "suite@example.test",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return stdout;
}

async function commit(root: string, message: string) {
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

test.each(["v-tag", "legacy-tag", "release-commit"])(
  "Git history resolves the %s baseline without changing repository history",
  async (kind) => {
    const root = await fixture("1.2.1");
    await git(root, ["init", "--quiet"]);
    await commit(root, "chore(release): suite 1.2.1");
    if (kind === "legacy-tag") await git(root, ["tag", "agx@1.2.1"]);
    if (kind === "v-tag") await git(root, ["tag", "v1.2.1"]);
    await Bun.write(
      join(root, "tools/agx/package.json"),
      '{"version":"1.3.0"}',
    );
    await Bun.write(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## 1.3.0 — 2026-10-23\n\n- Pending suite change\n",
    );
    await commit(root, "Prepare pending suite change");
    const before = await git(root, ["rev-parse", "HEAD"]);
    const tags = await git(root, ["tag", "--list"]);
    for (const pkg of ["agx-worker", "agx-usehooks"]) {
      expect(
        (await writeChangeset(root, pkg, "patch", `${pkg} change`)).isOk(),
      ).toBe(true);
      expect((await applyChangesets(root, pkg, "2026-10-24")).isOk()).toBe(
        true,
      );
    }
    await suite(root, "1.3.0", 1);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(root, ["tag", "--list"])).toBe(tags);
  },
);
