import { cli } from "cleye";
import { join } from "node:path";
import {
  changesetDiagnostic,
  parseChangeset,
  readPackage,
  repository,
} from "./changeset.ts";

export async function lintChangesets(root: string): Promise<string[]> {
  const problems: string[] = [];
  const paths = (
    await Promise.all(
      [".changes/*.md", "tools/*/.changes/*.md"].map((pattern) =>
        Array.fromAsync(
          new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: true }),
        ),
      ),
    )
  ).flat();
  for (const path of paths.toSorted()) {
    const pkg = path.startsWith("tools/") ? (path.split("/")[1] ?? "") : "agx";
    const info = await readPackage(root, pkg);
    if (info.isErr()) {
      problems.push(changesetDiagnostic(path, info.error.message));
      continue;
    }
    const parsed = parseChangeset(await Bun.file(join(root, path)).text());
    if (parsed.isErr())
      problems.push(changesetDiagnostic(path, parsed.error.message));
  }
  return problems;
}

async function main() {
  const args = cli({
    name: "lint:changesets",
    parameters: [],
    strictFlags: true,
    ignoreArgv(type, flag) {
      if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
    },
  });
  if (args._.length > 0) {
    process.stderr.write("FATAL: Expected no arguments\n");
    process.exitCode = 2;
    return;
  }
  const problems = await lintChangesets(repository);
  if (problems.length === 0) {
    process.stdout.write("OK: all package changesets are valid\n");
    return;
  }
  for (const problem of problems) process.stderr.write(`FAIL: ${problem}\n`);
  process.exitCode = 1;
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    process.stderr.write(
      `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
