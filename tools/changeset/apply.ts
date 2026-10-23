import { cli } from "cleye";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { jsonOf, z } from "../zod.ts";
import {
  changesetDiagnostic,
  parseChangeset,
  readPackage,
  repository,
  type Changeset,
} from "./changeset.ts";

type Bump = Changeset["bump"];
const bumpRank: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (const index of [0, 1, 2]) {
    const difference = (a[index] ?? 0n) - (b[index] ?? 0n);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return 0;
}

export type SuiteHistory = {
  tags: readonly string[];
  lastReleaseVersion?: string;
};

async function readGit(root: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

async function readSuiteHistory(
  root: string,
): Promise<Result<SuiteHistory, Error>> {
  const { exit, stdout, stderr } = await readGit(root, ["tag", "--list"]);
  // Library fixtures and new source trees may not have Git history yet.
  if (exit !== 0) {
    if (stderr.includes("not a git repository")) return ok({ tags: [] });
    return err(
      new Error(`Cannot inspect suite release tags: ${stderr.trim()}`),
    );
  }
  const tags = stdout.trim().split("\n");
  if (
    tags.some((tag) => tag.startsWith("v") && versionPattern.test(tag.slice(1)))
  )
    return ok({ tags });
  // Before suite v-tags, releases were recorded under the agx package tag.
  const legacy = tags
    .filter((tag) => tag.startsWith("agx@"))
    .map((tag) => tag.slice(4))
    .filter((version) => versionPattern.test(version))
    .toSorted(compareVersions)
    .at(-1);
  let revision = legacy === undefined ? undefined : `refs/tags/agx@${legacy}`;
  if (revision === undefined) {
    const release = await readGit(root, [
      "log",
      "-1",
      "--format=%H",
      "--extended-regexp",
      "--grep=^(chore\\(release\\)|release(\\(agx\\)|\\(suite\\))?):",
      "--",
      "tools/agx/package.json",
    ]);
    // An initialized repository without commits has no release baseline.
    if (
      release.exit !== 0 &&
      release.stderr.includes("does not have any commits yet")
    )
      return ok({ tags });
    if (release.exit !== 0)
      return err(
        new Error(
          `Cannot inspect suite release commits: ${release.stderr.trim()}`,
        ),
      );
    const commit = release.stdout.trim();
    revision = commit.length === 0 ? undefined : commit;
  }
  if (revision === undefined) return ok({ tags });
  const manifest = await readGit(root, [
    "show",
    `${revision}:tools/agx/package.json`,
  ]);
  const parsed = jsonOf(
    z.object({ version: z.string().regex(versionPattern) }),
  ).safeParse(manifest.stdout);
  if (manifest.exit !== 0 || !parsed.success)
    return err(
      new Error(`Cannot read suite version on release commit ${revision}`),
    );
  return ok({ tags, lastReleaseVersion: parsed.data.version });
}

function suiteVersion(
  current: string,
  bump: Bump,
  previous: string,
  history: SuiteHistory,
) {
  const tagged = history.tags
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => tag.slice(1))
    .filter((version) => versionPattern.test(version))
    .toSorted(compareVersions)
    .at(-1);
  const saved = /<!-- agx release baseline: ([\d.]+) -->/u.exec(previous)?.[1];
  const released = tagged ?? history.lastReleaseVersion ?? saved ?? current;
  const next = bumpedVersion(released, bump);
  if (next.isErr()) return next;
  return ok({
    version: compareVersions(current, next.value) > 0 ? current : next.value,
    baseline: released,
    rememberBaseline:
      tagged === undefined && history.lastReleaseVersion === undefined,
  });
}

function bumpedVersion(current: string, bump: Bump): Result<string, Error> {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(current);
  if (match === null)
    return err(new Error(`invalid SemVer package version: ${current}`));
  const [major = 0n, minor = 0n, patch = 0n] = match.slice(1).map(BigInt);
  if (bump === "major") return ok(`${major + 1n}.0.0`);
  if (bump === "minor") return ok(`${major}.${minor + 1n}.0`);
  return ok(`${major}.${minor}.${patch + 1n}`);
}

