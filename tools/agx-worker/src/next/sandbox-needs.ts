import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const text = (path: string) => readFile(path, "utf8").catch(() => null);
const canonical = (path: string) => realpath(path).catch(() => resolve(path));
const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return (
    tail === "" ||
    (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`))
  );
};

async function directoryStores(directory: string): Promise<string[]> {
  const dotGit = join(directory, ".git");
  const jj = join(directory, ".jj", "repo");
  const gitStat = await stat(dotGit).catch(() => null);
  const jjStat = await stat(jj).catch(() => null);
  const paths: string[] = [];
  if (gitStat !== null) {
    const pointer = /^gitdir:\s*(.+)$/mu
      .exec((await text(dotGit)) ?? "")?.[1]
      ?.trim();
    const gitDir = await canonical(
      pointer === undefined ? dotGit : resolve(directory, pointer),
    );
    paths.push(gitDir);
    const common = (await text(join(gitDir, "commondir")))?.trim();
    if (common !== undefined)
      paths.push(await canonical(resolve(gitDir, common)));
  }
  if (jjStat !== null) {
    const pointer = jjStat.isFile() ? (await text(jj))?.trim() : undefined;
    paths.push(
      await canonical(
        pointer === undefined ? jj : resolve(dirname(jj), pointer),
      ),
    );
  }
  return [...new Set(paths)];
}

/** Filesystem pointers only: never run VCS commands or declared tools. */
async function stores(cwd: string): Promise<string[]> {
  let directory = cwd;
  while (true) {
    const found = await directoryStores(directory);
    if (found.length > 0) return found;
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
}

export async function sandboxNeeds(
  cwd: string,
  sandbox: string,
  writes: readonly string[],
  verify: readonly string[],
  always: readonly string[] = [],
): Promise<string[]> {
  if (sandbox === "none") return [];
  const warnings: string[] = [];
  const warn = (capability: string, evidence: string) =>
    warnings.push(
      `WARN sandbox capability=${capability}; requested=${sandbox}; evidence=${JSON.stringify(evidence)}; allows=none (--sandbox none, unsandboxed); sandbox unchanged`,
    );
  const entries = [
    ...verify.map((command, index) => ({
      command,
      source: `verify[${index}]`,
    })),
    ...always.map((command, index) => ({
      command,
      source: `[verify].always[${index}]`,
    })),
  ];
  for (const { command, source } of entries) {
    if (
      /\b(?:systemctl|systemd-run)\b[^\n;&|]*\s--user\b/u.test(command) ||
      /\bagent-resource-run\b/u.test(command)
    )
      warn("user-systemd-bus", `${source}: ${command}`);
  }
  const root = await canonical(cwd);
  const external = (await stores(root)).filter((path) => !inside(root, path));
  const evidence = [
    ...writes.map((glob, index) => `writes[${index}]: ${glob}`),
    ...entries
      .filter(({ command }) => /\b(?:git|jj)\b/u.test(command))
      .map(({ command, source }) => `${source}: ${command}`),
  ];
  for (const store of external)
    warn(
      "external-vcs-store-write",
      `workspace VCS store=${store}; ${evidence.length === 0 ? "writes=[] (VCS mutation may require store writes)" : evidence.join("; ")}`,
    );
  return warnings;
}
