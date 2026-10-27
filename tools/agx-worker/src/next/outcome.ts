import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fromThrowable } from "neverthrow";
import { z } from "../../../shared/src/zod.ts";
import { stateDir } from "../state.ts";
import { verifyKind, type VerifyKind } from "./verify.ts";

export const Outcome = z.enum([
  "stopped",
  "lost",
  "ok",
  "no-change",
  "verify-failed",
  "verify-unrunnable",
  "verify-killed",
  "timeout",
  "capacity",
  "refused",
  "launch-failed",
  "malformed",
]);
export type Outcome = z.output<typeof Outcome>;

const isWithin = (root: string, path: string): boolean => {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
};

/** Compare workspace files, excluding VCS, dependencies, and worker-owned scratch. */
export const workspaceSnapshot = (cwd: string) =>
  fromThrowable(() => {
    const workspaceRoot = resolve(cwd);
    const internalDirectories = [
      stateDir(),
      ...(process.env.AGX_TMP_ROOT === undefined
        ? []
        : [resolve(cwd, process.env.AGX_TMP_ROOT)]),
    ]
      .map((path) => resolve(path))
      .filter(
        (path) => path !== workspaceRoot && isWithin(workspaceRoot, path),
      );
    const capacityLog = process.env.AGX_CAPACITY_LOG;
    const internalFiles =
      capacityLog === undefined
        ? []
        : [resolve(cwd, capacityLog)].filter(
            (path) => path !== workspaceRoot && isWithin(workspaceRoot, path),
          );
    const files = new Map<string, string>();
    const paths = new Bun.Glob("**").scanSync({
      cwd,
      dot: true,
      onlyFiles: false,
      followSymlinks: false,
    });
    for (const path of new Set(paths)) {
      if (
        path
          .split("/")
          .some((part) => [".git", ".jj", "node_modules"].includes(part))
      )
        continue;
      const absolute = resolve(workspaceRoot, path);
      if (
        internalDirectories.some((directory) =>
          isWithin(directory, absolute),
        ) ||
        internalFiles.includes(absolute)
      )
        continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) continue;
      const content = stat.isSymbolicLink()
        ? readlinkSync(absolute)
        : readFileSync(absolute);
      files.set(
        path,
        `${stat.mode}:${createHash("sha256").update(content).digest("hex")}`,
      );
    }
    return files;
  })();

export function changedFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): number {
  return changedPaths(before, after).length;
}

export function changedPaths(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .toSorted();
}

export function deriveOutcome(input: {
  capacity?: boolean;
  timedOut: boolean;
  refused: boolean;
  verify: readonly { exit: number; kind?: VerifyKind }[];
  reportValid: boolean;
  changed: number | undefined;
}): Outcome {
  if (input.timedOut) return "timeout";
  if (input.capacity === true) return "capacity";
  if (input.refused || input.changed === undefined) return "refused";
  const kinds = new Set(
    input.verify.map((check) => check.kind ?? verifyKind(check.exit)),
  );
  if (kinds.has("killed")) return "verify-killed";
  if (kinds.has("unrunnable")) return "verify-unrunnable";
  if (kinds.has("failed")) return "verify-failed";
  if (!input.reportValid) return "malformed";
  if (input.changed === 0) return "no-change";
  return "ok";
}
