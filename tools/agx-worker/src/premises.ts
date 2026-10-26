import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { JJ_READ_ARGS } from "../../shared/src/jj-read.ts";
import { readonlyCommand } from "../../shared/src/readonly-command.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { trackedPaths } from "../../shared/src/tracked-paths.ts";

export type PremiseCheck =
  | { status: "ok" }
  | { status: "missing"; premises: string[]; details: string[] }
  | { status: "timeout" };

type CommandResult = { exitCode: number | null; output: string };
type CommandRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => CommandResult;

const DEFAULT_BUDGET_MS = 5_000;

export const PREMISE_KINDS = [
  "file",
  "symbol",
  "bookmark",
  "task",
  "rev",
  "ancestor",
] as const;

export const PREMISE_HELP: Record<(typeof PREMISE_KINDS)[number], string> = {
  file: "file:README.md — a path exists in the worker tree",
  symbol:
    "symbol:routeWorker@src/** — tracked text contains a fixed string (optionally glob-scoped)",
  bookmark:
    "bookmark:main@origin — a bookmark exists (optionally remote-qualified)",
  task: "task:check — a mise task exists",
  rev: "rev:@ — a jj revision resolves",
  ancestor:
    "ancestor:60cfaa97@alpha@origin — a commit is an ancestor of (or equal to) a jj revision",
};

export const premiseHelp = (): string =>
  [
    "Ticket front matter may declare `premises = [...]`; every premise must hold in the --cd tree before a worker starts:",
    ...PREMISE_KINDS.map((kind) => `  ${PREMISE_HELP[kind]}`),
  ].join("\n");