async function prepareChangesets(
  root: string,
  pkg: string,
  date: string,
  extra: Changeset[] = [],
  history?: SuiteHistory,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
    return err(new Error(`invalid release date: ${date}`));
  const info = await readPackage(root, pkg);
  if (info.isErr()) return info;
  const { dir, manifest } = info.value;
  const changesDir = join(dir, ".changes");
  const files = await readdir(changesDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      return err(error);
    },
  );
  if (!Array.isArray(files)) return files;
  const names = files
    .filter((file) => file.isFile() && file.name.endsWith(".md"))
    .map((file) => file.name)
    .toSorted();
  if (names.length === 0 && extra.length === 0)
    return err(
      new Error(
        `No pending changesets for ${pkg}; create one with mise run changeset -- ${pkg} <patch|minor|major> "<entry>"`,
      ),
    );
  const changes: Changeset[] = [...extra];
  for (const name of names) {
    const parsed = parseChangeset(
      await Bun.file(join(changesDir, name)).text(),
    );
    if (parsed.isErr())
      return err(
        new Error(
          changesetDiagnostic(
            `tools/${pkg}/.changes/${name}`,
            parsed.error.message,
          ),
        ),
      );
    changes.push(parsed.value);
  }
  const bump = changes.reduce<Bump>(
    (highest, change) =>
      bumpRank[change.bump] > bumpRank[highest] ? change.bump : highest,
    "patch",
  );
  let next = bumpedVersion(manifest.version, bump);
  if (next.isErr()) return next;
  const changelog = Bun.file(join(dir, "CHANGELOG.md"));
  const previous = (await changelog.exists())
    ? await changelog.text()
    : "# Changelog\n";
  if (!previous.startsWith("# Changelog\n"))
    return err(
      new Error(`tools/${pkg}/CHANGELOG.md: expected # Changelog preamble`),
    );
  let older = previous.slice("# Changelog\n".length).trim();
  let retained = "";
  let baseline = "";
  if (history !== undefined) {
    const suite = suiteVersion(manifest.version, bump, previous, history);
    if (suite.isErr()) return suite;
    next = ok(suite.value.version);
    if (suite.value.rememberBaseline)
      baseline = `\n\n<!-- agx release baseline: ${suite.value.baseline} -->`;
    const heading = /^## ([\d.]+) — [^\n]+\n/u.exec(older);
    if (
      heading?.[1] === manifest.version &&
      compareVersions(manifest.version, suite.value.baseline) > 0
    ) {
      const end = older.indexOf("\n## ", heading[0].length);
      const body = older.slice(heading[0].length, end < 0 ? undefined : end);
      retained = body
        .replaceAll(/<!-- agx release baseline: [\d.]+ -->/gu, "")
        .trim();
      older = end < 0 ? "" : older.slice(end).trim();
    }
  }
  if (next.isErr()) return next;
  const entries = changes.map(({ entry }) => `- ${entry}`).join("\n");
  const section = `## ${next.value} — ${date}\n\n${[retained, entries].filter(Boolean).join("\n")}${baseline}`;
  return ok({
    pkg,
    version: next.value,
    entries: changes.length,
    bump,
    dir,
    changesDir,
    names,
    manifest: `${JSON.stringify({ ...manifest, version: next.value }, null, 2)}\n`,
    changelog:
      ["# Changelog", section, older]
        .filter((part) => part.length > 0)
        .join("\n\n") + "\n",
  });
}

/** Validate member and suite inputs before writing either version. */
export async function applyChangesets(
  root: string,
  pkg: string,
  date = Temporal.Now.plainDateISO().toString(),
  history?: SuiteHistory,
) {
  const resolved =
    history === undefined ? await readSuiteHistory(root) : ok(history);
  if (resolved.isErr()) return resolved;
  const suiteHistory = resolved.value;
  const member = await prepareChangesets(
    root,
    pkg,
    date,
    [],
    pkg === "agx" ? suiteHistory : undefined,
  );
  if (member.isErr()) return member;
  const plans = [member.value];
  if (pkg !== "agx") {
    const suite = await prepareChangesets(
      root,
      "agx",
      date,
      [
        {
          bump: member.value.bump,
          entry: `Update suite member ${pkg} to ${member.value.version}.`,
        },
      ],
      suiteHistory,
    );
    if (suite.isErr()) return suite;
    plans.unshift(suite.value);
  }
  // Write the suite first: a failed member write cannot leave a member bumped alone.
  for (const plan of plans) {
    await Bun.write(join(plan.dir, "package.json"), plan.manifest);
    await Bun.write(join(plan.dir, "CHANGELOG.md"), plan.changelog);
    for (const name of plan.names) await unlink(join(plan.changesDir, name));
  }
  return ok({
    pkg,
    version: member.value.version,
    entries: member.value.entries,
  });
}

async function main() {
  const args = cli({
    name: "release:version",
    parameters: ["<pkg>"],
    strictFlags: true,
    ignoreArgv(type, flag) {
      if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
    },
  });
  if (args._.length !== 1) {
    process.stderr.write("FATAL: Expected exactly one package\n");
    process.exitCode = 2;
    return;
  }
  const result = await applyChangesets(repository, args._.pkg);
  if (result.isErr()) {
    process.stderr.write(`FATAL: ${result.error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `VERSIONED ${result.value.pkg}@${result.value.version} (${result.value.entries} changesets)\n`,
  );
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    process.stderr.write(
      `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
