import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

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

type VerifyEntry = Readonly<{ command: string; source: string }>;

const verificationEntries = (
  verify: readonly string[],
  always: readonly string[],
): VerifyEntry[] => [
  ...verify.map((command, index) => ({ command, source: `verify[${index}]` })),
  ...always.map((command, index) => ({
    command,
    source: `[verify].always[${index}]`,
  })),
];

function vcsRefusals(
  entries: readonly VerifyEntry[],
  storePaths: readonly string[],
  root: string,
  sandbox: string,
): string[] {
  return entries.flatMap(({ command, source }) => {
    const mutation = mutatingVcsCommand(command);
    if (mutation === undefined) return [];
    return storePaths
      .filter(
        (store) => !(sandbox === "workspace-write" && inside(root, store)),
      )
      .map(
        (store) =>
          `sandbox contract: ${source} command=${JSON.stringify(command)} (${mutation}) cannot write VCS store=${JSON.stringify(store)} under requested sandbox=${sandbox}; worker should leave edits for the dispatcher to commit, or the operator must explicitly choose --sandbox none`,
      );
  });
}

const shellCommands = (source: string): string[][] => {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const pushWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  const pushCommand = () => {
    pushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === undefined) continue;
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined && character === quote) {
      quote = undefined;
      continue;
    }
    if (quote !== undefined) {
      word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === "\n" ||
      character === "("
    ) {
      pushCommand();
      index += Number(
        (character === "|" || character === "&") &&
          source[index + 1] === character,
      );
      continue;
    }
    if (character === ")") {
      pushCommand();
      continue;
    }
    if (/\s/u.test(character)) {
      pushWord();
      continue;
    }
    word += character;
  }
  pushCommand();
  return commands;
};

const wrappers = new Set([
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function skipEnvOptions(words: readonly string[], start: number): number {
  let index = start;
  while (words[index]?.startsWith("-") === true) {
    const option = words[index];
    index++;
    if (option === "-u" || option === "--unset" || option === "-C") index++;
  }
  while (assignment.test(words[index] ?? "")) index++;
  return index;
}

function commandIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) return index;
    if (assignment.test(word) || word === "!") {
      index++;
      continue;
    }
    if (!wrappers.has(word)) return index;
    index++;
    if (word === "env") index = skipEnvOptions(words, index);
  }
  return index;
}

const gitMutations = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "checkout",
  "clean",
  "clone",
  "commit",
  "fetch",
  "gc",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "repack",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "update-index",
  "update-ref",
  "write-tree",
]);
const jjMutations = new Set([
  "abandon",
  "commit",
  "describe",
  "duplicate",
  "edit",
  "new",
  "rebase",
  "restore",
  "resolve",
  "squash",
  "split",
  "undo",
  "unsquash",
]);
const gitGlobalOptionsWithValues = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const jjGlobalOptionsWithValues = new Set([
  "-R",
  "--at-operation",
  "--color",
  "--config",
  "--config-file",
  "--config-toml",
  "--repository",
]);

function subcommandIndex(
  words: readonly string[],
  start: number,
  optionsWithValues: ReadonlySet<string>,
): number {
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) return index;
    if (optionsWithValues.has(word)) {
      index += 2;
      continue;
    }
    if (word.startsWith("--") && word.includes("=")) {
      index++;
      continue;
    }
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    return index;
  }
  return index;
}

function mutatingJjCommand(
  words: readonly string[],
  verbIndex: number,
  verb: string,
): string | undefined {
  if (jjMutations.has(verb)) return `jj ${verb}`;
  const action = words[verbIndex + 1];
  if (
    verb === "bookmark" &&
    [
      "create",
      "delete",
      "forget",
      "move",
      "rename",
      "set",
      "track",
      "untrack",
    ].includes(action ?? "")
  )
    return `jj bookmark ${action}`;
  if (
    verb === "workspace" &&
    ["add", "forget", "rename", "update-stale"].includes(action ?? "")
  )
    return `jj workspace ${action}`;
  if (
    verb === "git" &&
    ["clone", "export", "fetch", "import", "init", "push"].includes(
      action ?? "",
    )
  )
    return `jj git ${action}`;
  if (verb === "op" && ["abandon", "restore"].includes(action ?? ""))
    return `jj op ${action}`;
  if (
    verb === "config" &&
    ["set", "unset", "unset-all", "edit"].includes(action ?? "")
  )
    return `jj config ${action}`;
  return undefined;
}