const runCommand: CommandRunner = (argv, cwd, timeoutMs) => {
  const invocation =
    argv[0] === "jj" || argv[0] === "git"
      ? readonlyCommand(argv, cwd)
      : { cmd: argv, env: process.env };
  const result = Bun.spawnSync(invocation.cmd, {
    cwd,
    env: invocation.env,
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGKILL",
    timeout: Math.max(1, Math.floor(timeoutMs)),
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

const outputDetail = (output: string): string => {
  const lines = output
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim());
  return lines.length === 0 || (lines.length === 1 && lines[0] === "")
    ? "(no output)"
    : lines.join("\n");
};

function parseSymbol(value: string): { name: string; glob?: string } {
  const reference = value.slice("symbol:".length);
  const separator = reference.indexOf("@");
  return separator < 0
    ? { name: reference }
    : {
        name: reference.slice(0, separator),
        glob: reference.slice(separator + 1),
      };
}

const MiseTasks = z.array(z.looseObject({ name: z.string() }));

function hasTask(output: string, name: string): boolean {
  const parsed = jsonOf(MiseTasks).safeParse(output);
  return parsed.success && parsed.data.some((task) => task.name === name);
}

function isTimeout(
  result: CommandResult,
  startedAt: number,
  budgetMs: number,
): boolean {
  return result.exitCode === null || performance.now() - startedAt >= budgetMs;
}

function commandResult(
  runner: CommandRunner,
  argv: string[],
  cwd: string,
  startedAt: number,
  budgetMs: number,
): CommandResult | undefined {
  const result = runner(
    argv,
    cwd,
    Math.max(1, budgetMs - (performance.now() - startedAt)),
  );
  return isTimeout(result, startedAt, budgetMs) ? undefined : result;
}

function bookmarkExists(
  premise: string,
  cwd: string,
  runner: CommandRunner,
  startedAt: number,
  budgetMs: number,
): { status: "ok"; exists: boolean; detail: string } | { status: "timeout" } {
  const value = premise.slice("bookmark:".length);
  const at = value.lastIndexOf("@");
  const name = at < 0 ? value : value.slice(0, at);
  const remote = at < 0 ? undefined : value.slice(at + 1);
  if (name.length === 0 || (at >= 0 && remote === ""))
    return {
      status: "ok",
      exists: false,
      detail: `${premise}: invalid bookmark premise`,
    };

  let jjRepo = existsSync(resolve(cwd, ".jj"));
  if (!jjRepo) {
    const root = commandResult(
      runner,
      ["jj", ...JJ_READ_ARGS, "root"],
      cwd,
      startedAt,
      budgetMs,
    );
    if (root === undefined) return { status: "timeout" };
    jjRepo = root.exitCode === 0;
  }
  const argv = jjRepo
    ? [
        "jj",
        ...JJ_READ_ARGS,
        "bookmark",
        "list",
        "--all-remotes",
        "-T",
        'separate("@", name, remote) ++ "\\n"',
      ]
    : ["git", "--no-optional-locks", "show-ref"];
  const result = commandResult(runner, argv, cwd, startedAt, budgetMs);
  if (result === undefined) return { status: "timeout" };
  const lines = result.output.split(/\r?\n/u).map((line) => line.trim());
  const listedName = remote === undefined ? name : `${name}@${remote}`;
  const existsInJj = lines.includes(listedName);
  const existsInGit = lines.some((line) => {
    const ref = line.trim().split(/\s+/u).at(-1);
    if (remote === undefined)
      return ref === `refs/heads/${name}` || ref?.endsWith(`/${name}`) === true;
    return ref === `refs/remotes/${remote}/${name}`;
  });
  return {
    status: "ok",
    exists: result.exitCode === 0 && (jjRepo ? existsInJj : existsInGit),
    detail: `${premise}: check=bookmark-exists expected=true observed=false exit=${result.exitCode}; ${outputDetail(result.output)}`,
  };
}

function simpleCommandExists(
  premise: string,
  kind: "task" | "rev",
  value: string,
  cwd: string,
  runner: CommandRunner,
  startedAt: number,
  budgetMs: number,
): { status: "ok"; exists: boolean; detail: string } | { status: "timeout" } {
  let argv: string[];
  if (kind === "task") argv = ["mise", "tasks", "--json"];
  else
    argv = [
      "jj",
      ...JJ_READ_ARGS,
      "log",
      "-r",
      value,
      "--no-graph",
      "-T",
      "commit_id",
    ];
  const result = commandResult(runner, argv, cwd, startedAt, budgetMs);
  if (result === undefined) return { status: "timeout" };
  const exists =
    result.exitCode === 0 &&
    (kind === "task"
      ? hasTask(result.output, value)
      : result.output.trim().length > 0);
  return {
    status: "ok",
    exists,
    detail: `${premise}: check=${kind}-exists expected=true observed=false exit=${result.exitCode}; ${outputDetail(result.output)}`,
  };
}

function ancestorPremise(
  premise: string,
  cwd: string,
  vcs: "jj" | "git",
  runner: CommandRunner,
  startedAt: number,
  budgetMs: number,
): { status: "ok"; exists: boolean; detail: string } | { status: "timeout" } {
  const value = premise.slice("ancestor:".length);
  const separator = value.indexOf("@");
  const commit = value.slice(0, separator);
  const revision = value.slice(separator + 1);
  if (separator < 0 || commit.length === 0 || revision.length === 0)
    return {
      status: "ok",
      exists: false,
      detail: `${premise}: invalid ancestor premise; expected ancestor:<commit>@<rev>`,
    };

  const resolveArg =
    vcs === "jj"
      ? ["jj", ...JJ_READ_ARGS, "log"]
      : ["git", "rev-parse", "--verify"];
  const resolveCommit =
    vcs === "jj"
      ? [...resolveArg, "-r", commit, "--no-graph", "-T", "commit_id"]
      : [...resolveArg, `${commit}^{commit}`];
  const resolveRevision =
    vcs === "jj"
      ? [...resolveArg, "-r", revision, "--no-graph", "-T", "commit_id"]
      : [...resolveArg, `${revision}^{commit}`];
  const target = commandResult(runner, resolveCommit, cwd, startedAt, budgetMs);
  if (target === undefined) return { status: "timeout" };
  const targetId = target.exitCode === 0 ? target.output.trim() : "";
  const current = commandResult(
    runner,
    resolveRevision,
    cwd,
    startedAt,
    budgetMs,
  );
  if (current === undefined) return { status: "timeout" };
  const currentId = current.exitCode === 0 ? current.output.trim() : "";
  const location =
    currentId === ""
      ? `revision ${revision} currently points to an unavailable commit`
      : `revision ${revision} currently points to ${currentId}`;
  if (targetId === "" || currentId === "")
    return {
      status: "ok",
      exists: false,
      detail: `${premise}: commit ${commit} could not be resolved; ${location}`,
    };

  const ancestry =
    vcs === "jj"
      ? [
          "jj",
          ...JJ_READ_ARGS,
          "log",
          "-r",
          `ancestors(${currentId}) & ${targetId}`,
          "--no-graph",
          "-T",
          "commit_id",
        ]
      : ["git", "merge-base", "--is-ancestor", targetId, currentId];
  const result = commandResult(runner, ancestry, cwd, startedAt, budgetMs);
  if (result === undefined) return { status: "timeout" };
  const exists =
    vcs === "jj"
      ? result.exitCode === 0 && result.output.trim() === targetId
      : result.exitCode === 0;
  return {
    status: "ok",
    exists,
    detail: `${premise}: commit ${targetId} is not an ancestor of revision ${revision}; ${location}`,
  };
}

export function checkPremises(
  premises: string[] | undefined,
  cwd: string,
  options: {
    budgetMs?: number;
    runner?: CommandRunner;
    onTimeout?: (argv: string[], cwd: string, budgetMs: number) => void;
    onTemporaryFailure?: (argv: string[], cwd: string, output: string) => void;
  } = {},
): PremiseCheck {
  if (premises === undefined || premises.length === 0) return { status: "ok" };
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = performance.now();
  const commandRunner = options.runner ?? runCommand;
  const runner: CommandRunner = (argv, directory, timeoutMs) => {
    const result = commandRunner(argv, directory, timeoutMs);
    if (result.exitCode === 75)
      options.onTemporaryFailure?.(argv, directory, result.output);
    if (isTimeout(result, startedAt, budgetMs))
      options.onTimeout?.(argv, directory, budgetMs);
    return result;
  };
  const remaining = (): number => budgetMs - (performance.now() - startedAt);
  const missing: string[] = [];
  const details: string[] = [];

  for (const premise of premises) {
    if (
      premise.startsWith("file:") &&
      !existsSync(resolve(cwd, premise.slice("file:".length)))
    ) {
      missing.push(premise);
      details.push(
        `${premise}: file does not exist; check=file-exists expected=true observed=false`,
      );
    }
  }

  const symbols = premises.filter((premise) => premise.startsWith("symbol:"));
  let files: string[] | undefined;
  if (
    symbols.length > 0 &&
    (existsSync(resolve(cwd, ".git")) || existsSync(resolve(cwd, ".jj")))
  ) {
    const result = trackedPaths((argv) =>
      runner(argv, cwd, Math.max(1, remaining())),
    );
    if (isTimeout(result, startedAt, budgetMs) || result.exitCode !== 0)
      return { status: "timeout" };
    files = result.output.split("\0").filter(Boolean);
  }

  for (const premise of symbols) {
    if (files?.length === 0) {
      missing.push(premise);
      details.push(`${premise}: no matching text`);
      continue;
    }
    const { name, glob } = parseSymbol(premise);
    const argv = ["rg", "--fixed-strings", "--files-with-matches"];
    if (glob !== undefined) argv.push("--glob", glob);
    argv.push("--", name, ...(files ?? ["."]));
    const result = runner(argv, cwd, Math.max(1, remaining()));
    if (isTimeout(result, startedAt, budgetMs)) return { status: "timeout" };
    if (result.exitCode === 1) {
      missing.push(premise);
      details.push(`${premise}: no matching text`);
    } else if (result.exitCode !== 0) return { status: "timeout" };
  }

  const extra = premises.filter((premise) =>
    /^(?:bookmark|task|rev|ancestor):/u.test(premise),
  );
  for (const premise of extra) {
    const colon = premise.indexOf(":");
    const kind = premise.slice(0, colon);
    const value = premise.slice(colon + 1);
    let result:
      | { status: "ok"; exists: boolean; detail: string }
      | { status: "timeout" };
    if (kind === "bookmark")
      result = bookmarkExists(premise, cwd, runner, startedAt, budgetMs);
    else if (kind === "task" || kind === "rev")
      result = simpleCommandExists(
        premise,
        kind,
        value,
        cwd,
        runner,
        startedAt,
        budgetMs,
      );
    else if (kind === "ancestor") {
      const vcs = existsSync(resolve(cwd, ".jj")) ? "jj" : "git";
      result = ancestorPremise(premise, cwd, vcs, runner, startedAt, budgetMs);
    } else continue;
    if (result.status === "timeout") return { status: "timeout" };
    if (!result.exists) {
      missing.push(premise);
      details.push(result.detail);
    }
  }

  return missing.length === 0
    ? { status: "ok" }
    : { status: "missing", premises: missing, details };
}
