import { cli } from "cleye";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  changesetDiagnostic,
  parseChangeset,
  readPackage,
  repository,
  type Changeset,
} from "./changeset.ts";

type Bump = Changeset["bump"];
const bumpRank: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

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
  const next = bumpedVersion(manifest.version, bump);
  if (next.isErr()) return next;
  const changelog = Bun.file(join(dir, "CHANGELOG.md"));
  const previous = (await changelog.exists())
    ? await changelog.text()
    : "# Changelog\n";
  if (!previous.startsWith("# Changelog\n"))
    return err(
      new Error(`tools/${pkg}/CHANGELOG.md: expected # Changelog preamble`),
    );
  const section = `## ${next.value} — ${date}\n\n${changes.map(({ entry }) => `- ${entry}`).join("\n")}`;
  const older = previous.slice("# Changelog\n".length).trim();
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
) {
  const member = await prepareChangesets(root, pkg, date);
  if (member.isErr()) return member;
  const plans = [member.value];
  if (pkg !== "agx") {
    const suite = await prepareChangesets(root, "agx", date, [
      {
        bump: member.value.bump,
        entry: `Update suite member ${pkg} to ${member.value.version}.`,
      },
    ]);
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