function mutatingGitCommand(
  words: readonly string[],
  verbIndex: number,
  verb: string,
): string | undefined {
  if (gitMutations.has(verb)) return `git ${verb}`;
  const args = words.slice(verbIndex + 1);
  const action = words[verbIndex + 1];
  if (
    verb === "branch" &&
    (args.some((argument) => !argument.startsWith("-")) ||
      args.some((argument) =>
        ["-c", "-C", "-d", "-D", "-m", "-M"].includes(argument),
      ))
  )
    return "git branch";
  if (
    verb === "tag" &&
    (args.some((argument) => !argument.startsWith("-")) ||
      args.some((argument) =>
        ["-d", "-a", "-f", "-s", "-u"].includes(argument),
      ))
  )
    return "git tag";
  if (
    verb === "worktree" &&
    ["add", "lock", "move", "prune", "remove", "repair", "unlock"].includes(
      action ?? "",
    )
  )
    return `git worktree ${action}`;
  if (
    verb === "remote" &&
    [
      "add",
      "remove",
      "rename",
      "set-head",
      "set-branches",
      "set-url",
      "update",
    ].includes(action ?? "")
  )
    return `git remote ${action}`;
  if (
    verb === "submodule" &&
    [
      "add",
      "absorbgitdirs",
      "deinit",
      "set-branch",
      "set-url",
      "update",
    ].includes(action ?? "")
  )
    return `git submodule ${action}`;
  if (verb === "reflog" && ["delete", "expire"].includes(action ?? ""))
    return `git reflog ${action}`;
  if (
    verb === "maintenance" &&
    ["register", "run", "start", "stop", "unregister"].includes(action ?? "")
  )
    return `git maintenance ${action}`;
  if (
    verb === "config" &&
    (args.some((argument) =>
      [
        "--add",
        "--edit",
        "--replace-all",
        "--remove-section",
        "--rename-section",
        "--unset",
        "--unset-all",
      ].includes(argument),
    ) ||
      args.filter((argument) => !argument.startsWith("-")).length > 1)
  )
    return "git config";
  if (verb === "symbolic-ref" && words.length > verbIndex + 2)
    return "git symbolic-ref";
  return undefined;
}

function mutatingVcsWords(words: readonly string[]): string | undefined {
  const start = commandIndex(words);
  const executable = words[start];
  if (executable === undefined) return undefined;
  const vcs = basename(executable);
  if (vcs !== "git" && vcs !== "jj") return undefined;
  const verbIndex = subcommandIndex(
    words,
    start + 1,
    vcs === "git" ? gitGlobalOptionsWithValues : jjGlobalOptionsWithValues,
  );
  const verb = words[verbIndex];
  if (verb === undefined) return undefined;
  return vcs === "git"
    ? mutatingGitCommand(words, verbIndex, verb)
    : mutatingJjCommand(words, verbIndex, verb);
}

function mutatingVcsCommand(command: string): string | undefined {
  for (const words of shellCommands(command)) {
    const mutation = mutatingVcsWords(words);
    if (mutation !== undefined) return mutation;
  }
  return undefined;
}

export async function inspectSandboxNeeds(
  cwd: string,
  sandbox: string,
  writes: readonly string[],
  verify: readonly string[],
  always: readonly string[] = [],
): Promise<{ warnings: string[]; refusals: string[] }> {
  if (sandbox === "none") return { warnings: [], refusals: [] };
  const warnings: string[] = [];
  const warn = (capability: string, evidence: string) =>
    warnings.push(
      `WARN sandbox capability=${capability}; requested=${sandbox}; evidence=${JSON.stringify(evidence)}; allows=none (--sandbox none, unsandboxed); sandbox unchanged`,
    );
  const entries = verificationEntries(verify, always);
  for (const { command, source } of entries) {
    if (
      /\b(?:systemctl|systemd-run)\b[^\n;&|]*\s--user\b/u.test(command) ||
      /\bagent-resource-run\b/u.test(command)
    )
      warn("user-systemd-bus", `${source}: ${command}`);
  }
  const root = await canonical(cwd);
  const allStores = await stores(root);
  const external = allStores.filter((path) => !inside(root, path));
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
  return { warnings, refusals: vcsRefusals(entries, allStores, root, sandbox) };
}

export async function sandboxNeeds(
  cwd: string,
  sandbox: string,
  writes: readonly string[],
  verify: readonly string[],
  always: readonly string[] = [],
): Promise<string[]> {
  return (await inspectSandboxNeeds(cwd, sandbox, writes, verify, always))
    .warnings;
}
