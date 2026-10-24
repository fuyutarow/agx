import { typeFlag } from "type-flag";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Compiled suite installs prefer executable siblings; Bun source runs use PATH. */
export async function resolveSuiteTool(
  target: string,
  execPath = process.execPath,
): Promise<string> {
  if (!["agx", "agx.exe"].includes(basename(execPath))) return target;
  const sibling = join(dirname(execPath), target);
  const executable = await stat(sibling).then(
    async (info) =>
      info.isFile() &&
      (await access(sibling, constants.X_OK).then(
        () => true,
        () => false,
      )),
    () => false,
  );
  return executable ? sibling : target;
}

// argv-forwarding: PATH
export async function forwardPath(
  target: string,
  argv: string[],
): Promise<number> {
  const parsed = typeFlag({}, [...argv], { ignore: () => true });
  if (Object.keys(parsed.unknownFlags).length > 0) {
    process.stderr.write(`${target}: unexpected forwarding flag\n`);
    return 2;
  }
  // bounded: the selected CLI owns its foreground command lifetime.
  const child = Bun.spawn([target, ...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
