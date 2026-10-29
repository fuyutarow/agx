// Run-workspace lifecycle: add, rm, gc. Repository policy comes from shared agx.toml config.
// Explicit GC observations publish the owner-written verdict inventory for small-file readers.
// Store locks and foreground waiter markers are transient and removed on completion.
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import {
  readFile,
  open,
  realpath,
  rename,
  writeFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  cp,
  mkdtemp,
  symlink as createSymlink,
  chmod,
} from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { projectSlug } from "../../shared/src/agent-name.ts";
import {
  listAgxRepos,
  resolveAgxConfigWithProvenance,
} from "../../shared/src/agx-config.ts";
import { resolveAgxBinary } from "../../shared/src/path-dispatch.ts";
import {
  attempt,
  errorMessage,
  type Attempt,
} from "../../shared/src/attempt.ts";
import { acquire, pidAlive } from "../../shared/src/dir-lock.ts";
import { stateDir } from "./state-dir.ts";
import { indexedWorkspaces, recordWorkspace } from "./workspace-index.ts";
import { validateSlug } from "../../shared/src/slug.ts";
import { fromThrowable, jsonOf, z } from "../../shared/src/zod.ts";
import { jjWorkspace, refLocks } from "./jj-workspace.ts";
import { withWorkspaceLock } from "./lock.ts";
import { runStep, StepFailure } from "./subprocess.ts";
import { enterStep } from "./deadline.ts";
import { requireJjTemplateVersion } from "../../shared/src/jj-version.ts";

for (const retired of ["AGX_DOCTOR_HOME", "AGX_DOCTOR_WORKSPACE"]) {
  if (process.env[retired] !== undefined) {
    process.stderr.write(
      `agx-ws: ${retired} is retired; unset it and use AGX_REPOS_ROOT instead\n`,
    );
    process.exit(2);
  }
}

const bad = (message: string): Attempt<never> => ({
  ok: false,
  error: message,
});
const good = <T>(value: T): Attempt<T> => ({ ok: true, value });
const msg = (failed: { error: unknown }): string => errorMessage(failed.error);
type MissingWorkspaceForget = {
  name: string;
  dir: string;
  commit: string;
  trunk: string | null;
  owner?: "land";
  rm?: true;
};

/** jj string literals allow raw UTF-8; only backslashes and double quotes need escaping. */
export const rootFileFileset = (path: string): string =>
  `root-file:"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export type Repo = {
  backing: string;
  name: string;
  parent: string;
  wsRoot: string;
};
export type Config = {
  ready: string[];
  trunk: string;
  trunkConfigured: boolean;
  keep: string[];
  regenerable: string[];
  unjudgedWarnHours?: number;
  policyRevision: string | undefined;
  workingCopyPolicyDiffers: boolean | undefined;
};
type ResolvedConfig = Config & { policySource: string };

export const CONFIG_FILE = "agx.toml";
const LEGACY_CONFIG_FILE = ".ws.toml";
const trunkSettingHint = (bookmark: string): string =>
  `set [ws].trunk in ${CONFIG_FILE}: trunk = ${JSON.stringify(bookmark)}`;
export class LegacyWorkspaceConfigError extends Error {}
// Lookup accepts historical names so refresh/rm still work after the creation rule changes.
const LEGACY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const TERMINAL_STATES = new Set(["ended", "orphaned"]);

export type Ran = { code: number; out: string; err: string };

async function exec(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs?: number,
): Promise<Attempt<Ran>> {
  const ran = await runStep(cmd, cwd, {
    env,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return ran.ok ? good({ ...ran.value, out: ran.value.out.toString() }) : ran;
}

/** Every jj invocation has a named deadline, including reads after workspace creation. */
async function jjOut(
  args: string[],
  cwd: string,
  readonly: boolean,
  missingWorkspace?: MissingWorkspaceForget,
): Promise<Attempt<string>> {
  // All forget callers, including adoption and readiness rollback, cross this boundary.
  if (args[0] === "workspace" && args[1] === "forget") {
    const name = args[2];
    if (name === undefined) return bad("workspace forget requires a name");
    const repo = resolveRepo(cwd);
    if (!repo.ok) return repo;
    const root = await jjOut(["workspace", "root", "--name", name], cwd, true);
    const allowed = await guardWorkspaceForget(
      repo.value,
      cwd,
      name,
      root,
      missingWorkspace,
    );
    if (!allowed.ok) return allowed;
  }
  const ran = await exec(
    [
      "jj",
      "--no-pager",
      "--color=never",
      ...(readonly ? ["--ignore-working-copy"] : []),
      ...args,
    ],
    cwd,
  );
  if (!ran.ok) return bad(`jj ${args.join(" ")}: ${msg(ran)}`);
  return ran.value.code === 0
    ? good(ran.value.out)
    : bad(
        `jj ${args.join(" ")} failed (exit ${ran.value.code}): ${ran.value.err.trim()}`,
      );
}

/** Let jj diagnose staleness; unrelated status failures must never trigger a repair. */
async function updateStale(
  dir: string,
  preserveUntracked = false,
): Promise<Attempt<void>> {
  const flags = preserveUntracked
    ? ["--config", 'snapshot.auto-track="none()"']
    : [];
  const status = await jjOut([...flags, "status"], dir, false);
  if (status.ok) return good(undefined);
  if (!msg(status).includes("working copy is stale")) return status;
  const updated = await jjOut(
    [...flags, "workspace", "update-stale"],
    dir,
    false,
  );
  return updated.ok ? good(undefined) : updated;
}

export function resolveRepo(path: string): Attempt<Repo> {
  const found = jjWorkspace(path);
  if (!found.ok) return bad(msg(found));
  const backing = found.value.backingRoot;
  const name = basename(backing);
  const parent = dirname(backing);
  return good({ backing, name, parent, wsRoot: join(parent, `${name}.ws`) });
}

/** Refuse the retired file, then resolve shared main-checkout L1/L2 policy. */
export async function readConfig(repo: Repo): Promise<Attempt<ResolvedConfig>> {
  const legacyPath = join(repo.backing, LEGACY_CONFIG_FILE);
  const legacyFile = await attempt(() => lstat(legacyPath));
  if (legacyFile.ok) {
    const rendered = await attempt(async () => {
      const parsed = Bun.TOML.parse(await readFile(legacyPath, "utf8"));
      return Bun.TOML.stringify({ schema: 1, ws: parsed });
    });
    const equivalent = legacyMigration(rendered);
    const message = equivalent.ok
      ? `${legacyPath} is retired. Replace ${CONFIG_FILE} with:\n${equivalent.value}\nThen delete ${LEGACY_CONFIG_FILE}.`
      : `${legacyPath} is retired; cannot render a valid [ws] migration (${msg(equivalent)}). Delete ${LEGACY_CONFIG_FILE}.`;
    return {
      ok: false,
      error: new LegacyWorkspaceConfigError(message),
    };
  }
  if (
    !z.object({ code: z.literal("ENOENT") }).safeParse(legacyFile.error).success
  )
    return bad(msg(legacyFile));

  const shared = await resolveAgxConfigWithProvenance(repo.backing, {
    vcs: "jj",
  });
  if (!shared.ok) return bad(msg(shared));
  return good({
    policySource: shared.value.policySource,
    ready: shared.value.ready,
    trunk: shared.value.trunk,
    trunkConfigured: shared.value.trunkConfigured,
    keep: shared.value.keep,
    regenerable: shared.value.regenerable,
    unjudgedWarnHours: shared.value.unjudgedWarnHours,
    policyRevision: shared.value.policyRevision,
    workingCopyPolicyDiffers: shared.value.workingCopyPolicyDiffers,
  });
}

function reportReadyPlan(config: Config): void {
  const revision = config.policyRevision ?? "unknown revision";
  process.stderr.write(`ws: policy: agx.toml at ${revision}\n`);
  if (config.workingCopyPolicyDiffers === true)
    process.stderr.write(
      `ws: policy: working-copy agx.toml differs from the policy snapshot at ${revision}; working-copy policy is not used\n`,
    );
  if (config.ready.length === 0) {
    process.stderr.write(
      `ws: ready: none declared in agx.toml at ${revision}\n`,
    );
    return;
  }
  for (const [index, command] of config.ready.entries())
    process.stderr.write(
      `ws: ready: will run ${index + 1}/${config.ready.length}: ${command}\n`,
    );
}

function legacyMigration(
  rendered: Attempt<string | undefined>,
): Attempt<string> {
  if (!rendered.ok) return rendered;
  if (rendered.value === undefined)
    return bad("TOML serializer returned no migration");
  return good(rendered.value.trimEnd());
}

function legacyWorkspaceName(slug: string): Attempt<string> {
  return LEGACY_NAME.test(slug)
    ? good(`ws_${slug}`)
    : bad(`invalid slug '${slug}': use letters, digits, '_' and '-'`);
}

/** Filesystem type of the nearest existing ancestor; preserve named step failures. */
export async function fsType(
  path: string,
  runCommand: typeof exec = exec,
): Promise<Attempt<string>> {
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const forms = [
    ["-f", "-c", "%T", probe], // GNU stat
    ["-f", "%T", probe], // BSD stat
  ];
  const failures: string[] = [];
  for (const args of forms) {
    const ran = await runCommand(["stat", ...args], probe);
    if (ran.ok && ran.value.code === 0) return good(ran.value.out.trim());
    failures.push(
      ran.ok
        ? `stat ${args.join(" ")} failed (exit ${ran.value.code}): ${ran.value.err.trim()}`
        : `stat ${args.join(" ")} failed: ${msg(ran)}`,
    );
  }
  return bad(failures.join("; "));
}

export type Graveyard = { path: string };

/** rip's graveyard, refused when RAM-backed: a buried workspace there vanishes on reboot. */
export async function checkGraveyard(): Promise<Attempt<Graveyard>> {
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const path =
    process.env.RIP_GRAVEYARD ??
    process.env.GRAVEYARD ??
    join(data, "graveyard");
  const type = await fsType(path);
  if (!type.ok) return type;
  if (type.value === "tmpfs" || type.value === "ramfs")
    return bad(
      `graveyard ${path} is on ${type.value} (RAM-backed); set RIP_GRAVEYARD to a disk path`,
    );
  return good({ path });
}

async function bury(
  graveyard: Graveyard,
  dir: string,
  commit: string,
): Promise<Attempt<void>> {
  // The directory still contains its store pointer after forget. Recheck before moving it.
  const repo = resolveRepo(dir);
  if (!repo.ok) return repo;
  const allowed = await removalGuard(repo.value, dir, commit);
  if (!allowed.ok) return allowed;
  if (Bun.which("rip") === null)
    return bad("rip is not on PATH: mise run install:tools");
  const ran = await exec(["rip", dir], dirname(dir), {
    GRAVEYARD: graveyard.path,
    RIP_GRAVEYARD: graveyard.path,
  });
  if (!ran.ok) return bad(`rip ${dir}: ${msg(ran)}`);
  return ran.value.code === 0
    ? good(undefined)
    : bad(`rip ${dir} failed: ${ran.value.err.trim()}`);
}

function miseStateDir(): string {
  const configured = process.env.MISE_STATE_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const stateHome = process.env.XDG_STATE_HOME;
  return join(
    stateHome === undefined || stateHome === ""
      ? join(process.env.HOME ?? homedir(), ".local", "state")
      : stateHome,
    "mise",
  );
}

async function guardWorkspaceForget(
  repo: Repo,
  cwd: string,
  name: string,
  root: Attempt<string>,
  missing?: MissingWorkspaceForget,
): Promise<Attempt<void>> {
  if (missing === undefined) {
    if (!root.ok) return root;
    return removalGuard(repo, resolve(cwd, root.value.trim()));
  }
  if (missing.name !== name)
    return bad("missing workspace proof does not match forget target");
  if (
    root.ok &&
    realOr(resolve(cwd, root.value.trim())) !== realOr(missing.dir)
  )
    return bad("workspace registration changed before forgetting");
  return verifyMissingWorkspaceForget(repo, missing);
}

function pathIsInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function symlinksWithin(
  directory: string,
  root: string,
): Promise<string[]> {
  const entries = existsSync(directory) ? await readdir(directory) : [];
  const matching = await Promise.all(
    entries.map(async (entry) => {
      const link = join(directory, entry);
      if (!(await lstat(link)).isSymbolicLink()) return null;
      const target = resolve(dirname(link), await readlink(link));
      return pathIsInside(root, target) ? link : null;
    }),
  );
  return matching.filter((link) => link !== null);
}

/** Remove only mise state links that point into the workspace being buried. */
async function untrackMiseWorkspace(dir: string, cwd: string): Promise<void> {
  const root = resolve(dir);
  const state = miseStateDir();
  const trusted = join(state, "trusted-configs");
  const mise = Bun.which("mise");
  if (mise === null)
    process.stderr.write(
      "ws: mise command cleanup skipped (mise not on PATH); removing matching state links directly\n",
    );
  for (const link of await symlinksWithin(trusted, root)) {
    const target = resolve(dirname(link), await readlink(link));
    // mise has used both config-file and parent-directory trust targets. Passing
    // a config path lets mise own removal; the fallback remains workspace-scoped.
    const config = basename(target).endsWith(".toml")
      ? target
      : join(target, "mise.toml");
    if (mise !== null) await exec(["mise", "untrust", config], cwd);
  }
  for (const kind of ["tracked-configs", "trusted-configs"]) {
    const directory = join(state, kind);
    for (const link of await symlinksWithin(directory, root)) await rm(link);
  }
}

/** Preconditions common to every verb: checked before any work, each failure names its repair. */
function common(repo: Repo, readonly = false): Attempt<void> {
  if (Bun.which("jj") === null)
    return bad("jj is not on PATH: mise run install:tools");
  if (!readonly) {
    const writable = fromThrowable(() => {
      accessSync(repo.parent, constants.W_OK);
    })();
    if (writable.isErr())
      return bad(
        `${repo.parent} is not writable: the store lock and ${repo.name}.ws live there`,
      );
  }
  const locks = refLocks({
    root: repo.backing,
    repo: join(repo.backing, ".jj", "repo"),
    backingRoot: repo.backing,
  });
  if (!locks.ok) return bad(msg(locks));
  return locks.value.length > 0
    ? bad(
        `Git ref locks present (another process may be writing): ${locks.value.join(", ")}; they are never removed here`,
      )
    : good(undefined);
}

async function withLock<T>(
  repo: Repo,
  what: string,
  fn: () => Promise<Attempt<T>>,
  skipBusy?: (reason: string) => Attempt<T>,
): Promise<Attempt<T>> {
  return withWorkspaceLock(
    join(repo.parent, `${repo.name}.ws.lock`),
    what,
    fn,
    skipBusy,
  );
}

async function workspaceNames(repo: Repo): Promise<Attempt<string[]>> {
  const out = await jjOut(
    ["workspace", "list", "-T", 'name ++ "\\n"'],
    repo.backing,
    true,
  );
  return out.ok ? good(out.value.split("\n").filter(Boolean)) : out;
}

/** Non-empty changes reachable from tip but neither trunk nor a remote bookmark. */
async function unlandedFrom(
  cwd: string,
  tip: string,
  trunk: string,
  readonly: boolean,
): Promise<Attempt<string[]>> {
  const out = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      `(::(${tip}) ~ ::((${trunk}) | remote_bookmarks())) ~ empty()`,
      "-T",
      'commit_id.short(12) ++ " " ++ description.first_line() ++ "\\n"',
    ],
    cwd,
    readonly,
  );
  return out.ok ? good(out.value.split("\n").filter(Boolean)) : out;
}

async function pushedBookmarks(
  cwd: string,
  tip: string,
  trunk: string,
): Promise<Attempt<string[]>> {
  const out = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      `remote_bookmarks() & ::((${tip}) ~ ::(${trunk}))`,
      "-T",
      'remote_bookmarks ++ "\\n"',
    ],
    cwd,
    true,
  );
  if (!out.ok) return out;
  return good([...new Set(out.value.split("\n").filter(Boolean))].toSorted());
}

/**
 * The unlanded changes of a workspace. In the workspace directory jj snapshots its working copy
 * first, so uncommitted edits count. `endCommits` are run-end commit ids recorded by agx.
 * A revset that cannot be evaluated is an error, never "nothing unlanded".
 */
export async function unlanded(
  repo: Repo,
  cfg: Config,
  dir: string,
  name: string,
  endCommits: string[],
  registeredOnly = false,
): Promise<Attempt<string[]>> {
  const here =
    existsSync(dir) && !registeredOnly
      ? await unlandedFrom(dir, "@", cfg.trunk, false)
      : await unlandedFrom(repo.backing, `${name}@`, cfg.trunk, true);
  // A registered workspace's working-copy view can be unavailable from its own
  // directory (for example, an old layout or a damaged working-copy pointer).
  // In that case, try the registered workspace commit from the backing checkout
  // before reporting an unknown result.
  const retried = !here.ok && existsSync(dir) && !registeredOnly;
  const resolved = retried
    ? await unlandedFrom(repo.backing, `${name}@`, cfg.trunk, true)
    : here;
  if (!resolved.ok) return bad(`cannot judge ${dir}: ${msg(resolved)}`);
  if (retried) {
    const differences = await trackedDiskDifferences(repo, cfg, dir);
    if (!differences.ok) return differences;
    if (differences.value.length > 0)
      return bad(
        `cannot judge ${dir}: disk files differ from ${cfg.trunk}: ${differences.value.join(", ")}`,
      );
  }
  const found = [...resolved.value];
  for (const id of endCommits) {
    const past = await unlandedFrom(repo.backing, id, cfg.trunk, true);
    if (!past.ok)
      return bad(`cannot judge run-end commit ${id} of ${dir}: ${msg(past)}`);
    found.push(...past.value.filter((line) => !found.includes(line)));
  }
  if (found.length === 0 || endCommits.length > 0) return good(found);
  const trunk = await trunkCommit(repo, cfg);
  if (!trunk.ok) return trunk;
  if (trunk.value === null) return good(found);
  const tipRepo =
    registeredOnly || retried || !existsSync(dir) ? repo.backing : dir;
  const tipRevision = tipRepo === repo.backing ? `${name}@` : "@";
  const tip = await jjOut(
    ["log", "--no-graph", "-r", tipRevision, "-T", "commit_id"],
    tipRepo,
    tipRepo === repo.backing,
  );
  if (!tip.ok) return bad(`cannot judge ${dir}: ${msg(tip)}`);
  const content = await outstanding(repo, tip.value.trim(), trunk.value);
  if (!content.ok)
    return bad(`cannot compare ${dir} with trunk: ${msg(content)}`);
  if (content.value.differing.length === 0) return good([]);
  return good(found);
}

/** Linux: pids whose cwd lies inside `dir` (a process may work there with no agx record). */
export function pidsInside(dir: string): number[] {
  if (!existsSync("/proc/self/cwd")) return [];
  const inside = (cwd: string): boolean =>
    cwd === dir || cwd.startsWith(dir + sep);
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .filter((entry) => {
      const cwd = fromThrowable(() => readlinkSync(`/proc/${entry}/cwd`))();
      return cwd.isOk() && inside(cwd.value);
    })
    .map(Number);
}

function busy(dir: string): string | undefined {
  const pids = pidsInside(dir);
  return pids.length === 0
    ? undefined
    : `processes are working inside ${dir} (pid ${pids.join(", ")})`;
}

/** Recognize local metadata/revision loss without relabeling conflicts or ordinary query errors. */
function brokenWorkspaceReason(error: unknown): string | undefined {
  const reason = errorMessage(error);
  if (reason.includes("is not a valid local jj workspace")) return reason;
  const missing = z.object({ code: z.literal("ENOENT") }).safeParse(error);
  if (missing.success) return reason;
  return /no working copy|working copy (?:commit|revision).*(?:missing|not found|does not exist)|(?:revision|commit).*(?:doesn't exist|does not exist|not found|unknown)|failed to read checkout state|failed to decode protobuf message/iu.test(
    reason,
  )
    ? reason
    : undefined;
}

async function forgetAndBury(
  repo: Repo,
  graveyard: Graveyard,
  name: string,
  dir: string,
  abandon = false,
): Promise<Attempt<boolean>> {
  const burialTip = await jjOut(
    ["log", "--no-graph", "-r", `${name}@`, "-T", "commit_id"],
    repo.backing,
    true,
  );
  if (!burialTip.ok) return burialTip;
  const tip = abandon
    ? await jjOut(
        [
          "log",
          "--no-graph",
          "-r",
          `${name}@`,
          "-T",
          'commit_id ++ "\\t" ++ immutable',
        ],
        repo.backing,
        true,
      )
    : good("");
  if (!tip.ok) return tip;
  const [tipId, immutableValue] = tip.value.trim().split("\t");
  if (
    abandon &&
    (tipId === undefined ||
      (immutableValue !== "true" && immutableValue !== "false"))
  )
    return bad(`cannot determine whether ${name}@ is immutable`);
  let immutable = immutableValue === "true";
  const forgot = await jjOut(
    ["workspace", "forget", name],
    repo.backing,
    false,
  );
  if (!forgot.ok) return forgot;
  if (abandon && !immutable && tipId !== undefined) {
    const abandoned = await jjOut(["abandon", tipId], repo.backing, false);
    if (!abandoned.ok && !msg(abandoned).includes("immutable"))
      return abandoned;
    immutable = !abandoned.ok;
  }
  const buried = await bury(graveyard, dir, burialTip.value.trim());
  if (!buried.ok) return buried;
  const mise = await attempt(() => untrackMiseWorkspace(dir, repo.backing));
  return mise.ok ? good(immutable) : bad(`mise cleanup ${dir}: ${msg(mise)}`);
}

type TombstonedWorkspace = { tombstone: string; immutable: boolean };

/** Forget and atomically detach the checkout while the store lock is held. */
async function forgetAndTombstone(
  repo: Repo,
  name: string,
  dir: string,
  abandon = false,
): Promise<Attempt<TombstonedWorkspace>> {
  if (Bun.which("rip") === null)
    return bad("rip is not on PATH: mise run install:tools");
  const tip = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      `${name}@`,
      "-T",
      abandon ? 'commit_id ++ "\\t" ++ immutable' : "commit_id",
    ],
    repo.backing,
    true,
  );
  if (!tip.ok) return tip;
  const [tipId, immutableValue] = tip.value.trim().split("\t");
  if (
    abandon &&
    (tipId === undefined ||
      (immutableValue !== "true" && immutableValue !== "false"))
  )
    return bad(`cannot determine whether ${name}@ is immutable`);
  let immutable = immutableValue === "true";
  const mise = await attempt(() => untrackMiseWorkspace(dir, repo.backing));
  if (!mise.ok) return bad(`mise cleanup ${dir}: ${msg(mise)}`);
  const forgot = await jjOut(
    ["workspace", "forget", name],
    repo.backing,
    false,
  );
  if (!forgot.ok) return forgot;
  if (abandon && !immutable && tipId !== undefined) {
    const abandoned = await jjOut(["abandon", tipId], repo.backing, false);
    if (!abandoned.ok && !msg(abandoned).includes("immutable"))
      return abandoned;
    immutable = !abandoned.ok;
  }
  const tombstone = join(
    dirname(dir),
    `.agx-ws-tombstone-${crypto.randomUUID()}`,
  );
  const moved = await attempt(() => rename(dir, tombstone));
  return moved.ok
    ? good({ tombstone, immutable })
    : bad(
        `workspace ${name} was forgotten but could not be tombstoned: ${msg(moved)}`,
      );
}

/** Delete a detached tree only after releasing the store lock. */
async function deleteTombstone(
  graveyard: Graveyard,
  tombstone: string,
): Promise<Attempt<void>> {
  if (Bun.which("rip") === null)
    return bad("rip is not on PATH: mise run install:tools");
  const ran = await exec(["rip", tombstone], dirname(tombstone), {
    GRAVEYARD: graveyard.path,
    RIP_GRAVEYARD: graveyard.path,
  });
  if (!ran.ok) return bad(`rip ${tombstone}: ${msg(ran)}`);
  return ran.value.code === 0
    ? good(undefined)
    : bad(`rip ${tombstone} failed: ${ran.value.err.trim()}`);
}

/** Hold land's own lock through the forget and tombstone rename. */
async function collectWorkspace(
  repo: Repo,
  ws: Workspace,
  abandon = false,
): Promise<Attempt<TombstonedWorkspace>> {
  const state = landState(ws);
  if (state === undefined)
    return forgetAndTombstone(repo, ws.name, ws.dir, abandon);
  const release = await acquire(
    join(state, "land.lock"),
    {
      pid: process.pid,
      host: hostname(),
      what: "agx ws gc land-temp",
      since: Temporal.Now.instant().toString(),
    },
    { waitMs: 0 },
  );
  if (typeof release !== "function")
    return bad("land lock acquired by another process; checkout retained");
  const result = await attempt(() => forgetAndTombstone(repo, ws.name, ws.dir));
  release();
  return result.ok ? result.value : bad(msg(result));
}

export type AddOptions = {
  slug: string;
  rev?: string | undefined;
  noFetch?: boolean | undefined;
  repo: string;
  reuse?: boolean | undefined;
  json?: boolean | undefined;
};

async function installMissingMiseTools(dir: string): Promise<Attempt<void>> {
  const missing = await exec(["mise", "install", "--dry-run-code"], dir);
  if (!missing.ok) return bad(`mise install --dry-run-code: ${msg(missing)}`);
  if (missing.value.code === 0) return good(undefined);
  if (missing.value.code !== 1)
    return {
      ok: false,
      error: new StepFailure(
        `mise install --dry-run-code failed (exit ${missing.value.code}): ${missing.value.err.trim()}`,
        missing.value.code,
      ),
    };
  const installed = await exec(["mise", "install"], dir);
  if (!installed.ok) return bad(`mise install: ${msg(installed)}`);
  if (installed.value.code === 0) return good(undefined);
  return {
    ok: false,
    error: new StepFailure(
      `mise install failed (exit ${installed.value.code}): ${installed.value.err.trim()}`,
      installed.value.code,
    ),
  };
}

export type AddBaseReceipt = {
  change_id: string;
  commit_id: string;
  ref: string;
  fetch_succeeded: boolean | null;
  fetch: "succeeded" | "unfetched" | "no remote" | "explicit --rev";
};

export type AddResult = {
  workspace: string;
  policy_source: string;
  base?: AddBaseReceipt;
};

/** Runs in the coordinator's environment, before a sandboxed worker receives the path. */
async function readyWorkspace(
  dir: string,
  cfg: Config,
  json: boolean,
): Promise<Attempt<void>> {
  enterStep("workspace readiness");
  const current = await updateStale(dir);
  if (!current.ok) return current;
  const sparse = await jjOut(
    ["sparse", "set", "--clear", "--add", "."],
    dir,
    false,
  );
  if (!sparse.ok) return sparse;
  let hasMiseConfig = false;
  for (const name of ["mise.toml", ".mise.toml"]) {
    const config = join(dir, name);
    if (!(await Bun.file(config).exists())) continue;
    hasMiseConfig = true;
    if (Bun.which("mise") === null)
      return bad("mise is not on PATH: mise run install:tools");
    const trusted = await exec(["mise", "trust", config], dir);
    if (!trusted.ok) return bad(`mise trust ${config}: ${msg(trusted)}`);
    if (trusted.value.code !== 0)
      return {
        ok: false,
        error: new StepFailure(
          `mise trust ${config} failed (exit ${trusted.value.code}): ${trusted.value.err.trim()}`,
          trusted.value.code,
        ),
      };
    process.stderr.write(`ws: ready: trusted ${config}\n`);
  }
  if (hasMiseConfig) {
    const installed = await installMissingMiseTools(dir);
    if (!installed.ok) return installed;
  }
  for (const command of cfg.ready) {
    process.stderr.write(`ws: ready: ${command}\n`);
    const ran = await runStep(["sh", "-c", command], dir, {
      output: json ? "json" : "inherit",
    });
    if (!ran.ok) return ran;
    if (ran.value.code !== 0)
      return {
        ok: false,
        error: new StepFailure(
          `readiness command failed (exit ${ran.value.code}): ${command}`,
          ran.value.code,
        ),
      };
  }
  return good(undefined);
}

async function commitId(repo: Repo, rev: string): Promise<Attempt<string>> {
  const result = await jjOut(
    ["log", "--no-graph", "-r", rev, "-T", "commit_id"],
    repo.backing,
    true,
  );
  return result.ok ? good(result.value.trim()) : result;
}

async function trunkBookmark(
  repo: Repo,
  trunk: string,
): Promise<Attempt<string>> {
  if (/^[A-Za-z0-9_./-]+$/u.test(trunk)) return good(trunk);
  const result = await jjOut(
    ["log", "--no-graph", "-r", trunk, "-T", 'bookmarks.join("\\n")'],
    repo.backing,
    true,
  );
  if (!result.ok) return result;
  const displayed = result.value.trim().split("\n").find(Boolean) ?? "";
  return good(displayed.replace(/[*?]+$/u, ""));
}

async function remoteTrunk(
  repo: Repo,
  bookmark: string,
  remotes: string[],
): Promise<Attempt<{ ref: string; commit: string }>> {
  const orderedRemotes = [
    "origin",
    ...remotes.filter((remote) => remote !== "origin"),
  ];
  for (const remote of orderedRemotes) {
    const ref = `${bookmark}@${remote}`;
    const commit = await commitId(repo, ref);
    if (commit.ok && commit.value !== "")
      return good({ ref, commit: commit.value });
  }
  return bad(
    `no remote-tracking trunk bookmark found for ${JSON.stringify(bookmark)}; fetch the trunk bookmark or set [ws].trunk in agx.toml`,
  );
}

async function warnTrunkCopyDifferences(
  repo: Repo,
  bookmark: string,
  remote: { ref: string; commit: string },
): Promise<void> {
  const [local, gitCopy] = await Promise.all([
    commitId(repo, bookmark),
    commitId(repo, `${bookmark}@git`),
  ]);
  const differing: string[] = [];
  if (local.ok && local.value !== "" && local.value !== remote.commit)
    differing.push(`local ${bookmark}`);
  if (gitCopy.ok && gitCopy.value !== "" && gitCopy.value !== remote.commit)
    differing.push(`${bookmark}@git`);
  if (differing.length === 0) return;
  process.stderr.write(
    `ws: warning: ${differing.join(" and ")} ${differing.length === 1 ? "differs" : "differ"} from ${remote.ref}; using ${remote.ref}\n`,
  );
}

async function resolveAddBase(
  repo: Repo,
  trunk: string,
  noFetch: boolean,
): Promise<Attempt<{ rev: string | undefined; receipt: AddBaseReceipt }>> {
  const listed = await jjOut(["git", "remote", "list"], repo.backing, true);
  if (!listed.ok) return listed;
  const remotes = listed.value
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((remote) => remote !== "");
  let fetchSucceeded: boolean | null = null;
  if (remotes.length > 0 && !noFetch) {
    enterStep("fetch trunk remotes");
    const fetched = await exec(
      ["jj", "--no-pager", "--color=never", "git", "fetch", "--all-remotes"],
      repo.backing,
      undefined,
      30_000,
    );
    if (!fetched.ok)
      return {
        ok: false,
        error: new StepFailure(
          `jj git fetch --all-remotes failed: ${msg(fetched)}; repair remote connectivity or retry with --no-fetch to use an explicitly unfetched base`,
          fetched.error instanceof StepFailure ? fetched.error.code : 1,
        ),
      };
    if (fetched.value.code !== 0)
      return bad(
        `jj git fetch --all-remotes failed (exit ${fetched.value.code}): ${fetched.value.err.trim()}; repair remote connectivity or retry with --no-fetch to use an explicitly unfetched base`,
      );
    fetchSucceeded = true;
  }
  if (remotes.length > 0 && noFetch) fetchSucceeded = false;

  let baseRef = trunk;
  let selectedRev: string | undefined = baseRef;
  let receiptRef = baseRef;
  if (remotes.length === 0) {
    // Preserve jj workspace add's historical default parent when no remote exists.
    // trunk() may resolve to root() even while the working copy has useful content.
    baseRef = "@";
    selectedRev = undefined;
    receiptRef = "jj default (@)";
  }
  if (remotes.length > 0) {
    const bookmark = await trunkBookmark(repo, trunk);
    if (!bookmark.ok) return bookmark;
    if (bookmark.value === "")
      return bad(
        `cannot identify a bookmark for configured trunk ${JSON.stringify(trunk)}; set [ws].trunk in agx.toml to a bookmark name`,
      );
    const remote = await remoteTrunk(repo, bookmark.value, remotes);
    if (!remote.ok) return remote;
    await warnTrunkCopyDifferences(repo, bookmark.value, remote.value);
    baseRef = remote.value.ref;
    const ancestor = await jjOut(
      [
        "log",
        "--no-graph",
        "-r",
        `${remote.value.ref} & ::${bookmark.value}`,
        "-T",
        "commit_id",
      ],
      repo.backing,
      true,
    );
    if (ancestor.ok && ancestor.value.trim() === remote.value.commit)
      baseRef = bookmark.value;
    selectedRev = baseRef;
    receiptRef = baseRef;
  }
  const baseIds = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      baseRef,
      "-T",
      'change_id ++ "\\t" ++ commit_id',
    ],
    repo.backing,
    true,
  );
  if (!baseIds.ok) return baseIds;
  const [change_id, commit_id] = baseIds.value.trim().split("\t");
  if (change_id === undefined || commit_id === undefined)
    return bad(`cannot read base identifiers from ${baseRef}`);
  let fetch: AddBaseReceipt["fetch"] = "no remote";
  if (fetchSucceeded === true) fetch = "succeeded";
  else if (fetchSucceeded === false) fetch = "unfetched";
  return good({
    rev: selectedRev,
    receipt: {
      change_id,
      commit_id,
      ref: receiptRef,
      fetch_succeeded: fetchSucceeded,
      fetch,
    },
  });
}

export async function add(options: AddOptions): Promise<Attempt<AddResult>> {
  enterStep("validate workspace and read configuration");
  const slug = validateSlug(options.slug, "agx ws add");
  if (!slug.ok) return slug;
  const name = `ws_${slug.value}`;
  const repo = resolveRepo(options.repo);
  if (!repo.ok) return repo;
  const cfg = await readConfig(repo.value);
  if (!cfg.ok) return cfg;
  reportReadyPlan(cfg.value);
  const pre = common(repo.value);
  if (!pre.ok) return pre;
  const graveyard = await checkGraveyard();
  if (!graveyard.ok) return graveyard;
  const dir = join(repo.value.wsRoot, name);
  if (options.rev !== undefined) {
    const rev = await jjOut(
      ["log", "--no-graph", "-r", options.rev, "-T", 'commit_id ++ "\\n"'],
      repo.value.backing,
      true,
    );
    if (!rev.ok) return bad(`--rev ${options.rev}: ${msg(rev)}`);
    if (rev.value.split("\n").filter(Boolean).length !== 1)
      return bad(`--rev ${options.rev} must name exactly one commit`);
  }
  enterStep("acquire workspace store lock");
  const result = await withLock(
    repo.value,
    `agx ws add ${options.slug}`,
    async () => {
      enterStep("check workspace registration");
      const names = await workspaceNames(repo.value);
      if (!names.ok) return names;
      const present = existsSync(dir);
      if (present) {
        if (options.reuse === true && names.value.includes(name)) {
          const recorded = await recordWorkspace(repo.value.backing, dir);
          return recorded.ok
            ? good({ workspace: dir, policy_source: cfg.value.policySource })
            : recorded;
        }
        return bad(`${dir} already exists`);
      }
      if (names.value.includes(name))
        return bad(`jj workspace ${name} is already registered`);
      const source = jjWorkspace(options.repo);
      if (!source.ok) return source;
      enterStep("refresh source workspace");
      for (const root of new Set([source.value.root, repo.value.backing])) {
        const current = await updateStale(root);
        if (!current.ok) return current;
      }
      let selectedRev = options.rev;
      let base: AddBaseReceipt | undefined;
      if (selectedRev === undefined) {
        const selected = await resolveAddBase(
          repo.value,
          cfg.value.trunk,
          options.noFetch === true,
        );
        if (!selected.ok) return selected;
        selectedRev = selected.value.rev;
        base = selected.value.receipt;
      }
      if (selectedRev !== undefined && base === undefined) {
        const baseIds = await jjOut(
          [
            "log",
            "--no-graph",
            "-r",
            selectedRev,
            "-T",
            'change_id ++ "\\t" ++ commit_id',
          ],
          repo.value.backing,
          true,
        );
        if (!baseIds.ok) return baseIds;
        const [change_id, commit_id] = baseIds.value.trim().split("\t");
        if (change_id !== undefined && commit_id !== undefined)
          base = {
            change_id,
            commit_id,
            ref: selectedRev,
            fetch_succeeded: null,
            fetch: "explicit --rev",
          };
      }
      enterStep("create workspace");
      await mkdir(repo.value.wsRoot, { recursive: true });
      const made = await jjOut(
        [
          "workspace",
          "add",
          "--name",
          name,
          ...(selectedRev === undefined ? [] : ["-r", selectedRev]),
          dir,
        ],
        repo.value.backing,
        false,
      );
      if (!made.ok) return made;
      // Record immediately: failed readiness may retain the new workspace.
      const recorded = await recordWorkspace(repo.value.backing, dir);
      if (!recorded.ok) return recorded;
      const ready = await readyWorkspace(dir, cfg.value, options.json === true);
      if (!ready.ok) {
        enterStep("roll back workspace readiness failure");
        const undone = await forgetAndBury(
          repo.value,
          graveyard.value,
          name,
          dir,
        );
        const failure = `${msg(ready)}; ${
          undone.ok
            ? "the new workspace was removed"
            : `rollback also failed: ${msg(undone)} (remove ${dir} by hand)`
        }`;
        return {
          ok: false,
          error: new StepFailure(
            failure,
            ready.error instanceof StepFailure ? ready.error.code : 1,
          ),
        };
      }
      enterStep("release workspace store lock");
      return good({
        workspace: dir,
        policy_source: cfg.value.policySource,
        ...(base === undefined ? {} : { base }),
      });
    },
  );
  // Verdict inventory belongs to explicit gc, never the latency path of one creation.
  return result;
}

/** Repair only the named workspace: no readiness commands or sparse changes. */
export async function refresh(options: {
  slug: string;
  repo: string;
}): Promise<Attempt<string>> {
  const name = legacyWorkspaceName(options.slug);
  if (!name.ok) return name;
  const repo = resolveRepo(options.repo);
  if (!repo.ok) return repo;
  const config = await readConfig(repo.value);
  if (!config.ok) return config;
  const pre = common(repo.value);
  if (!pre.ok) return pre;
  const dir = join(repo.value.wsRoot, name.value);
  return withLock(repo.value, `agx ws refresh ${options.slug}`, async () => {
    const owner = jjWorkspace(dir);
    if (!owner.ok) return owner;
    if (
      owner.value.root !== dir ||
      owner.value.backingRoot !== repo.value.backing
    )
      return bad(`${dir} is not a jj workspace of ${repo.value.backing}`);
    const names = await workspaceNames(repo.value);
    if (!names.ok) return names;
    if (!names.value.includes(name.value))
      return bad(`${name.value} is not a registered jj workspace`);
    const current = await updateStale(dir);
    return current.ok ? good(dir) : current;
  });
}

export async function remove(options: {
  slug: string;
  repo: string;
  discardBroken?: boolean;
}): Promise<Attempt<string>> {
  const name = legacyWorkspaceName(options.slug);
  if (!name.ok) return name;
  const repo = resolveRepo(options.repo);
  if (!repo.ok) return repo;
  const cfg = await readConfig(repo.value);
  if (!cfg.ok) return cfg;
  const pre = common(repo.value);
  if (!pre.ok) return pre;
  const graveyard = await checkGraveyard();
  if (!graveyard.ok) return graveyard;
  const dir = join(repo.value.wsRoot, name.value);
  if (protectedWorkspace(repo.value, cfg.value, { name: name.value, dir }))
    return bad(
      `${dir} is kept by [ws].keep in agx.toml or L2 repository config`,
    );
  const result = await withLock<string | TombstonedWorkspace>(
    repo.value,
    `agx ws rm ${options.slug}`,
    async () => {
      const names = await workspaceNames(repo.value);
      if (!names.ok) return names;
      const registered = names.value.includes(name.value);
      if (!registered && !existsSync(dir))
        return bad(`${name.value} is not registered and ${dir} does not exist`);
      if (registered && !existsSync(dir)) {
        const work = await unlanded(
          repo.value,
          cfg.value,
          dir,
          name.value,
          [],
          true,
        );
        if (!work.ok) return work;
        if (work.value.length > 0)
          return bad(
            `${dir} has unlanded changes; land or abandon them first:\n${work.value.map((line) => `  ${line}`).join("\n")}`,
          );
      }
      if (!existsSync(dir)) {
        const listed = await workspaces(repo.value);
        if (!listed.ok) return listed;
        const entry = listed.value.find(
          (workspace) => workspace.name === name.value,
        );
        if (entry?.commit === undefined || realOr(entry.dir) !== realOr(dir))
          return bad("cannot verify missing workspace registration");
        const trunk = await trunkCommit(repo.value, cfg.value);
        if (!trunk.ok) return trunk;
        const forgot = await jjOut(
          ["workspace", "forget", name.value],
          repo.value.backing,
          false,
          {
            name: name.value,
            dir,
            commit: entry.commit,
            trunk: trunk.value,
            rm: true,
          },
        );
        return forgot.ok ? good(dir) : forgot;
      }
      const occupied = busy(realOr(dir));
      if (occupied !== undefined) return bad(occupied);
      const owner = jjWorkspace(dir);
      const brokenMetadata = owner.ok
        ? undefined
        : brokenWorkspaceReason(owner.error);
      if (brokenMetadata !== undefined) {
        const work = registered
          ? await unlanded(repo.value, cfg.value, dir, name.value, [], true)
          : good<string[]>([]);
        if (!work.ok) return work;
        if (work.value.length > 0)
          return bad(
            `${dir} has unlanded changes; land or abandon them first:\n${work.value.join("\n")}`,
          );
        const removed = await removeBrokenWorkspace(
          repo.value,
          cfg.value,
          graveyard.value,
          name.value,
          dir,
          registered,
          options.discardBroken === true,
        );
        return removed.ok ? good(dir) : removed;
      }
      if (
        owner.ok &&
        (owner.value.root !== realOr(dir) ||
          owner.value.backingRoot !== repo.value.backing)
      )
        return bad(`${dir} is not a local workspace of ${repo.value.backing}`);
      const localRevision = await jjOut(
        ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
        dir,
        true,
      );
      if (!localRevision.ok || !registered) {
        const recorded = registered
          ? await unlanded(repo.value, cfg.value, dir, name.value, [], true)
          : good<string[]>([]);
        if (!recorded.ok) return recorded;
        if (recorded.value.length > 0)
          return bad(
            `${dir} has unlanded changes; land or abandon them first:\n${recorded.value.join("\n")}`,
          );
        const work = await unlanded(repo.value, cfg.value, dir, name.value, []);
        if (!work.ok && !msg(work).startsWith(`cannot judge ${dir}:`))
          return work;
        if (!work.ok) {
          const broken = await removeBrokenWorkspace(
            repo.value,
            cfg.value,
            graveyard.value,
            name.value,
            dir,
            registered,
            options.discardBroken === true,
          );
          return broken.ok ? good(dir) : bad(`${msg(broken)}; ${msg(work)}`);
        }
        if (work.value.length > 0)
          return bad(
            `${dir} has unlanded changes; land or abandon them first:\n${work.value.join("\n")}`,
          );
        if (!registered) return forgetAndTombstone(repo.value, name.value, dir);
      }
      const listed = await workspaces(repo.value);
      if (!listed.ok) return listed;
      const current = listed.value.find(
        (workspace) => workspace.name === name.value,
      );
      if (current === undefined)
        return bad(`cannot verify workspace registration: ${name.value}`);
      const records = await agxRecords(repo.value.backing);
      if (!records.ok) return records;
      const trunk = await trunkCommit(repo.value, cfg.value);
      if (!trunk.ok) return trunk;
      const graph = await gcCommitGraph(repo.value, trunk.value);
      if (!graph.ok) return graph;
      const decision = await classifyGc(
        repo.value,
        cfg.value,
        current,
        "ws",
        records.value,
        graph.value,
        undefined,
        trunk.value,
        {
          repo: repo.value.backing,
          dryRun: true,
          includeUnrecorded: true,
          legacy: true,
          graceMinutes: 0,
        },
      );
      if (!decision.collect && decision.reason.startsWith("unlanded change ")) {
        const pending = unlandedWorkspaceChange(current, graph.value);
        return bad(
          `${dir} has unlanded changes; land or abandon them first:\n${pending.changes.map((change) => `  ${change.change} ${change.description}`).join("\n")}`,
        );
      }
      if (!decision.collect)
        return bad(`${dir}: unlanded or protected content: ${decision.reason}`);
      const done = await forgetAndTombstone(repo.value, name.value, dir);
      return done;
    },
  );
  if (!result.ok) return result;
  if (typeof result.value === "string") return good(result.value);
  const tombstoned = await deleteTombstone(
    graveyard.value,
    result.value.tombstone,
  );
  if (!tombstoned.ok)
    process.stderr.write(
      `ws: workspace removed; tombstone cleanup failed: ${msg(tombstoned)}\n`,
    );
  return good(dir);
}

/** A broken checkout is removable only when every trunk-tracked path still matches on disk. */
async function trackedDiskDifferences(
  repo: Repo,
  cfg: Config,
  dir: string,
): Promise<Attempt<string[]>> {
  const trunk = await trunkCommit(repo, cfg);
  if (!trunk.ok) return trunk;
  if (trunk.value === null)
    return bad("cannot compare broken workspace without trunk");
  const files = await jjOut(
    [
      "file",
      "list",
      "-r",
      trunk.value,
      "-T",
      'json(path) ++ "\\t" ++ file_type ++ "\\t" ++ normal_value ++ "\\n"',
    ],
    repo.backing,
    true,
  );
  if (!files.ok) return files;
  const paths: { path: string; type: string; id: string }[] = [];
  for (const line of files.value.split("\n").filter(Boolean)) {
    const [encoded, type, id] = line.split("\t");
    const parsed = jsonOf(z.string().min(1)).safeParse(encoded);
    if (!parsed.success) return bad(`invalid tracked path from trunk: ${line}`);
    if (type === undefined || id === undefined)
      return bad(`invalid trunk entry: ${line}`);
    paths.push({ path: parsed.data, type, id });
  }
  const differing: string[] = [];
  for (const { path, type, id } of paths) {
    const disk = await readDiskFile(join(dir, path));
    if (!disk.ok) return bad(`cannot read tracked file ${path}: ${msg(disk)}`);
    if (disk.value === undefined) {
      differing.push(path);
      continue;
    }
    if (disk.value.symlink || type === "symlink") {
      const content = disk.value.content;
      const hash = createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
      differing.push(
        ...(disk.value.symlink && type === "symlink" && hash === id
          ? []
          : [path]),
      );
      continue;
    }
    const saved = await runStep(
      [
        "jj",
        "--no-pager",
        "--color=never",
        "--ignore-working-copy",
        "file",
        "show",
        "-r",
        trunk.value,
        "--",
        path,
      ],
      repo.backing,
    );
    if (!saved.ok) return bad(`cannot read trunk file ${path}: ${msg(saved)}`);
    if (saved.value.code !== 0)
      return bad(`cannot read trunk file ${path}: ${saved.value.err.trim()}`);
    if (!disk.value.content.equals(saved.value.out)) differing.push(path);
  }
  return good(differing);
}

async function readDiskFile(
  path: string,
): Promise<Attempt<{ content: Buffer; symlink: boolean } | undefined>> {
  const result = await attempt(async () => {
    const info = await lstat(path);
    const symlink = info.isSymbolicLink();
    const content = symlink
      ? Buffer.from(await readlink(path))
      : await readFile(path);
    return { content, symlink };
  });
  if (result.ok) return good(result.value);
  const missing = z
    .object({ code: z.literal("ENOENT") })
    .safeParse(result.error);
  return missing.success ? good(undefined) : bad(msg(result));
}

/** Materialize trunk and the disk tree separately so broken jj metadata is never read. */
async function saveBrokenPatch(
  repo: Repo,
  cfg: Config,
  name: string,
  dir: string,
): Promise<Attempt<string>> {
  const trunk = await trunkCommit(repo, cfg);
  if (!trunk.ok) return trunk;
  if (trunk.value === null) return bad("cannot save patch without trunk");
  const trunkId = trunk.value;
  const files = await jjOut(
    [
      "file",
      "list",
      "-r",
      trunk.value,
      "-T",
      'json(path) ++ "\\t" ++ file_type ++ "\\n"',
    ],
    repo.backing,
    true,
  );
  if (!files.ok) return files;
  const temp = await attempt(() => mkdtemp(join(tmpdir(), "agx-ws-patch-")));
  if (!temp.ok) return bad(`cannot save broken workspace patch: ${msg(temp)}`);
  const result = await buildBrokenPatch(
    repo,
    trunkId,
    files.value,
    name,
    dir,
    temp.value,
  );
  const cleanup = await attempt(() =>
    rm(temp.value, { recursive: true, force: true }),
  );
  if (!cleanup.ok)
    return bad(`cannot clean patch staging directory: ${msg(cleanup)}`);
  return result.ok
    ? good(result.value)
    : bad(`cannot save broken workspace patch: ${msg(result)}`);
}

async function buildBrokenPatch(
  repo: Repo,
  trunk: string,
  files: string,
  name: string,
  dir: string,
  temp: string,
): Promise<Attempt<string>> {
  const before = join(temp, "before");
  const after = join(temp, "after");
  const made = await attempt(() => mkdir(before));
  if (!made.ok) return made;
  for (const line of files.split("\n").filter(Boolean)) {
    const saved = await materializeTrunkFile(repo, trunk, before, line);
    if (!saved.ok) return saved;
  }
  const copied = await attempt(() =>
    cp(dir, after, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (source) =>
        source !== join(dir, ".jj") && source !== join(dir, ".git"),
    }),
  );
  if (!copied.ok) return copied;
  const diff = await runStep(
    ["git", "diff", "--no-index", "--binary", "--", "before", "after"],
    temp,
  );
  if (!diff.ok) return diff;
  if (diff.value.code !== 0 && diff.value.code !== 1)
    return bad(diff.value.err);
  return attempt(async () => {
    const destination = join(stateDir(), "ws-rm");
    await mkdir(destination, { recursive: true });
    const path = join(
      destination,
      `${name}-${Temporal.Now.instant().toString().replaceAll(":", "-")}-${crypto.randomUUID()}.patch`,
    );
    await writeFile(path, diff.value.out, { flag: "wx" });
    return path;
  });
}

async function materializeTrunkFile(
  repo: Repo,
  trunk: string,
  before: string,
  line: string,
): Promise<Attempt<void>> {
  const [encoded, type] = line.split("\t");
  const parsed = jsonOf(z.string().min(1)).safeParse(encoded);
  if (!parsed.success || type === undefined)
    return bad(`invalid trunk entry: ${line}`);
  const target = join(before, parsed.data);
  const gitStore = join(repo.backing, ".jj", "repo", "store");
  const gitTarget =
    type === "symlink"
      ? await attempt(() => readFile(join(gitStore, "git_target"), "utf8"))
      : undefined;
  if (gitTarget !== undefined && !gitTarget.ok) return gitTarget;
  const content = await runStep(
    gitTarget?.ok
      ? [
          "git",
          "--git-dir",
          resolve(gitStore, gitTarget.value.trim()),
          "show",
          `${trunk}:${parsed.data}`,
        ]
      : [
          "jj",
          "--no-pager",
          "--color=never",
          "--ignore-working-copy",
          "file",
          "show",
          "-r",
          trunk,
          "--",
          parsed.data,
        ],
    repo.backing,
  );
  if (!content.ok) return content;
  if (content.value.code !== 0) return bad(content.value.err);
  return attempt(async () => {
    await mkdir(dirname(target), { recursive: true });
    if (type === "symlink")
      return createSymlink(content.value.out.toString(), target);
    await writeFile(target, content.value.out);
    if (type === "executable") await chmod(target, 0o755);
  });
}

async function removeBrokenWorkspace(
  repo: Repo,
  cfg: Config,
  graveyard: Graveyard,
  name: string,
  dir: string,
  registered: boolean,
  discardBroken: boolean,
): Promise<Attempt<void>> {
  const differences = await trackedDiskDifferences(repo, cfg, dir);
  if (!differences.ok) return differences;
  if (differences.value.length > 0 && !discardBroken)
    return bad(
      `${dir} is broken; tracked files differ from ${cfg.trunk}: ${differences.value.join(", ")}; use --discard-broken to save a patch and remove it`,
    );
  const guarded = await removalGuard(repo, dir);
  if (!guarded.ok) return guarded;
  if (Bun.which("rip") === null)
    return bad("rip is not on PATH: mise run install:tools");
  if (discardBroken) {
    const saved = await saveBrokenPatch(repo, cfg, name, dir);
    if (!saved.ok) return saved;
    process.stderr.write(`ws: saved patch ${saved.value}\n`);
  }
  if (registered) {
    const forgotten = await jjOut(
      ["workspace", "forget", name],
      repo.backing,
      false,
    );
    if (!forgotten.ok) return forgotten;
  }
  const moved = await exec(["rip", dir], dirname(dir), {
    GRAVEYARD: graveyard.path,
    RIP_GRAVEYARD: graveyard.path,
  });
  if (!moved.ok) return bad(`rip ${dir}: ${msg(moved)}`);
  return moved.value.code === 0
    ? good(undefined)
    : bad(`rip ${dir} failed: ${moved.value.err.trim()}`);
}

const RunRecord = z.looseObject({
  id: z.string(),
  ticket: z.string().optional(),
  writes: z.array(z.string()).optional(),
  report_path: z.string().nullable().optional(),
  last_progress_path: z.string().nullable().optional(),
  state: z.string(),
  started_at: z.string().optional(),
  cwd: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
  continues: z.string().nullable().optional(),
  end_commit: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  returned: z.boolean().optional(),
  outcome: z.string().nullable().optional(),
  judgment: z.looseObject({ decision: z.string() }).nullable().optional(),
});
export type RunRecord = z.output<typeof RunRecord>;

/** Fail closed before effects; content equality and elapsed time are not judgments. */
function runRemovalReason(
  dir: string,
  records: RunRecord[],
): string | undefined {
  const lineage = lineageOf(records, realOr(dir));
  const live = lineage.find((r) => !TERMINAL_STATES.has(r.state));
  if (live !== undefined)
    return `live or continuing run ${live.id} (${live.state})`;
  // Continuations supersede their parents. Timestamps order unrelated runs, irrespective
  // of the order returned by the inventory. Missing/invalid dates retain all candidates.
  const parents = new Set(lineage.map((r) => r.continues));
  const leaves = lineage.filter((r) => !parents.has(r.id));
  if (lineage.length > 0 && leaves.length === 0)
    return "cyclic run lineage; keep";
  const dates = leaves.map((r) =>
    fromThrowable(
      () => Temporal.Instant.from(r.started_at ?? "").epochMilliseconds,
    )().unwrapOr(Number.NaN),
  );
  const latest = dates.every((date) => Number.isFinite(date))
    ? leaves.filter((_, i) => dates[i] === Math.max(...dates))
    : leaves;
  for (const run of latest) {
    const decision = run.judgment?.decision;
    if (decision === "reject") continue;
    if (decision !== "accept") return `run ${run.id} is unjudged; keep`;
  }
  return undefined;
}

async function removalGuard(
  repo: Repo,
  dir: string,
  forgottenCommit?: string,
): Promise<Attempt<void>> {
  const records = await agxRecords(repo.backing);
  if (!records.ok) return records;
  const reason = runRemovalReason(dir, records.value);
  if (reason !== undefined) return bad(reason);
  if (
    !lineageOf(records.value, realOr(dir)).some(
      (r) => r.judgment?.decision === "accept",
    )
  )
    return good(undefined);
  const cfg = await readConfig(repo);
  if (!cfg.ok) return cfg;
  const trunk = await trunkCommit(repo, cfg.value);
  if (!trunk.ok) return trunk;
  if (trunk.value === null)
    return bad("cannot judge accepted work without trunk");
  const tip =
    forgottenCommit === undefined
      ? await jjOut(
          ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
          dir,
          true,
        )
      : good(forgottenCommit);
  const resolvedTip = tip.ok
    ? tip
    : await jjOut(
        ["log", "--no-graph", "-r", `${basename(dir)}@`, "-T", "commit_id"],
        repo.backing,
        true,
      );
  if (!resolvedTip.ok) return resolvedTip;
  const work = await outstanding(repo, resolvedTip.value.trim(), trunk.value);
  if (!work.ok) return work;
  return work.value.differing.length === 0
    ? good(undefined)
    : bad(
        `accepted work has unlanded paths: ${work.value.differing.join(", ")}; land or reject it first`,
      );
}

async function agxRecords(cwd: string): Promise<Attempt<RunRecord[]>> {
  const agx = await resolveAgxBinary();
  if (agx === "agx" && Bun.which("agx") === null)
    return bad("agx is not on PATH: mise run deps");
  const ran = await exec([agx, "worker", "ls", "--all", "--json"], cwd);
  if (!ran.ok) return bad(`agx worker ls --json: ${msg(ran)}`);
  if (ran.value.code !== 0)
    return bad(
      `agx worker ls --json failed (exit ${ran.value.code}): ${ran.value.err.trim()}`,
    );
  const json = jsonOf(z.array(RunRecord)).safeParse(ran.value.out);
  return json.success
    ? good(json.data)
    : bad(`agx worker ls --json: unexpected output: ${json.error.message}`);
}

const realCache = new Map<string, string>();
function realOr(path: string): string {
  const cached = realCache.get(path);
  if (cached !== undefined) return cached;
  const real = fromThrowable(() => realpathSync(path))();
  const resolved = real.isOk() ? real.value : path;
  realCache.set(path, resolved);
  return resolved;
}

function within(path: string | null | undefined, dir: string): boolean {
  if (path === null || path === undefined || path === "") return false;
  const real = realOr(path);
  return real === dir || real.startsWith(dir + sep);
}

/** Records that touched `dir`, closed over `continues` links in both directions. */
export function lineageOf(records: RunRecord[], dir: string): RunRecord[] {
  const links = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    links.set(a, [...(links.get(a) ?? []), b]);
  };
  for (const r of records) {
    if (r.continues === null || r.continues === undefined) continue;
    link(r.id, r.continues);
    link(r.continues, r.id);
  }
  const seen = new Set<string>();
  const pending = records
    .filter((r) => within(r.workspace, dir) || within(r.cwd, dir))
    .map((r) => r.id);
  for (const id of pending) {
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(links.get(id) ?? []));
  }
  return records.filter((r) => seen.has(r.id));
}

export type GcOptions = {
  repo: string;
  dryRun: boolean;
  includeUnrecorded: boolean;
  graceMinutes?: number;
  inventorySeconds?: number;
  inventoryBudgetSeconds?: number;
  legacy?: boolean;
  abandoned?: boolean;
  /** Nested all-repository inventories retain their historical main-row omission. */
  includeMain?: boolean;
};

type Workspace = {
  name: string;
  dir: string;
  target: string;
  commit?: string;
  change: string;
  age: string;
  rootMissing?: boolean;
  recordError?: string;
  main: boolean;
};
type JjCommit = {
  id: string;
  parents: string[];
  change: string;
  description: string;
  empty: boolean;
  trunk: boolean;
  remote: boolean;
  remoteBookmarks: string[];
  filesIncluded: boolean;
  files: Map<string, JjTreeFile>;
  changedPaths: string[];
};
type JjTreeFile = {
  object: string;
  type: "file" | "symlink" | "tree" | "git-submodule" | "conflict";
  executable: boolean;
};
const JjTreeFileSchema = z.object({
  path: z.string().min(1),
  object: z.string(),
  type: z.enum(["file", "symlink", "tree", "git-submodule", "conflict"]),
  executable: z.boolean(),
});
const WorkspaceRowSchema = z.object({
  name: z.string().min(1),
  root: z.string().nullable(),
  target: z.string().min(1),
  change: z.string(),
  age: z.string(),
});
const JjCommitSchema = z.object({
  id: z.string().min(1),
  parents: z.string(),
  change: z.string(),
  description: z.string(),
  empty: z.boolean(),
  trunk: z.boolean(),
  remote: z.boolean(),
  remoteBookmarks: z.string(),
  filesIncluded: z.boolean(),
  files: z.string(),
  changedPaths: z.string(),
});
type Classification = {
  verdict: string;
  change: string;
  age: string;
  reason: string;
  collect: boolean;
  abandon?: boolean;
};

const gcGraceMinutes = (options: GcOptions): number =>
  options.graceMinutes ?? 30;
const gcInventoryTimeoutMs = (options: GcOptions): number =>
  (options.inventorySeconds ?? 10) * 1000;
const MAX_PRESERVED_RESULT_BYTES = 16 * 1024 * 1024;

function landState(ws: Workspace): string | undefined {
  const root = realOr(join(stateDir(), "land"));
  const dir = realOr(ws.dir);
  const state = dirname(dir);
  return basename(dir) === "workspace" && dirname(state) === root
    ? state
    : undefined;
}

async function landLockStatus(
  state: string,
): Promise<{ held: boolean; reason: string }> {
  const lock = join(state, "land.lock");
  const present = await attempt(() => stat(lock));
  if (!present.ok) {
    const error = z
      .object({ code: z.literal("ENOENT") })
      .safeParse(present.error);
    return error.success
      ? { held: false, reason: "no live land lock" }
      : { held: true, reason: `land lock state is uncertain: ${msg(present)}` };
  }
  const owner = await attempt(() => Bun.file(join(lock, "owner.json")).text());
  if (!owner.ok)
    return {
      held: true,
      reason: `land lock ownership is uncertain: ${msg(owner)}`,
    };
  const holder = jsonOf(
    z.object({
      pid: z.number().int().positive(),
      host: z.string(),
      what: z.string().optional(),
    }),
  ).safeParse(owner.value);
  if (!holder.success)
    return {
      held: true,
      reason: "land lock ownership is uncertain: invalid owner.json",
    };
  const name = holder.data.what ?? "land process";
  const identity = `${name} PID ${holder.data.pid} on ${holder.data.host}`;
  return holder.data.host !== hostname() || pidAlive(holder.data.pid)
    ? { held: true, reason: `land lock is held by ${identity}` }
    : { held: false, reason: "land lock has no live owner" };
}

/** Enumerate workspace name, path and target in one jj call. */
async function workspaces(
  repo: Repo,
  includeMain = false,
): Promise<Attempt<Workspace[]>> {
  const listed = await jjOut(
    [
      "-R",
      repo.backing,
      "workspace",
      "list",
      "-T",
      'json({"name" => self.name(), "root" => self.root(), "target" => self.target().commit_id(), "change" => self.target().change_id().short(12), "age" => self.target().committer().timestamp().ago()}) ++ "\\n"',
    ],
    repo.backing,
    true,
  );
  if (!listed.ok) return listed;
  const found: Workspace[] = [];
  const lines = listed.value.trim().split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const parsed = jsonOf(WorkspaceRowSchema).safeParse(line);
    if (!parsed.success) {
      const name = "<invalid-workspace-" + String(index + 1) + ">";
      found.push({
        name,
        dir: join(repo.wsRoot, name),
        target: "",
        change: "?",
        age: "?",
        recordError:
          "invalid jj workspace list record " +
          String(index + 1) +
          ": " +
          parsed.error.message,
        main: false,
      });
      continue;
    }
    const row = parsed.data;
    const dir =
      row.root === null
        ? join(repo.wsRoot, row.name)
        : resolve(repo.backing, row.root);
    const main = row.root !== null && realOr(dir) === realOr(repo.backing);
    found.push({
      name: row.name,
      dir,
      target: row.target,
      commit: row.target,
      change: row.change,
      age: row.age,
      rootMissing: row.root === null,
      main,
    });
  }
  return good(
    includeMain ? found : found.filter((workspace) => !workspace.main),
  );
}

/** One aggregate revset supplies ancestry, reachability, and tracked paths for all workspaces. */
function parseJjTreeFiles(encoded: string): Attempt<Map<string, JjTreeFile>> {
  const files = new Map<string, JjTreeFile>();
  for (const fileRow of encoded.split("\0").filter(Boolean)) {
    const parsed = jsonOf(JjTreeFileSchema).safeParse(fileRow);
    if (!parsed.success)
      return bad(
        "invalid aggregate workspace file row: " + parsed.error.message,
      );
    const { path, ...file } = parsed.data;
    files.set(path, file);
  }
  return good(files);
}

type GcTrace = {
  inventoryMs: number;
  inventoryCount: number;
  comparisonMs: number;
};

async function gcCommitGraph(
  repo: Repo,
  trunk: string | null,
  trace?: (step: string, ms: number) => void,
): Promise<Attempt<Map<string, JjCommit>>> {
  const trunkTest =
    trunk === null
      ? "false"
      : "self.contained_in(" + JSON.stringify("::(" + trunk + ")") + ")";
  const trunkHeadTest =
    trunk === null
      ? "false"
      : "self.contained_in(" + JSON.stringify(trunk) + ")";
  const revisions =
    trunk === null ? "::working_copies()" : `::working_copies() | (${trunk})`;
  const treeOwnerTest = `self.working_copies().len() > 0 || (${trunkHeadTest})`;
  const changedPathsTest = `if(!empty && !(${trunkTest}) && !self.contained_in("::remote_bookmarks()"), self.diff().files().map(|file| file.path()).join("\\0"), "")`;
  const template =
    'json({"id" => commit_id, "parents" => stringify(parents.map(|parent| parent.commit_id()).join(",")), "change" => change_id.short(12), "description" => description.first_line(), "empty" => empty, "trunk" => ' +
    trunkTest +
    ', "remote" => self.contained_in("::remote_bookmarks()"), "remoteBookmarks" => stringify(self.remote_bookmarks().map(|bookmark| if(bookmark.remote(), stringify(bookmark.name()) ++ "@" ++ stringify(bookmark.remote()), stringify(bookmark.name()))).join(",")), "filesIncluded" => ' +
    treeOwnerTest +
    ', "files" => stringify(if(' +
    treeOwnerTest +
    ', self.files().map(|file| json({"path" => file.path(), "object" => if(file.normal_value(), stringify(file.normal_value()), ""), "type" => file.file_type(), "executable" => file.executable()})).join("\\0"), "")), "changedPaths" => stringify(' +
    changedPathsTest +
    ')}) ++ "\\n"';
  const graphStart = performance.now();
  const output = await jjOut(
    ["-R", repo.backing, "log", "--no-graph", "-r", revisions, "-T", template],
    repo.backing,
    true,
  );
  trace?.("aggregate jj graph generation", performance.now() - graphStart);
  if (!output.ok) return output;
  const parseStart = performance.now();
  const commits = new Map<string, JjCommit>();
  for (const line of output.value.trim().split("\n").filter(Boolean)) {
    const parsed = jsonOf(JjCommitSchema).safeParse(line);
    if (!parsed.success)
      return bad(
        "invalid aggregate workspace commit row: " + parsed.error.message,
      );
    const row = parsed.data;
    const files = parseJjTreeFiles(row.files);
    if (!files.ok) return files;
    commits.set(row.id, {
      ...row,
      parents: row.parents.split(",").filter(Boolean),
      remoteBookmarks: row.remoteBookmarks.split(",").filter(Boolean),
      files: files.value,
      changedPaths: row.changedPaths.split("\0").filter(Boolean),
    });
  }
  trace?.("graph parsing", performance.now() - parseStart);
  return good(commits);
}

async function workspaceCommitReachable(
  repo: Repo,
  commit: string,
  trunk: string | null,
): Promise<Attempt<boolean>> {
  const reachableFrom = [
    ...(trunk === null ? [] : ["::(" + trunk + ")"]),
    "::remote_bookmarks()",
  ];
  const found = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      commit + " & (" + reachableFrom.join(" | ") + ")",
      "-T",
      "commit_id",
    ],
    repo.backing,
    true,
  );
  if (!found.ok) return found;
  return good(found.value.trim() === commit);
}

async function verifyMissingWorkspaceForget(
  repo: Repo,
  missing: MissingWorkspaceForget,
): Promise<Attempt<void>> {
  const directory = await attempt(() => lstat(missing.dir));
  if (directory.ok)
    return bad("workspace directory reappeared before forgetting");
  if (
    !z.object({ code: z.literal("ENOENT") }).safeParse(directory.error).success
  )
    return bad("cannot confirm missing workspace directory: " + msg(directory));

  const current = await workspaces(repo);
  if (!current.ok) return current;
  const record = current.value.find(
    (workspace) => workspace.name === missing.name,
  );
  if (
    record === undefined ||
    realOr(record.dir) !== realOr(missing.dir) ||
    record.commit !== missing.commit
  )
    return bad("workspace registration changed before forgetting");

  if (missing.rm === true) {
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    if (
      protectedWorkspace(repo, cfg.value, {
        name: missing.name,
        dir: missing.dir,
      })
    )
      return bad("workspace is kept by [ws].keep");
    const guard = await removalGuard(repo, missing.dir, missing.commit);
    if (!guard.ok) return guard;
    const work = await unlanded(repo, cfg.value, missing.dir, missing.name, []);
    if (!work.ok) return work;
    return work.value.length === 0
      ? good(undefined)
      : bad(`workspace has unlanded changes: ${work.value.join(", ")}`);
  }

  const reachable = await workspaceCommitReachable(
    repo,
    missing.commit,
    missing.trunk,
  );
  if (!reachable.ok) return reachable;
  return reachable.value || missing.owner === "land"
    ? good(undefined)
    : bad("workspace commit is not reachable from trunk or a remote bookmark");
}

function keepEntries(
  repo: Repo,
  cfg: Config,
  ws: Pick<Workspace, "name" | "dir">,
): string[] {
  return cfg.keep.filter((entry) => {
    if (entry === ws.name) return true;
    const path = entry.startsWith("~/")
      ? join(homedir(), entry.slice(2))
      : resolve(repo.backing, entry);
    return realOr(path) === realOr(ws.dir);
  });
}

function protectedWorkspace(
  repo: Repo,
  cfg: Config,
  ws: Pick<Workspace, "name" | "dir">,
): boolean {
  return keepEntries(repo, cfg, ws).length > 0;
}

export type AdoptOptions = {
  path?: string | undefined;
  repo?: string | undefined;
  slug?: string | undefined;
  all: boolean;
  dryRun: boolean;
  includeKept: boolean;
  fixNames?: boolean;
};

/** Strip layout markers before normalization; run-id suffixes remain part of the slug. */
function adoptionSlug(repo: Repo, dir: string): string {
  let name = basename(dir).replace(/^ws_/u, "");
  for (const prefix of [
    `${repo.name}-arm-`,
    `${repo.name}-ws-`,
    process.env.AGX_WS_LEGACY_PREFIX ?? "",
  ].filter((candidate) => candidate.length > 0)) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  return projectSlug(name);
}

/** Re-home the snapshotted change; jj creates all pointers and path registrations. */
async function moveWorkspace(
  repo: Repo,
  ws: Workspace,
  target: string,
  name: string,
  graveyard: Graveyard,
): Promise<Attempt<void>> {
  const permitted = await removalGuard(repo, ws.dir);
  if (!permitted.ok) return permitted;
  const occupied = busy(realOr(ws.dir));
  if (occupied !== undefined) return bad(occupied);
  const change = await jjOut(
    ["log", "--no-graph", "-r", "@", "-T", "change_id"],
    ws.dir,
    false,
  );
  if (!change.ok) return change;
  const before = await jjOut(["diff", "--git"], ws.dir, true);
  if (!before.ok) return before;
  const rootInfo = await attempt(() => lstat(repo.wsRoot));
  if (
    !rootInfo.ok &&
    !z.object({ code: z.literal("ENOENT") }).safeParse(rootInfo.error).success
  )
    return bad(`cannot inspect ${repo.wsRoot}: ${msg(rootInfo)}`);
  const hadRoot = rootInfo.ok;
  await mkdir(repo.wsRoot, { recursive: true });
  // Reserve even empty targets: jj itself accepts an existing empty directory.
  const reserved = await attempt(() => mkdir(target));
  if (!reserved.ok) {
    if (!hadRoot) await rmdir(repo.wsRoot);
    return bad(`${target}: cannot reserve destination: ${msg(reserved)}`);
  }
  const rollback = async (failure: unknown): Promise<Attempt<void>> => {
    const names = await workspaceNames(repo);
    if (!names.ok)
      return bad(`${errorMessage(failure)}; rollback failed: ${msg(names)}`);
    if (names.value.includes(name)) {
      const forgot = await jjOut(
        ["workspace", "forget", name],
        repo.backing,
        false,
      );
      if (!forgot.ok)
        return bad(`${errorMessage(failure)}; rollback failed: ${msg(forgot)}`);
    }
    const allowed = await removalGuard(repo, target);
    if (!allowed.ok)
      return bad(
        `${errorMessage(failure)}; rollback retained workspace: ${msg(allowed)}`,
      );
    const removed = await attempt(async () => {
      await rm(target, { recursive: true, force: true });
      if (!hadRoot) await rmdir(repo.wsRoot);
    });
    return bad(
      `${errorMessage(failure)}; ${removed.ok ? "new workspace removed; old workspace retained" : `rollback failed: ${msg(removed)}`}`,
    );
  };
  const moved = await attempt(async (): Promise<Attempt<void>> => {
    const made = await jjOut(
      ["workspace", "add", "--name", name, "--sparse-patterns", "full", target],
      repo.backing,
      false,
    );
    if (!made.ok) return made;
    const edited = await jjOut(["edit", change.value.trim()], target, false);
    if (!edited.ok) return edited;
    const status = await jjOut(["status"], target, false);
    if (!status.ok) return status;
    const after = await jjOut(
      ["log", "--no-graph", "-r", "@", "-T", "change_id"],
      target,
      true,
    );
    if (!after.ok) return after;
    const diff = await jjOut(["diff", "--git"], target, true);
    if (!diff.ok) return diff;
    if (after.value !== change.value || diff.value !== before.value)
      return bad("change id or diff mismatch");
    const active = busy(realOr(ws.dir));
    if (active !== undefined) return bad(active);
    // Remember precisely the forget operation so a burial failure can restore the old
    // registration without rewinding unrelated operations in this shared store.
    const burialTip = await jjOut(
      ["log", "--no-graph", "-r", `${ws.name}@`, "-T", "commit_id"],
      repo.backing,
      true,
    );
    if (!burialTip.ok) return burialTip;
    const forgot = await jjOut(
      ["workspace", "forget", ws.name],
      repo.backing,
      false,
    );
    if (!forgot.ok) return forgot;
    const operation = await jjOut(
      ["op", "log", "--no-graph", "-n", "1", "-T", "id"],
      repo.backing,
      true,
    );
    const buried = operation.ok
      ? await bury(graveyard, ws.dir, burialTip.value.trim())
      : operation;
    if (buried.ok) return good(undefined);
    const restored = operation.ok
      ? await jjOut(
          ["op", "revert", operation.value.trim()],
          repo.backing,
          true,
        )
      : bad("cannot identify forget operation");
    return bad(
      `${msg(buried)}${restored.ok ? "" : `; old registration recovery failed: ${msg(restored)}`}`,
    );
  });
  const result = moved.ok ? moved.value : bad(msg(moved));
  return result.ok ? result : rollback(result.error);
}

const adoptLine = (dir: string, target: string, verdict: string): string =>
  [dir, target, verdict]
    .map((field) => field.replaceAll("\t", "\\t").replaceAll("\n", "\\n"))
    .join("\t");

/** Compare raw bytes (including binary files) without opening or snapshotting the orphan. */
async function orphanFileDifference(
  dir: string,
  revision: string,
  path: string,
): Promise<string | undefined> {
  const disk = join(dir, path);
  const info = await attempt(() => lstat(disk));
  if (!info.ok) {
    const missing = z
      .object({ code: z.literal("ENOENT") })
      .safeParse(info.error);
    return missing.success ? `yes: missing ${path}` : `unknown: ${msg(info)}`;
  }
  if (!info.value.isFile() && !info.value.isSymbolicLink())
    return `yes: file type differs at ${path}`;
  const compared = await attempt(async () => {
    const ran = await runStep(
      [
        "jj",
        "--ignore-working-copy",
        "--no-pager",
        "file",
        "show",
        "-r",
        revision,
        rootFileFileset(path),
      ],
      dir,
    );
    if (!ran.ok) return `unknown: ${msg(ran)}`;
    const { out: expected, err, code } = ran.value;
    if (code !== 0) return `unknown: ${err.trim()}`;
    const actual = info.value.isSymbolicLink()
      ? Buffer.from(await readlink(disk))
      : Buffer.from(await Bun.file(disk).arrayBuffer());
    return actual.equals(Buffer.from(expected))
      ? undefined
      : `yes: bytes differ at ${path}`;
  });
  return compared.ok ? compared.value : `unknown: ${msg(compared)}`;
}

/** File content/path comparison, including extra files; .jj/.git metadata is excluded. */
async function orphanDifference(
  repo: Repo,
  dir: string,
  trunk: string,
): Promise<string> {
  const listed = await jjOut(
    ["file", "list", "-r", trunk, "-T", 'json(path) ++ "\\n"'],
    repo.backing,
    true,
  );
  if (!listed.ok) return `unknown: ${msg(listed)}`;
  const paths: string[] = [];
  for (const line of listed.value.split("\n").filter(Boolean)) {
    const path = jsonOf(z.string()).safeParse(line);
    if (!path.success) return "unknown: invalid trunk file list";
    paths.push(path.data);
    const difference = await orphanFileDifference(dir, trunk, path.data);
    if (difference !== undefined) return difference;
  }
  return orphanExtraFiles(dir, new Set(paths));
}

/** Compare tracked disk bytes with the saved working-copy tree without taking a jj snapshot. */
async function workingCopyDifference(dir: string): Promise<string | undefined> {
  const listed = await jjOut(
    ["file", "list", "-r", "@", "-T", 'json(path) ++ "\\n"'],
    dir,
    true,
  );
  if (!listed.ok)
    return `unknown: cannot list working-copy files: ${msg(listed)}`;
  for (const line of listed.value.split("\n").filter(Boolean)) {
    const path = jsonOf(z.string()).safeParse(line);
    if (!path.success) return "unknown: invalid working-copy file list";
    const difference = await orphanFileDifference(dir, "@", path.data);
    if (difference !== undefined) return difference;
  }
  return undefined;
}

async function orphanExtraFiles(
  dir: string,
  known: Set<string>,
): Promise<string> {
  const pending = [dir];
  let visited = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) break;
    if (++visited > 100_000)
      return "unknown: file inventory exceeds 100000 entries";
    const info = await attempt(() => lstat(path));
    if (!info.ok) return `unknown: ${msg(info)}`;
    if (!info.value.isDirectory() && !known.has(relative(dir, path)))
      return `yes: extra file ${relative(dir, path)}`;
    if (!info.value.isDirectory()) continue;
    const entries = await attempt(() => readdir(path));
    if (!entries.ok) return `unknown: ${msg(entries)}`;
    pending.push(
      ...entries.value
        .filter((name) => name !== ".jj" && name !== ".git")
        .map((name) => join(path, name)),
    );
  }
  return "no (file bytes and paths; excludes .jj/.git metadata)";
}

/** Discover legacy sibling/nested leftovers without following directory symlinks. */
async function orphanLines(
  repo: Repo,
  cfg: Config,
  registered: Workspace[],
): Promise<Attempt<string[]>> {
  const siblings = await attempt(() =>
    readdir(repo.parent, { withFileTypes: true }),
  );
  if (!siblings.ok) return siblings;
  const roots = siblings.value
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith(`${repo.name}-arm-`) ||
          entry.name.startsWith(`${repo.name}-ws-`) ||
          (process.env.AGX_WS_LEGACY_PREFIX !== undefined &&
            process.env.AGX_WS_LEGACY_PREFIX.length > 0 &&
            entry.name.startsWith(process.env.AGX_WS_LEGACY_PREFIX) &&
            (() => {
              const owner = jjWorkspace(join(repo.parent, entry.name));
              return owner.ok && owner.value.backingRoot === repo.backing;
            })()) ||
          entry.name === `${repo.name}-ws`),
    )
    .map((entry) => join(repo.parent, entry.name));
  const candidates = roots.filter(
    (path) => basename(path) !== `${repo.name}-ws`,
  );
  for (const root of roots.filter(
    (path) => basename(path) === `${repo.name}-ws`,
  )) {
    const nested = await attempt(() => readdir(root, { withFileTypes: true }));
    if (!nested.ok) return nested;
    candidates.push(
      ...nested.value
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name)),
    );
  }
  const seen = new Set(registered.map((ws) => realOr(ws.dir)));
  const lines: string[] = [];
  for (const dir of candidates) {
    if (seen.has(realOr(dir))) continue;
    const target = join(repo.wsRoot, `ws_${adoptionSlug(repo, dir)}`);
    const difference = await orphanDifference(repo, dir, cfg.trunk);
    lines.push(
      adoptLine(
        dir,
        target,
        `orphan: files differ from ${cfg.trunk}: ${difference}; not registered in jj workspace list; owner decision required; never adopted`,
      ),
    );
  }
  return good(lines);
}

async function adoptRow(
  repo: Repo,
  cfg: Config,
  ws: Workspace,
  options: AdoptOptions,
  reserved: Set<string>,
  targets: Set<string>,
  graveyard?: Graveyard,
): Promise<{ line: string; failed: boolean }> {
  const name = `ws_${options.slug === undefined ? adoptionSlug(repo, ws.dir) : projectSlug(options.slug)}`;
  const target = join(repo.wsRoot, name);
  const kept = keepEntries(repo, cfg, ws);
  const present = await attempt(() => lstat(target));
  const source = jjWorkspace(ws.dir);
  let reason: string | undefined;
  if (realOr(ws.dir) === realOr(target))
    reason = "already at target workspace path";
  else if (!source.ok) reason = msg(source);
  else if (
    source.value.root !== realOr(ws.dir) ||
    source.value.backingRoot !== repo.backing
  )
    reason = "workspace metadata does not match repository registration";
  else if (kept.length > 0 && !options.includeKept)
    reason = `kept by [ws].keep: ${kept.map((entry) => JSON.stringify(entry)).join(", ")}; pass --include-kept`;
  else if (present.ok || targets.has(target))
    reason = "target already exists or is reserved";
  else if (
    !z.object({ code: z.literal("ENOENT") }).safeParse(present.error).success
  )
    reason = `cannot inspect target: ${msg(present)}`;
  else if (reserved.has(name))
    reason = `jj workspace ${name} is already registered`;
  else reason = busy(realOr(ws.dir));
  if (reason === undefined) {
    targets.add(target);
    reserved.add(name);
  }
  if (reason === undefined && !options.dryRun && graveyard !== undefined) {
    const moved = await moveWorkspace(repo, ws, target, name, graveyard);
    if (!moved.ok) reason = msg(moved);
  }
  const verdict = options.dryRun ? "would-adopt" : "adopted";
  const update =
    kept.length === 0
      ? ""
      : `; remove the matching entry from agx.toml [ws].keep or L2 [ws].keep: ${kept.map((entry) => JSON.stringify(entry)).join(", ")}`;
  return {
    line: adoptLine(
      ws.dir,
      target,
      `${reason === undefined ? verdict : `refused: ${reason}`}${update}`,
    ),
    failed: reason !== undefined,
  };
}

/** Dry runs never lock, snapshot, or write, including when inspecting a real repository. */
export async function adopt(
  options: AdoptOptions,
): Promise<Attempt<{ lines: string[]; failed: string[] }>> {
  const batch = options.all || options.fixNames === true;
  if (options.all && options.fixNames === true)
    return bad("--all cannot be combined with --fix-names");
  if (batch && (options.path !== undefined || options.slug !== undefined))
    return bad("--all/--fix-names cannot be combined with a path or --slug");
  if (batch && options.repo === undefined)
    return bad("--all/--fix-names requires --repo");
  if (!batch && options.path === undefined)
    return bad("provide a workspace path or --all --repo <R>");
  const resolved = resolveRepo(options.repo ?? options.path ?? process.cwd());
  if (!resolved.ok) return resolved;
  const repo = resolved.value;
  const initialConfig = await readConfig(repo);
  if (!initialConfig.ok) return initialConfig;
  const run = async (): Promise<
    Attempt<{ lines: string[]; failed: string[] }>
  > => {
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    const listed = await workspaces(repo);
    if (!listed.ok) return listed;
    const selected = listed.value.filter((ws) => {
      if (options.fixNames === true)
        return (
          within(ws.dir, realOr(repo.wsRoot)) &&
          basename(ws.dir).startsWith(`ws_${repo.name}-arm-`)
        );
      if (options.all) return !within(ws.dir, realOr(repo.wsRoot));
      return realOr(ws.dir) === realOr(resolve(options.path ?? ""));
    });
    if (!batch && selected.length !== 1)
      return bad(
        "path must be the root of a registered non-primary workspace of this repository",
      );
    const names = await workspaceNames(repo);
    if (!names.ok) return names;
    const reserved = new Set(names.value);
    const targets = new Set<string>();
    const graveyard = options.dryRun ? undefined : await checkGraveyard();
    if (graveyard !== undefined && !graveyard.ok) return graveyard;
    const rows = [];
    for (const ws of selected)
      rows.push(
        await adoptRow(
          repo,
          cfg.value,
          ws,
          options,
          reserved,
          targets,
          graveyard?.value,
        ),
      );
    const lines = rows.map((row) => row.line);
    const failed = rows
      .filter((row) => row.failed)
      .map((row) => row.line.split("\t")[0] ?? "?");
    const orphans =
      options.dryRun && batch
        ? await orphanLines(repo, cfg.value, listed.value)
        : good([]);
    if (!orphans.ok) return orphans;
    lines.push(...orphans.value);
    return good({ lines, failed });
  };
  if (options.dryRun) return run();
  const pre = common(repo);
  return pre.ok ? withLock(repo, "agx ws adopt", run) : pre;
}

/** Freeze one real trunk commit for the whole repo; root is not a usable integration branch. */
async function trunkCommit(
  repo: Repo,
  cfg: Config,
): Promise<Attempt<string | null>> {
  const resolved = await resolveTrunk(repo, cfg);
  return resolved.ok ? good(resolved.value.commit) : resolved;
}

async function resolveTrunk(
  repo: Repo,
  cfg: Config,
): Promise<Attempt<{ commit: string | null; source: string }>> {
  const out = await jjOut(
    ["log", "--no-graph", "-r", cfg.trunk, "-T", 'commit_id ++ "\\n"'],
    repo.backing,
    true,
  );
  if (!out.ok) return out;
  const ids = out.value.trim().split("\n").filter(Boolean);
  if (ids.length !== 1)
    return bad(`trunk ${cfg.trunk} must resolve to exactly one commit`);
  const commit = ids[0] ?? null;
  const source = cfg.trunkConfigured
    ? `${CONFIG_FILE} [ws].trunk = ${JSON.stringify(cfg.trunk)}`
    : "jj trunk()";
  if (commit !== null && !/^0+$/u.test(commit)) return good({ commit, source });
  if (cfg.trunkConfigured)
    return good({ commit: null, source: `${source} resolves to root` });
  const bookmarks = await jjOut(
    ["bookmark", "list", "-T", 'if(!remote, name ++ "\\n")'],
    repo.backing,
    true,
  );
  if (!bookmarks.ok) return bookmarks;
  const local = new Set(bookmarks.value.trim().split("\n"));
  const candidates = ["alpha", "main", "master", "trunk"].filter((name) =>
    local.has(name),
  );
  if (candidates.length !== 1)
    return good({
      commit: null,
      source: `jj trunk() resolves to root; ${candidates.length} local candidate bookmarks${candidates.length > 0 ? ` (${candidates.join(", ")})` : ""}; missing trunk setting; ${trunkSettingHint(candidates[0] ?? "alpha")}`,
    });
  const bookmark = candidates[0] ?? "alpha";
  const fallback = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      `bookmarks(exact:${JSON.stringify(bookmark)})`,
      "-T",
      'commit_id ++ "\\n"',
    ],
    repo.backing,
    true,
  );
  if (!fallback.ok) return fallback;
  const targets = fallback.value.trim().split("\n").filter(Boolean);
  if (targets.length !== 1 || /^0+$/u.test(targets[0] ?? ""))
    return good({
      commit: null,
      source: `local bookmark ${bookmark} has no single real commit; ${trunkSettingHint(bookmark)}`,
    });
  return good({
    commit: targets[0] ?? null,
    source: `local bookmark ${bookmark} (jj trunk() resolves to root)`,
  });
}

/** Zero-context edits anchored to the same base. Unsupported formats fail closed.
 * New-line offsets are deliberately excluded: unrelated earlier trunk edits shift them.
 */
function patchBlockEdits(block: string): Set<string> | null {
  const edits = new Set<string>();
  const lines = block.split("\n");
  const file = lines[0];
  if (
    file === undefined ||
    lines.some((line) =>
      /^(?:old mode|new mode|new file|deleted file|rename |copy |Binary|GIT binary)/u.test(
        line,
      ),
    )
  )
    return null;
  let key: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (key !== undefined) edits.add(JSON.stringify([file, key, body]));
  };
  for (const line of lines.slice(1)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
    if (header !== null) {
      flush();
      key = `${header[1]},${header[2] ?? "1"}`;
      body = [];
    } else if (key !== undefined && line !== "") body.push(line);
  }
  flush();
  if (key === undefined) return null;
  return edits;
}

function patchEdits(diff: string): Set<string> | null {
  const blocks = diff
    .split(/^diff --git /mu)
    .filter(Boolean)
    .map((block) => patchBlockEdits(block));
  if (blocks.some((block) => block === null)) return null;
  return new Set(
    blocks.flatMap((block) => (block === null ? [] : Array.from(block))),
  );
}

function patchesByFile(diff: string): Map<string, string> {
  return new Map(
    diff
      .split(/^diff --git /mu)
      .filter(Boolean)
      .map((block) => {
        const header = block.split("\n", 1).at(0);
        if (header === undefined) return ["", `diff --git ${block}`];
        return [header, `diff --git ${block}`];
      }),
  );
}

type ContentResult = {
  differing: string[];
  total: number;
  consumed: string[];
  integratedAt?: string;
  trunkDifferences?: string[];
  pushed?: string[];
};

/** Release notes are evidence: a missing changeset alone never proves that it landed. */
async function consumedChangesets(
  repo: Repo,
  tip: string,
  trunk: string,
  changed: string[],
): Promise<Attempt<string[]>> {
  const consumed: string[] = [];
  for (const path of changed) {
    const tool = /^tools\/([^/]+)\/\.changes\/[^/]+\.md$/u.exec(path)?.[1];
    if (tool === undefined) continue;
    const present = await jjOut(
      ["file", "list", "-r", trunk, rootFileFileset(path)],
      repo.backing,
      true,
    );
    if (!present.ok) return present;
    if (present.value.trim() !== "") continue;
    const note = await jjOut(
      ["file", "show", "-r", tip, rootFileFileset(path)],
      repo.backing,
      true,
    );
    if (!note.ok) continue; // A deletion made by the workspace is handled by the tree comparison.
    const match =
      /^(?:---\n)?bump: (?:patch|minor|major)\n(?:---\n)?\n?([^\n]+)\n?$/u.exec(
        note.value.replaceAll("\r\n", "\n"),
      );
    if (match?.[1] === undefined) continue;
    const log = await jjOut(
      [
        "file",
        "show",
        "-r",
        trunk,
        rootFileFileset(`tools/${tool}/CHANGELOG.md`),
      ],
      repo.backing,
      true,
    );
    if (log.ok && log.value.split("\n").includes(`- ${match[1].trim()}`))
      consumed.push(path);
  }
  return good(consumed);
}

async function releaseMetadata(
  repo: Repo,
  tip: string,
  trunk: string,
  path: string,
): Promise<boolean> {
  const kind = basename(path);
  const fileset = rootFileFileset(path);
  const before = await jjOut(
    ["file", "show", "-r", tip, fileset],
    repo.backing,
    true,
  );
  const after = await jjOut(
    ["file", "show", "-r", trunk, fileset],
    repo.backing,
    true,
  );
  if (!before.ok || !after.ok) return false;
  if (
    kind === "CHANGELOG.md" &&
    before.value.startsWith("# Changelog\n") &&
    after.value.startsWith("# Changelog\n") &&
    after.value
      .trimEnd()
      .endsWith(before.value.slice("# Changelog\n".length).trim())
  )
    return true;
  if (kind !== "package.json") return false;
  const schema = jsonOf(
    z.looseObject({ version: z.string().regex(/^\d+\.\d+\.\d+$/u) }),
  );
  const a = schema.safeParse(before.value);
  const b = schema.safeParse(after.value);
  if (!a.success || !b.success) return false;
  const { version: av, ...ap } = a.data;
  const { version: bv, ...bp } = b.data;
  const aa = av.split(".").map(Number);
  const bb = bv.split(".").map(Number);
  const next = bb.findIndex((part, index) => part !== aa[index]);
  if (
    next >= 0 &&
    (bb[next] ?? 0) > (aa[next] ?? 0) &&
    JSON.stringify(ap) === JSON.stringify(bp)
  )
    return true;
  return false;
}

/** Compare each path separately: one unsupported binary/addition must not disable text containment. */
async function compareContent(
  repo: Repo,
  tip: string,
  trunk: string,
  base: string,
  changed: string[],
): Promise<Attempt<ContentResult>> {
  const notes = await consumedChangesets(repo, tip, trunk, changed);
  if (!notes.ok) return notes;
  const consumed = notes.value;
  const releasedTools = new Set(consumed.map((path) => path.split("/")[1]));
  const differing: string[] = [];
  if (changed.length === 0) return good({ differing, total: 0, consumed });
  const summary = await jjOut(
    [
      "diff",
      "--from",
      tip,
      "--to",
      trunk,
      "--summary",
      "--",
      ...changed.map((path) => rootFileFileset(path)),
    ],
    repo.backing,
    true,
  );
  if (!summary.ok) return summary;
  const entries = summary.value.split("\n").filter(Boolean);
  // Rename displays and unknown formats fall back to the individual tree comparison.
  const delta = entries.every((line) => /^[AMD] /u.test(line))
    ? new Set(entries.map((line) => line.slice(2)))
    : undefined;
  const pending = changed.filter(
    (path) =>
      !consumed.includes(path) && (delta === undefined || delta.has(path)),
  );
  if (pending.length === 0)
    return good({ differing, total: changed.length, consumed });
  const batch = await Promise.all(
    [tip, trunk].map((revision) =>
      jjOut(
        [
          "diff",
          "--from",
          base,
          "--to",
          revision,
          "--git",
          "--context",
          "0",
          "--",
          ...pending.map((path) => rootFileFileset(path)),
        ],
        repo.backing,
        true,
      ),
    ),
  );
  const [workBatch, integratedBatch] = batch;
  if (workBatch === undefined || integratedBatch === undefined)
    return bad("missing diff comparison");
  if (!workBatch.ok) return workBatch;
  if (!integratedBatch.ok) return integratedBatch;
  const byRevision = [
    patchesByFile(workBatch.value),
    patchesByFile(integratedBatch.value),
  ];
  for (const path of changed) {
    if (consumed.includes(path)) continue;
    if (delta !== undefined && !delta.has(path)) continue;
    const fileset = rootFileFileset(path);
    // A recognized batch summary already tells us this exact file differs.
    // Only ambiguous rename/unknown displays need another per-file probe.
    const diff =
      delta === undefined
        ? await jjOut(
            ["diff", "--from", tip, "--to", trunk, "--summary", "--", fileset],
            repo.backing,
            true,
          )
        : undefined;
    if (diff?.ok === false) return diff;
    if (diff?.value.trim() === "") continue;
    const releaseFile = /^tools\/([^/]+)\/(package\.json|CHANGELOG\.md)$/u.exec(
      path,
    );
    if (
      releaseFile !== null &&
      releasedTools.has(releaseFile[1]) &&
      (await releaseMetadata(repo, tip, trunk, path))
    )
      continue;
    const patches = await Promise.all(
      [tip, trunk].map((revision, index) =>
        // Plain paths have unquoted git headers. Split the batch by file so an
        // unsupported binary/addition still affects only that file. Unusual
        // path quoting keeps the existing individual-file fallback.
        /^[A-Za-z0-9_./-]+$/u.test(path)
          ? Promise.resolve(
              good(byRevision[index]?.get(`a/${path} b/${path}`) ?? ""),
            )
          : jjOut(
              [
                "diff",
                "--from",
                base,
                "--to",
                revision,
                "--git",
                "--context",
                "0",
                "--",
                fileset,
              ],
              repo.backing,
              true,
            ),
      ),
    );
    const [work, integrated] = patches;
    if (work === undefined || integrated === undefined)
      return bad("missing diff comparison");
    if (!work.ok) return work;
    if (!integrated.ok) return integrated;
    const wanted = patchEdits(work.value);
    const present = patchEdits(integrated.value);
    if (
      wanted === null ||
      present === null ||
      ![...wanted].every((edit) => present.has(edit))
    )
      differing.push(path);
  }
  return good({ differing, total: changed.length, consumed });
}

/** Recognize a release snapshot on trunk even if later trunk edits changed the same paths. */
export async function outstanding(
  repo: Repo,
  tip: string,
  trunk: string,
): Promise<Attempt<ContentResult>> {
  const conflicted = await jjOut(
    ["log", "--no-graph", "-r", tip, "-T", "conflict"],
    repo.backing,
    true,
  );
  if (!conflicted.ok) return conflicted;
  if (conflicted.value.trim() === "true") return bad("workspace has conflicts");
  const pending = await unlandedFrom(repo.backing, tip, trunk, true);
  if (!pending.ok) return pending;
  if (pending.value.length === 0) {
    const pushed = await pushedBookmarks(repo.backing, tip, trunk);
    if (!pushed.ok) return pushed;
    return good({
      differing: [],
      total: 0,
      consumed: [],
      ...(pushed.value.length === 0 ? {} : { pushed: pushed.value }),
    });
  }
  const base = `heads(::(${tip}) & ::(${trunk}))`;
  const paths = await jjOut(
    ["diff", "--from", base, "--to", tip, "--name-only"],
    repo.backing,
    true,
  );
  if (!paths.ok) return paths;
  const changed = paths.value.split("\n").filter(Boolean);
  const current = await compareContent(repo, tip, trunk, base, changed);
  if (
    !current.ok ||
    current.value.differing.length === 0 ||
    current.value.consumed.length === 0
  )
    return current;
  // Only release commits carrying this workspace's notes are candidates, never arbitrary history.
  const logs = [
    ...new Set(
      current.value.consumed.map(
        (path) => `tools/${path.split("/")[1]}/CHANGELOG.md`,
      ),
    ),
  ];
  const releases = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      `::(${trunk}) & (${logs.map((path) => `files(${JSON.stringify(path)})`).join(" | ")})`,
      "-T",
      'commit_id ++ "\\n"',
    ],
    repo.backing,
    true,
  );
  if (!releases.ok) return releases;
  for (const release of releases.value.trim().split("\n").filter(Boolean)) {
    if (release === trunk) continue;
    const landed = await compareContent(repo, tip, release, base, changed);
    if (!landed.ok) return landed;
    if (landed.value.differing.length === 0)
      return good({
        ...landed.value,
        integratedAt: release,
        trunkDifferences: current.value.differing,
      });
  }
  return current;
}

function sameTrackedFile(
  left: JjTreeFile | undefined,
  right: JjTreeFile | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.type !== "conflict" &&
    right.type !== "conflict" &&
    left.object === right.object &&
    left.type === right.type &&
    left.executable === right.executable
  );
}

function unlandedWorkspaceChange(
  ws: Workspace,
  commits: Map<string, JjCommit>,
): {
  change: JjCommit | undefined;
  changes: JjCommit[];
  missing: string | undefined;
  remoteBookmarks: string[];
} {
  const pending = [ws.target];
  const seen = new Set<string>();
  const remoteBookmarks = new Set<string>();
  const changes: JjCommit[] = [];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const commit = commits.get(id);
    if (commit === undefined)
      return {
        change: undefined,
        changes: [],
        missing: `commit ${id} is absent from aggregate revset`,
        remoteBookmarks: [],
      };
    for (const bookmark of commit.remoteBookmarks)
      remoteBookmarks.add(bookmark);
    if (commit.trunk || commit.remote) continue;
    if (!commit.empty) changes.push(commit);
    pending.push(...commit.parents);
  }
  return {
    change: changes[0],
    changes,
    missing: undefined,
    remoteBookmarks: [...remoteBookmarks].toSorted(),
  };
}

async function classifyGc(
  repo: Repo,
  cfg: Config,
  ws: Workspace,
  kind: string,
  records: RunRecord[],
  commits: Map<string, JjCommit>,
  graphError: string | undefined,
  trunk: string | null,
  options: GcOptions,
  trace?: GcTrace,
  budget?: { remainingMs: number; exhausted: boolean },
): Promise<Classification> {
  const change = ws.change.length > 0 ? ws.change : "?";
  const age = ws.age.length > 0 ? ws.age : "?";
  const verdict = (
    label: "removable" | "keep" | "broken",
    reason: string,
    collect = false,
  ): Classification => ({ verdict: label, change, age, reason, collect });
  if (ws.main) return verdict("keep", "main checkout is not removable");
  if (ws.recordError !== undefined) return verdict("broken", ws.recordError);
  if (ws.rootMissing === true)
    return verdict("broken", `workspace ${ws.name} has no recorded root path`);
  const owner = jjWorkspace(ws.dir);
  if (!owner.ok) {
    const metadata = brokenWorkspaceReason(owner.error);
    if (metadata !== undefined)
      return verdict("broken", `workspace metadata is invalid: ${metadata}`);
    return verdict("broken", `workspace unavailable or foreign: ${ws.dir}`);
  }
  if (
    owner.value.root !== realOr(ws.dir) ||
    owner.value.backingRoot !== repo.backing
  )
    return verdict("broken", `workspace unavailable or foreign: ${ws.dir}`);
  const checkout = await attempt(() =>
    readFile(join(ws.dir, ".jj", "working_copy", "checkout")),
  );
  if (!checkout.ok)
    return verdict("broken", `workspace metadata is invalid: ${msg(checkout)}`);
  if (!checkout.value.includes(Buffer.from(ws.name)))
    return verdict(
      "broken",
      `workspace metadata is invalid: checkout does not identify ${ws.name}`,
    );
  if (protectedWorkspace(repo, cfg, ws))
    return verdict("keep", "declared in [ws].keep");
  const occupied = busy(realOr(ws.dir));
  if (occupied !== undefined) return verdict("keep", occupied);
  const lineage = lineageOf(records, realOr(ws.dir));
  const live = lineage.find((record) => !TERMINAL_STATES.has(record.state));
  if (live !== undefined)
    return verdict("keep", `live or continuing run ${live.id} (${live.state})`);
  const blocked = runRemovalReason(ws.dir, records);
  if (blocked !== undefined) return verdict("keep", blocked);
  const allRejected =
    lineage.length > 0 &&
    lineage.every((record) => record.judgment?.decision === "reject");
  const localRuns = records.filter(
    (record) =>
      record.workspace !== null &&
      record.workspace !== undefined &&
      realOr(record.workspace) === realOr(ws.dir),
  );
  const abandonedCutoff =
    Temporal.Now.instant().epochMilliseconds - 24 * 60 * 60 * 1000;
  const endedWithoutAcceptanceFor24h =
    !allRejected &&
    localRuns.length > 0 &&
    !lineage.some((record) => record.judgment?.decision === "accept") &&
    localRuns.every((record) => {
      const endedAt = record.ended_at;
      if (
        record.state !== "ended" ||
        endedAt === null ||
        endedAt === undefined ||
        record.outcome === null ||
        record.outcome === undefined
      )
        return false;
      const ended = fromThrowable(() => Temporal.Instant.from(endedAt))();
      return ended.isOk() && ended.value.epochMilliseconds < abandonedCutoff;
    });
  const abandonedReason = `all runs ended without acceptance over 24h ago: ${localRuns.map((record) => `${record.id} (${record.outcome})`).join(", ")}`;
  const recorded = lineage.length > 0;
  const layoutAllowed =
    kind === "legacy"
      ? options.legacy === true
      : recorded || options.includeUnrecorded;
  if (!layoutAllowed)
    return verdict(
      "keep",
      kind === "legacy"
        ? "legacy workspace; pass --legacy to collect"
        : "unrecorded workspace; pass --include-unrecorded to collect",
    );
  if (endedWithoutAcceptanceFor24h && options.abandoned !== true)
    return verdict("keep", `${abandonedReason}; pass --abandoned to collect`);
  if (trunk === null)
    return verdict(
      "keep",
      "trunk resolves to root; cannot judge landed changes",
    );
  if (graphError !== undefined)
    return verdict(
      "broken",
      `aggregate jj classification failed: ${graphError}`,
    );
  const land = landState(ws);
  if (land !== undefined) {
    const lock = await landLockStatus(land);
    if (lock.held) return verdict("keep", lock.reason);
  }
  const pendingChange = unlandedWorkspaceChange(ws, commits);
  if (pendingChange.missing !== undefined)
    return verdict(
      "broken",
      `cannot judge workspace changes: ${pendingChange.missing}`,
    );
  const target = commits.get(ws.target);
  if (target === undefined)
    return verdict(
      "broken",
      `workspace target ${ws.target} is absent from aggregate revset`,
    );
  let landedByContent = false;
  if (
    pendingChange.change !== undefined &&
    !(options.abandoned === true && endedWithoutAcceptanceFor24h)
  ) {
    const trunkTarget = commits.get(trunk);
    if (
      trunkTarget === undefined ||
      !target.filesIncluded ||
      !trunkTarget.filesIncluded
    )
      return verdict(
        "broken",
        `cannot compare workspace content with trunk ${trunk}`,
      );
    const comparisonStart = performance.now();
    const changedPaths = new Set(
      pendingChange.changes.flatMap((commit) => commit.changedPaths),
    );
    const matchingContent =
      changedPaths.size > 0 &&
      [...changedPaths].every((path) =>
        sameTrackedFile(target.files.get(path), trunkTarget.files.get(path)),
      );
    const unrecordedModern = !recorded && kind === "ws";
    const consumed =
      matchingContent && !unrecordedModern
        ? await consumedChangesets(repo, ws.target, trunk, [...changedPaths])
        : good<string[]>([]);
    if (trace !== undefined)
      trace.comparisonMs += performance.now() - comparisonStart;
    if (!consumed.ok)
      return verdict(
        "broken",
        `cannot judge consumed changesets: ${msg(consumed)}`,
      );
    landedByContent =
      matchingContent &&
      (unrecordedModern ||
        lineage.some((record) => record.judgment?.decision === "accept") ||
        consumed.value.length > 0);
    if (!landedByContent) {
      const description = pendingChange.change.description.trim();
      return verdict(
        "keep",
        `unlanded change ${pendingChange.change.change} (${description.length > 0 ? description : "no description"})${endedWithoutAcceptanceFor24h ? "; pass --abandoned to collect aged failed runs" : ""}`,
      );
    }
  }
  const graceMinutes = gcGraceMinutes(options);
  if (graceMinutes > 0) {
    const created = await attempt(() => stat(ws.dir));
    if (!created.ok)
      return verdict("broken", `cannot read workspace age: ${msg(created)}`);
    const ageMs =
      Temporal.Now.instant().epochMilliseconds - created.value.birthtimeMs;
    if (ageMs < graceMinutes * 60_000)
      return verdict(
        "keep",
        `created ${Math.max(0, Math.floor(ageMs / 1000))} seconds ago; grace ${graceMinutes} min`,
      );
  }
  const resultDirs = allRejected
    ? lineage
        .filter((record) => /^[a-zA-Z0-9_-]+$/u.test(record.id))
        .map((record) => join(stateDir(), "runs", record.id))
    : [];
  if (budget !== undefined && budget.remainingMs <= 0) {
    budget.exhausted = true;
    return verdict("keep", "inventory budget exhausted");
  }
  const inventoryStart = performance.now();
  const inventory = await untrackedContent(
    ws.dir,
    cfg.regenerable,
    Math.min(gcInventoryTimeoutMs(options), budget?.remainingMs ?? Infinity),
    resultDirs,
    target.files,
  );
  const inventoryElapsed = performance.now() - inventoryStart;
  if (budget !== undefined) budget.remainingMs -= inventoryElapsed;
  if (trace !== undefined) {
    trace.inventoryMs += inventoryElapsed;
    trace.inventoryCount++;
  }
  if (!inventory.ok)
    return verdict("broken", `untracked inventory failed: ${msg(inventory)}`);
  if (inventory.value.trackedDifference !== undefined)
    return verdict(
      "keep",
      `unsnapshotted working-copy changes: yes: ${inventory.value.trackedDifference}`,
    );
  if (inventory.value.count > 0)
    return verdict(
      "keep",
      `untracked content: ${inventory.value.count} files (${inventory.value.paths.join(", ")})`,
    );
  const remoteReason =
    pendingChange.remoteBookmarks.length === 0
      ? ""
      : `; remote bookmark(s): ${pendingChange.remoteBookmarks.join(", ")}`;
  const landingReason = landedByContent
    ? `landed by content on ${trunk}`
    : "nothing unlanded";
  let removableReason = `${landingReason}${remoteReason}; no untracked content`;
  if (allRejected)
    removableReason = `${landingReason}${remoteReason}; all runs judged reject; results preserved (${lineage.map((record) => record.id).join(", ")}); no age wait`;
  else if (endedWithoutAcceptanceFor24h)
    removableReason = landedByContent
      ? `${landingReason}${remoteReason}; ${abandonedReason}`
      : abandonedReason + remoteReason;
  return {
    ...verdict("removable", removableReason, true),
    abandon: allRejected || endedWithoutAcceptanceFor24h,
  };
}

async function classify(
  repo: Repo,
  cfg: Config,
  ws: Workspace,
  records: RunRecord[],
  trunk: string | null,
  readOnly = false,
  recentRecordedDiagnostic = false,
  checkStatus = true,
  inventoryTimeoutMs = 10_000,
): Promise<Classification> {
  let change = ws.change ?? "?";
  let age = ws.age ?? "?";
  const verdict = (
    label: string,
    reason: string,
    collect = false,
  ): Classification => ({ verdict: label, change, age, reason, collect });
  if (protectedWorkspace(repo, cfg, ws))
    return verdict("kept", "declared in [ws].keep");
  const owner = jjWorkspace(ws.dir);
  if (!owner.ok) {
    const broken = existsSync(ws.dir)
      ? brokenWorkspaceReason(owner.error)
      : undefined;
    return broken === undefined
      ? verdict(
          "keep",
          "missing or foreign workspace; never forget without a verified checkout",
        )
      : verdict("broken", `workspace metadata is invalid: ${broken}`);
  }
  if (
    owner.value.root !== realOr(ws.dir) ||
    owner.value.backingRoot !== repo.backing
  )
    return verdict(
      "keep",
      "missing or foreign workspace; never forget without a verified checkout",
    );
  const occupied = busy(realOr(ws.dir));
  if (occupied !== undefined) return verdict("keep", occupied);
  const lineage = lineageOf(records, realOr(ws.dir));
  const live = lineage.find((r) => !TERMINAL_STATES.has(r.state));
  if (live !== undefined)
    return verdict("keep", `live or continuing run ${live.id} (${live.state})`);
  const blocked = runRemovalReason(ws.dir, records);
  if (blocked !== undefined) return verdict("keep", blocked);
  const allRejected =
    lineage.length > 0 &&
    lineage.every((r) => r.judgment?.decision === "reject");
  const resultDirs = allRejected
    ? lineage
        .filter((r) => /^[a-zA-Z0-9_-]+$/u.test(r.id))
        .map((r) => join(stateDir(), "runs", r.id))
    : [];
  const inventory = await untrackedContent(
    ws.dir,
    cfg.regenerable,
    inventoryTimeoutMs,
    resultDirs,
  );
  if (!inventory.ok) {
    const broken = brokenWorkspaceReason(inventory.error);
    return broken === undefined
      ? verdict("unknown", `untracked inventory failed: ${msg(inventory)}`)
      : verdict("broken", `working-copy inventory is unavailable: ${broken}`);
  }
  if (inventory.value.count > 0)
    return verdict(
      "keep",
      `untracked content: ${inventory.value.count} files (${inventory.value.paths.join(", ")})`,
    );
  const land = landState(ws);
  if (land !== undefined) {
    const lock = await landLockStatus(land);
    return lock.held
      ? verdict("land-temp", lock.reason)
      : verdict(
          "land-temp",
          "temporary land checkout; no live land lock",
          true,
        );
  }
  let fresh: Attempt<unknown>;
  if (!checkStatus) fresh = good(undefined);
  else if (readOnly) fresh = await jjOut(["status"], ws.dir, true);
  else fresh = await updateStale(ws.dir, allRejected);
  if (!fresh.ok) {
    const broken = brokenWorkspaceReason(fresh.error);
    if (broken !== undefined)
      return verdict("broken", `working-copy state is unavailable: ${broken}`);
    if (readOnly && msg(fresh).includes("working copy is stale"))
      return verdict("stale", msg(fresh));
    return verdict("keep", msg(fresh));
  }
  const sparse = await jjOut(["sparse", "list"], ws.dir, true);
  if (!sparse.ok) {
    const broken = brokenWorkspaceReason(sparse.error);
    return broken === undefined
      ? verdict("keep", msg(sparse))
      : verdict("broken", `working-copy metadata is invalid: ${broken}`);
  }
  if (sparse.value.trim() !== ".")
    return verdict(
      "keep",
      `sparse patterns are not '.': ${JSON.stringify(sparse.value.trim())}`,
    );
  const diskDifference = await workingCopyDifference(ws.dir);
  if (diskDifference !== undefined)
    return verdict(
      diskDifference.startsWith("unknown:") ? "unknown" : "keep",
      `unsnapshotted working-copy changes: ${diskDifference}`,
    );
  const info = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'change_id.short(12) ++ "\\t" ++ committer.timestamp().ago() ++ "\\t" ++ empty',
    ],
    ws.dir,
    true,
  );
  if (!info.ok) {
    const broken = brokenWorkspaceReason(info.error);
    return broken === undefined
      ? verdict("keep", msg(info))
      : verdict("broken", `working-copy revision is unavailable: ${broken}`);
  }
  const [id, since, empty] = info.value.split("\t");
  change = id ?? "?";
  age = since ?? "?";
  // Abandonment is based on runs at this workspace path, not a ticket redone elsewhere.
  const local = records.filter(
    (r) =>
      r.workspace !== null &&
      r.workspace !== undefined &&
      realOr(r.workspace) === realOr(ws.dir),
  );
  const cutoff = Temporal.Now.instant().epochMilliseconds - 24 * 60 * 60 * 1000;
  if (
    !allRejected &&
    local.length > 0 &&
    !lineage.some((r) => r.judgment?.decision === "accept") &&
    local.every((r) => {
      const endedAt = r.ended_at;
      if (
        r.state !== "ended" ||
        endedAt === null ||
        endedAt === undefined ||
        r.outcome === null ||
        r.outcome === undefined
      )
        return false;
      const ended = fromThrowable(() => Temporal.Instant.from(endedAt))();
      return ended.isOk() && ended.value.epochMilliseconds < cutoff;
    })
  )
    return verdict(
      "abandoned",
      `all runs ended without acceptance over 24h ago: ${local.map((r) => `${r.id} (${r.outcome})`).join(", ")}`,
      true,
    );
  // Doctor is silent for both landed recorded workspaces (GC owns them) and
  // unlanded recorded workspaces under 72h. Staleness and abandonment above
  // still need attention. GC and full inventories always do the full check.
  if (recentRecordedDiagnostic)
    return verdict(
      "keep",
      "recent recorded workspace: no landing diagnostic due",
    );
  if (trunk === null)
    return verdict(
      "no trunk",
      "trunk resolves to root; no landed/unlanded classification",
    );
  const tip = await jjOut(
    ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
    ws.dir,
    true,
  );
  if (!tip.ok) {
    const broken = brokenWorkspaceReason(tip.error);
    return broken === undefined
      ? verdict("keep", msg(tip))
      : verdict("broken", `working-copy revision is unavailable: ${broken}`);
  }
  // The current working-copy chain owns content. Recorded commits can be obsolete
  // after squash/rebase integration or a continuation in this same workspace.
  const tips = [tip.value.trim()];
  const consumed = new Set<string>();
  const releases = new Set<string>();
  for (const candidate of new Set(tips)) {
    const work = await outstanding(repo, candidate, trunk);
    if (!work.ok) {
      const broken = brokenWorkspaceReason(work.error);
      return broken === undefined
        ? verdict("keep", `landing comparison failed: ${msg(work)}`)
        : verdict("broken", `landing revision is unavailable: ${broken}`);
    }
    if (work.value.pushed !== undefined)
      return verdict(
        "pushed",
        `non-trunk changes reachable from remote bookmarks: ${work.value.pushed.join(", ")}`,
        true,
      );
    if (work.value.differing.length > 0)
      return verdict(
        "unlanded",
        `differs in ${work.value.differing.length} of ${work.value.total} paths: ${work.value.differing.join(", ")}; never removed`,
      );
    for (const path of work.value.consumed) consumed.add(path);
    if (work.value.integratedAt !== undefined)
      releases.add(work.value.integratedAt);
  }
  return {
    ...verdict(
      empty === "true" ? "empty" : "landed",
      (consumed.size === 0
        ? "nothing unlanded"
        : `nothing unlanded; land-consumed changesets: ${[...consumed].join(", ")}`) +
        (releases.size === 0
          ? ""
          : `; matched release snapshot: ${[...releases].join(", ")}`) +
        (allRejected
          ? `; all runs judged reject; remaining results preserved in run directories (${lineage.map((r) => r.id).join(", ")}); no age wait`
          : ""),
      true,
    ),
    abandon: allRejected,
  };
}

export function gcCounts(lines: string[]) {
  const rows = lines.map((line) => line.split("\t")).filter((row) => row[1] !== "repo" && row[1] !== "main");
  const kept = { unlanded: 0, unjudged_run: 0, untracked_content: 0, inventory_budget_exhausted: 0, broken: 0, other: 0 };
  let removed = 0;
  for (const row of rows) {
    const reason = row[5] ?? "";
    if (row[2] === "collected" || reason.endsWith("; removed")) { removed++; continue; }
    if (row[2] === "broken") kept.broken++;
    else if (reason.includes("unlanded change ")) kept.unlanded++;
    else if (reason.includes(" is unjudged; keep")) kept.unjudged_run++;
    else if (reason.includes("untracked content:")) kept.untracked_content++;
    else if (reason.includes("inventory budget exhausted")) kept.inventory_budget_exhausted++;
    else kept.other++;
  }
  const originalRows = lines.map((line) => line.split("\t")).filter((row) => row[1] !== "repo" && row[2] !== "collected");
  return { total: originalRows.length, unlanded: originalRows.filter((row) => row[2] === "keep" && row[5]?.includes("unlanded change ") === true).length, collectable: originalRows.filter((row) => row[2] === "removable").length, legacy: originalRows.filter((row) => row[1] === "legacy").length, removed, kept };
}

type GcResult = {
  lines: string[];
  failed: string[];
  counts: ReturnType<typeof gcCounts>;
  broken: string[];
  refused?: string[];
  complete: boolean;
  repositories?: Array<{
    root: string;
    sources: string[];
    status: string;
    counts: ReturnType<typeof gcCounts>;
  }>;
  discovery?: { state: number; record: number; L2: number; note: string };
};

type GcRemovalResult = {
  classification: Classification;
  tombstone?: string;
};

async function preservedResult(
  dir: string,
  path: string,
  resultDirs: string[],
  deadline: number,
): Promise<boolean> {
  const preserved = await attempt(async () => {
    const source = join(dir, path);
    const sourceInfo = await lstat(source);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.size > MAX_PRESERVED_RESULT_BYTES ||
      performance.now() >= deadline
    )
      return false;
    const bytes = await readFile(source);
    for (const runDir of preservationDirectories(resultDirs)) {
      if (
        performance.now() < deadline &&
        (await preservedResultCopy(
          dir,
          path,
          runDir,
          sourceInfo.size,
          bytes,
          deadline,
        ))
      )
        return true;
    }
    return false;
  });
  return preserved.ok && preserved.value;
}

function* preservationDirectories(resultDirs: string[]): Generator<string> {
  for (const runRoot of resultDirs) {
    yield join(runRoot, "results");
    yield join(runRoot, "harvest");
  }
}

async function preservedResultCopy(
  dir: string,
  path: string,
  runDir: string,
  sourceSize: number,
  bytes: Buffer,
  deadline: number,
): Promise<boolean> {
  const root = resolve(runDir);
  const copy = join(root, path);
  const equal = await attempt(async () => {
    const target = await realpath(copy);
    if (!target.startsWith(root + sep) || target.startsWith(realOr(dir) + sep))
      return false;
    const copyInfo = await lstat(copy);
    if (!copyInfo.isFile() || copyInfo.size !== sourceSize) return false;
    if (performance.now() >= deadline) return false;
    return bytes.equals(await readFile(copy));
  });
  return equal.ok && equal.value;
}

/** Inventory disk entries against the saved snapshot; never follow directory symlinks. */
export async function untrackedContent(
  dir: string,
  regenerable: string[],
  timeoutMs = 10_000,
  resultDirs: string[] = [],
  trackedFiles?: Set<string> | Map<string, JjTreeFile>,
): Promise<
  Attempt<{
    count: number;
    paths: string[];
    entries: number;
    trackedDifference?: string;
  }>
> {
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  let count = 0;
  let entriesInventoried = 0;
  let trackedDifference: string | undefined;
  const timeoutFailure = (): Attempt<never> =>
    bad(
      `inventory timed out: limit ${timeoutMs}ms, elapsed ${Math.floor(performance.now() - startedAt)}ms, entries inventoried ${entriesInventoried}`,
    );
  let files: Set<string>;
  const trackedDetails = trackedFiles instanceof Map ? trackedFiles : undefined;
  if (trackedFiles === undefined) {
    const tracked = await runStep(
      [
        "jj",
        "--no-pager",
        "--color=never",
        "--ignore-working-copy",
        "file",
        "list",
        "-T",
        'path ++ "\\0"',
      ],
      dir,
      { timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) },
    );
    if (!tracked.ok)
      return performance.now() >= deadline ||
        msg(tracked).includes("deadline exceeded")
        ? timeoutFailure()
        : tracked;
    if (performance.now() >= deadline) return timeoutFailure();
    if (tracked.value.code !== 0)
      return bad(`jj file list failed: ${tracked.value.err.trim()}`);
    files = new Set(tracked.value.out.toString().split("\0").filter(Boolean));
  } else if (trackedFiles instanceof Map) {
    files = new Set(trackedFiles.keys());
  } else {
    files = new Set(trackedFiles);
  }
  const roots = regenerable.map((path) => path.replace(/\/$/u, ""));
  const owner = jjWorkspace(dir);
  if (!owner.ok) return owner;
  const store = join(owner.value.backingRoot, ".jj", "repo", "store");
  const gitTarget = await attempt(() =>
    readFile(join(store, "git_target"), "utf8"),
  );
  if (!gitTarget.ok)
    return bad(`cannot locate ignore rules: ${msg(gitTarget)}`);
  const gitDir = resolve(store, gitTarget.value.trim());
  const isRegenerable = (path: string): boolean =>
    roots.some((root) => path === root || path.startsWith(`${root}/`));
  // An empty index makes Git apply ignore rules independently of the backing
  // checkout's index; jj's saved snapshot is the authority for tracked files.
  const listing = await runStep(
    [
      "git",
      `--git-dir=${gitDir}`,
      `--work-tree=${dir}`,
      "-c",
      "core.excludesFile=/dev/null",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ...roots.map((root) => `:(exclude,literal)${root}`),
    ],
    dir,
    {
      env: {
        GIT_INDEX_FILE: join(tmpdir(), `agx-empty-index-${randomUUID()}`),
      },
      timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
    },
  );
  if (!listing.ok)
    return performance.now() >= deadline ||
      msg(listing).includes("deadline exceeded")
      ? timeoutFailure()
      : listing;
  if (listing.value.code !== 0)
    return bad(`ignore inventory failed: ${listing.value.err.trim()}`);
  const visible = new Set(
    listing.value.out.toString().split("\0").filter(Boolean),
  );
  const visibleDirs = new Set<string>();
  for (const path of [...visible, ...files, ...roots]) {
    let parent = dirname(path);
    while (parent !== "." && !visibleDirs.has(parent)) {
      visibleDirs.add(parent);
      parent = dirname(parent);
    }
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paths: string[] = [];
  const seenTracked = new Set<string>();
  const pending = [""];
  const timedOut = () => expired || performance.now() >= deadline;
  const timeoutDiagnostic = (): Attempt<never> => timeoutFailure();
  const compareTracked = async (
    path: string,
    expected: JjTreeFile,
  ): Promise<string | undefined> => {
    if (expected.object === "") return `cannot compare tracked file: ${path}`;
    const target = join(dir, path);
    const actual = await attempt(() => lstat(target));
    if (!actual.ok) {
      const missing = z
        .object({ code: z.literal("ENOENT") })
        .safeParse(actual.error);
      return missing.success
        ? `sparse or missing tracked file: ${path}`
        : `cannot inspect tracked file ${path}: ${msg(actual)}`;
    }
    let content: Uint8Array;
    if (expected.type === "file" && actual.value.isFile()) {
      content = await readFile(target);
    } else if (expected.type === "symlink" && actual.value.isSymbolicLink()) {
      content = Buffer.from(await readlink(target));
    } else if (
      expected.type === "git-submodule" &&
      actual.value.isDirectory()
    ) {
      return undefined;
    } else if (expected.type === "tree" && actual.value.isDirectory()) {
      return undefined;
    } else {
      return `bytes differ at ${path}`;
    }
    let algorithm: "sha1" | "sha256" | undefined;
    if (expected.object.length === 40) algorithm = "sha1";
    else if (expected.object.length === 64) algorithm = "sha256";
    if (algorithm === undefined)
      return `cannot compare tracked file object id: ${path}`;
    const hash = createHash(algorithm)
      .update(`blob ${content.byteLength}\0`)
      .update(content)
      .digest("hex");
    if (hash !== expected.object) return `bytes differ at ${path}`;
    if (
      expected.type === "file" &&
      expected.executable !== ((actual.value.mode & 0o111) !== 0)
    )
      return `mode differs at ${path}`;
    return undefined;
  };
  const visit = async (parent: string): Promise<Attempt<void>> => {
    const entries = await attempt(() =>
      readdir(join(dir, parent), { withFileTypes: true }),
    );
    if (!entries.ok) return entries;
    for (const entry of entries.value) {
      if (timedOut()) return timeoutDiagnostic();
      entriesInventoried++;
      const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
      if (entry.name === ".jj" || entry.name === ".git") continue;
      if (isRegenerable(path)) continue;
      if (!visible.has(path) && !files.has(path) && !visibleDirs.has(path))
        continue;
      const expected = trackedDetails?.get(path);
      if (expected !== undefined) {
        seenTracked.add(path);
        const difference = await compareTracked(path, expected);
        trackedDifference ??= difference;
        continue;
      }
      if (entry.isDirectory()) pending.push(path);
      if (entry.isDirectory() || files.has(path)) continue;
      // A filename alone is not evidence of preservation. Require an ordinary file
      // and an identical copy at the same relative path in a run's results/ tree.
      if (
        entry.isFile() &&
        resultDirs.length > 0 &&
        (await preservedResult(dir, path, resultDirs, deadline))
      )
        continue;
      count++;
      if (paths.length < 5) paths.push(path);
    }
    return good(undefined);
  };
  const walk = async (): Promise<
    Attempt<{
      count: number;
      paths: string[];
      entries: number;
      trackedDifference?: string;
    }>
  > => {
    while (pending.length > 0) {
      if (timedOut()) return timeoutDiagnostic();
      const result = await visit(pending.pop() ?? "");
      if (!result.ok) return result;
    }
    for (const [path, expected] of trackedDetails ?? []) {
      if (timedOut()) return timeoutDiagnostic();
      if (isRegenerable(path) || seenTracked.has(path)) continue;
      const difference = await compareTracked(path, expected);
      trackedDifference ??= difference;
    }
    return good({
      count,
      paths,
      entries: entriesInventoried,
      ...(trackedDifference === undefined ? {} : { trackedDifference }),
    });
  };
  const timeout = new Promise<Attempt<never>>((resolveTimeout) => {
    timer = setTimeout(
      () => {
        expired = true;
        resolveTimeout(timeoutDiagnostic());
      },
      Math.max(0, deadline - performance.now()),
    );
  });
  const result = await Promise.race([walk(), timeout]);
  clearTimeout(timer);
  return result;
}

async function finishGcRemoval(
  result: Attempt<GcRemovalResult>,
  graveyard: Graveyard,
  fallback: Classification,
): Promise<Classification> {
  if (!result.ok)
    return {
      ...fallback,
      verdict: "broken",
      collect: false,
      reason: msg(result),
    };
  const classification = result.value.classification;
  const tombstone = result.value.tombstone;
  if (tombstone === undefined) return classification;
  const deleted = await deleteTombstone(graveyard, tombstone);
  if (deleted.ok)
    return { ...classification, reason: classification.reason + "; removed" };
  return {
    ...classification,
    verdict: "broken",
    collect: false,
    reason: "tombstone cleanup failed at " + tombstone + ": " + msg(deleted),
  };
}

async function accountForMissingWorkspaceForget(
  classification: Classification,
  forgotten: Attempt<string>,
  land: string | undefined,
): Promise<{ classification: Classification; reason: string }> {
  if (land === undefined) {
    const detail = forgotten.ok
      ? forgotten.value
      : "record retained: " + msg(forgotten);
    return {
      classification,
      reason: classification.reason + "; " + detail,
    };
  }
  if (
    forgotten.ok &&
    forgotten.value === "workspace record forgotten after reachability check"
  ) {
    const updated = {
      ...classification,
      verdict: "collected",
      collect: false,
      reason: "land workspace collected; " + forgotten.value,
    };
    return { classification: updated, reason: updated.reason };
  }
  const lock = await landLockStatus(land);
  const detail = forgotten.ok
    ? forgotten.value
    : "record retained: " + msg(forgotten);
  const updated = {
    ...classification,
    verdict: "keep",
    collect: false,
    reason: `land workspace kept; ${detail}; ${lock.reason}`,
  };
  return { classification: updated, reason: updated.reason };
}

/** TSV columns: path, kind, verdict, change id, age, reason. */
export async function gc(options: GcOptions): Promise<Attempt<GcResult>> {
  const resolved = resolveRepo(options.repo);
  if (!resolved.ok) return resolved;
  const repo = resolved.value;
  const initialConfig = await readConfig(repo);
  if (!initialConfig.ok) return initialConfig;
  const pre = common(repo, options.dryRun);
  if (!pre.ok) return pre;
  const graveyard = await checkGraveyard();
  if (!graveyard.ok) return graveyard;
  // Inventory and initial classification are read-only, including in a real collection pass.
  // A dry run never enters withLock (and therefore never creates waiter metadata either).
  const run = async (): Promise<Attempt<GcResult>> => {
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    const trunk = await resolveTrunk(repo, cfg.value);
    if (!trunk.ok) return trunk;
    const tracing = process.env.AGX_WS_GC_TRACE === "1";
    const report = (step: string, ms: number, count?: number) => {
      if (tracing)
        process.stderr.write(
          `gc trace: ${step}: ${ms.toFixed(3)} ms${count === undefined ? "" : ` count=${count}`}\n`,
        );
    };
    let stepStart = performance.now();
    const candidates = await workspaces(repo, options.includeMain ?? true);
    report("workspace list", performance.now() - stepStart);
    if (!candidates.ok) return candidates;
    stepStart = performance.now();
    const recordsResult = await agxRecords(repo.backing);
    report("run records", performance.now() - stepStart);
    const records = recordsResult.ok ? recordsResult.value : [];
    const graphResult = await gcCommitGraph(repo, trunk.value.commit, report);
    const commits = graphResult.ok
      ? graphResult.value
      : new Map<string, JjCommit>();
    const lines: string[] = [];
    const failed: string[] = [];
    const broken: string[] = [];
    const trace: GcTrace = {
      inventoryMs: 0,
      inventoryCount: 0,
      comparisonMs: 0,
    };
    const budget = {
      remainingMs: (options.inventoryBudgetSeconds ?? 120) * 1000,
      exhausted: false,
    };
    let classificationMs = 0;
    let completed = 0;
    let slowest: { workspace: string; ms: number; step: string } | undefined;
    const reportProgress = () => {
      if (!tracing) return;
      process.stderr.write(
        `gc trace: cumulative: workspaces=${completed}/${candidates.value.length} classification=${Math.max(0, classificationMs - trace.inventoryMs - trace.comparisonMs).toFixed(3)} ms inventory=${trace.inventoryMs.toFixed(3)} ms count=${trace.inventoryCount} comparison=${trace.comparisonMs.toFixed(3)} ms slowest=${JSON.stringify(slowest?.workspace ?? null)} ms=${(slowest?.ms ?? 0).toFixed(3)} step=${slowest?.step ?? "none"}\n`,
      );
    };
    for (const ws of candidates.value) {
      const inventoryBefore = trace.inventoryMs;
      const comparisonBefore = trace.comparisonMs;
      const classificationStart = performance.now();
      const land = landState(ws);
      let kind = "legacy";
      if (ws.main) kind = "main";
      else if (land !== undefined) kind = "land";
      else if (
        dirname(resolve(ws.dir)) === resolve(repo.wsRoot) &&
        basename(resolve(ws.dir)).startsWith("ws_")
      )
        kind = "ws";
      const directoryInfo =
        ws.rootMissing === true
          ? undefined
          : await attempt(() => lstat(ws.dir));
      const missingDirectory =
        directoryInfo !== undefined &&
        !directoryInfo.ok &&
        z.object({ code: z.literal("ENOENT") }).safeParse(directoryInfo.error)
          .success;
      const landLock =
        missingDirectory && land !== undefined
          ? await landLockStatus(land)
          : undefined;
      let c: Classification;
      if (missingDirectory && land !== undefined) {
        c =
          landLock?.held === true
            ? {
                verdict: "keep",
                change: ws.change,
                age: ws.age,
                reason: landLock.reason,
                collect: false,
              }
            : {
                verdict: "removable",
                change: ws.change,
                age: ws.age,
                reason:
                  "land workspace directory is missing; no live land lock",
                collect: false,
              };
      } else if (missingDirectory) {
        c = {
          verdict: "broken",
          change: ws.change,
          age: ws.age,
          reason: "directory missing: " + ws.dir,
          collect: false,
        };
      } else if (!recordsResult.ok) {
        c = {
          verdict: "broken",
          change: ws.change,
          age: ws.age,
          reason: "run records unavailable: " + msg(recordsResult),
          collect: false,
        };
      } else if (!graphResult.ok) {
        c = {
          verdict: "broken",
          change: ws.change,
          age: ws.age,
          reason: "aggregate jj classification failed: " + msg(graphResult),
          collect: false,
        };
      } else {
        c = await classifyGc(
          repo,
          cfg.value,
          ws,
          kind,
          records,
          commits,
          undefined,
          trunk.value.commit,
          options,
          trace,
          budget,
        );
      }
      const elapsed = performance.now() - classificationStart;
      classificationMs += elapsed;
      const inventory = trace.inventoryMs - inventoryBefore;
      const comparison = trace.comparisonMs - comparisonBefore;
      const classification = Math.max(0, elapsed - inventory - comparison);
      let step = "classification";
      if (inventory >= comparison && inventory >= classification)
        step = "inventory";
      else if (comparison >= classification) step = "comparison";
      if (slowest === undefined || elapsed > slowest.ms)
        slowest = { workspace: ws.dir, ms: elapsed, step };
      let reason = c.reason;
      if (c.verdict === "broken") broken.push(ws.dir);
      const missingCommit = ws.commit;
      if (
        missingDirectory &&
        !options.dryRun &&
        missingCommit !== undefined &&
        landLock?.held !== true
      ) {
        const forgotten = await withLock<string>(
          repo,
          "agx ws gc " + ws.name,
          async () => {
            const releaseLand =
              land === undefined
                ? undefined
                : await acquire(
                    join(land, "land.lock"),
                    {
                      pid: process.pid,
                      host: hostname(),
                      what: "agx ws gc land-missing",
                      since: Temporal.Now.instant().toString(),
                    },
                    { waitMs: 0 },
                  );
            if (land !== undefined && typeof releaseLand !== "function") {
              const lock = await landLockStatus(land);
              return good(`record retained: ${lock.reason}`);
            }
            using _landLock =
              typeof releaseLand === "function"
                ? { [Symbol.dispose]: releaseLand }
                : undefined;
            const currentConfig = await readConfig(repo);
            if (!currentConfig.ok)
              return good("record retained: " + msg(currentConfig));
            if (protectedWorkspace(repo, currentConfig.value, ws))
              return good("workspace is kept by [ws].keep; record retained");
            const currentTrunk = await trunkCommit(repo, currentConfig.value);
            if (!currentTrunk.ok)
              return good("record retained: " + msg(currentTrunk));
            const currentRecords = await agxRecords(repo.backing);
            if (!currentRecords.ok)
              return good("record retained: " + msg(currentRecords));
            const blocked = runRemovalReason(ws.dir, currentRecords.value);
            if (blocked !== undefined)
              return good("record retained: " + blocked);
            const occupied = busy(realOr(ws.dir));
            if (occupied !== undefined)
              return good("record retained: " + occupied);
            const forgetResult = await jjOut(
              ["workspace", "forget", ws.name],
              repo.backing,
              false,
              {
                name: ws.name,
                dir: ws.dir,
                commit: missingCommit,
                trunk: currentTrunk.value,
                ...(land === undefined ? {} : { owner: "land" }),
              },
            );
            return forgetResult.ok
              ? good("workspace record forgotten after reachability check")
              : good("record retained: " + msg(forgetResult));
          },
          (busyReason) =>
            good("record retained: collection skipped: " + busyReason),
        );
        const outcome = await accountForMissingWorkspaceForget(
          c,
          forgotten,
          land,
        );
        c = outcome.classification;
        reason = outcome.reason;
      }
      if (c.collect && !options.dryRun) {
        const done = await withLock<GcRemovalResult>(
          repo,
          `agx ws gc ${ws.name}`,
          async () => {
            const currentConfig = await readConfig(repo);
            if (!currentConfig.ok)
              return good({
                classification: {
                  ...c,
                  verdict: "broken",
                  collect: false,
                  reason: msg(currentConfig),
                },
              });
            const currentTrunk = await trunkCommit(repo, currentConfig.value);
            if (!currentTrunk.ok)
              return good({
                classification: {
                  ...c,
                  verdict: "broken",
                  collect: false,
                  reason: msg(currentTrunk),
                },
              });
            const currentWorkspaces = await workspaces(repo);
            if (!currentWorkspaces.ok)
              return good({
                classification: {
                  ...c,
                  verdict: "broken",
                  collect: false,
                  reason: msg(currentWorkspaces),
                },
              });
            const currentWs = currentWorkspaces.value.find(
              (row) => row.name === ws.name,
            );
            if (
              currentWs === undefined ||
              currentWs.rootMissing === true ||
              realOr(currentWs.dir) !== realOr(ws.dir)
            )
              return good({
                classification: {
                  ...c,
                  verdict: "broken",
                  collect: false,
                  reason: "workspace registration changed before removal",
                },
              });
            const currentRecords = await agxRecords(repo.backing);
            if (!currentRecords.ok)
              return good({
                classification: {
                  ...c,
                  verdict: "broken",
                  collect: false,
                  reason: msg(currentRecords),
                },
              });
            const currentGraph = await gcCommitGraph(repo, currentTrunk.value);
            if (!currentGraph.ok)
              return good({
                classification: {
                  ...c,
                  verdict: "broken",
                  collect: false,
                  reason: msg(currentGraph),
                },
              });
            const checked = await classifyGc(
              repo,
              currentConfig.value,
              currentWs,
              kind,
              currentRecords.value,
              currentGraph.value,
              undefined,
              currentTrunk.value,
              options,
              trace,
              budget,
            );
            if (!checked.collect) return good({ classification: checked });
            const removed = await collectWorkspace(
              repo,
              currentWs,
              checked.abandon === true,
            );
            if (removed.ok)
              return good({
                classification: checked,
                tombstone: removed.value.tombstone,
              });
            const currentLand = landState(currentWs);
            if (
              currentLand !== undefined &&
              msg(removed).includes("land lock acquired by another process")
            ) {
              const lock = await landLockStatus(currentLand);
              return good({
                classification: {
                  ...checked,
                  verdict: "keep",
                  collect: false,
                  reason: lock.reason,
                },
              });
            }
            return good({
              classification: {
                ...checked,
                verdict: "broken",
                collect: false,
                reason: msg(removed),
              },
            });
          },
          (busyReason) =>
            good({
              classification: {
                ...c,
                verdict: "keep",
                collect: false,
                reason: `collection skipped: ${busyReason}`,
              },
            }),
        );
        c = await finishGcRemoval(done, graveyard.value, c);
        broken.push(...(c.verdict === "broken" ? [ws.dir] : []));
        reason = c.reason;
        failed.push(...(c.verdict === "broken" ? [ws.dir] : []));
      }
      // Escape control characters without breaking the column contract.
      if (options.dryRun) reason += `; trunk source: ${trunk.value.source}`;
      lines.push(
        [ws.dir, kind, c.verdict, c.change, c.age, reason]
          .map((field) => field.replaceAll("\t", "\\t").replaceAll("\n", "\\n"))
          .join("\t"),
      );
      completed++;
      if (completed % 50 === 0) reportProgress();
    }
    if (completed % 50 !== 0 || completed === 0) reportProgress();
    report(
      "per-workspace classification",
      Math.max(0, classificationMs - trace.inventoryMs - trace.comparisonMs),
      candidates.value.length,
    );
    report("untracked inventory", trace.inventoryMs, trace.inventoryCount);
    report("comparison", trace.comparisonMs);
    const result = {
      lines,
      failed,
      counts: gcCounts(lines),
      broken,
      complete:
        failed.length === 0 &&
        broken.length === 0 &&
        !budget.exhausted &&
        !lines.some((line) => line.split("\t")[2] === "broken"),
    };
    if (!options.dryRun && failed.length === 0)
      await publishVerdicts(repo.backing, result);
    return good(result);
  };
  return run();
}

export async function registeredRepoPaths(): Promise<Attempt<string[]>> {
  const repos = await listAgxRepos();
  if (!repos.ok) return repos;
  return good(repos.value.map((repo) => repo.root));
}

async function doctorRepoPaths(): Promise<Attempt<string[]>> {
  const workspaceHome = process.env.AGX_REPOS_ROOT;
  if (workspaceHome === undefined) return registeredRepoPaths();
  const entries = await readdir(workspaceHome, { withFileTypes: true }).catch(
    () => [],
  );
  return good(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceHome, entry.name)),
  );
}

export type DoctorWorkspaceRow = {
  repo: string;
  dir: string;
  name: string;
  kind: "ws" | "legacy";
  recorded: boolean;
  classification: Classification;
  ageMs: number | undefined;
};

/** Read-only inventory built from the same workspaces and classifier as `agx ws gc --dry-run`. */
export async function doctorInventory(
  _root?: string,
  findingsOnly = false,
): Promise<Attempt<DoctorWorkspaceRow[]>> {
  const paths = await doctorRepoPaths();
  if (!paths.ok) return paths;
  const seen = new Set<string>();
  const rows: DoctorWorkspaceRow[] = [];
  let records: Attempt<RunRecord[]> | undefined;
  for (const path of paths.value) {
    const expanded = path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
    if (!(await Bun.file(join(expanded, ".git")).exists())) continue;
    const resolved = resolveRepo(expanded);
    if (!resolved.ok) return bad(`${path}: ${msg(resolved)}`);
    const repo = resolved.value;
    if (seen.has(repo.backing)) continue;
    seen.add(repo.backing);
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    const trunk = await trunkCommit(repo, cfg.value);
    if (!trunk.ok) return trunk;
    const candidates = await workspaces(repo);
    if (!candidates.ok) return candidates;
    // agx worker ls is a global run inventory, independent of repository cwd.
    records ??= await agxRecords(repo.backing);
    if (!records.ok) return records;
    for (const ws of candidates.value) {
      const kind =
        dirname(resolve(ws.dir)) === resolve(repo.wsRoot) &&
        basename(resolve(ws.dir)).startsWith("ws_")
          ? "ws"
          : "legacy";
      const info = await attempt(() => stat(ws.dir));
      const ageMs = info.ok
        ? Temporal.Now.instant().epochMilliseconds - info.value.mtimeMs
        : undefined;
      const recorded = lineageOf(records.value, realOr(ws.dir)).length > 0;
      const classification = await classify(
        repo,
        cfg.value,
        ws,
        records.value,
        trunk.value,
        true,
        findingsOnly &&
          kind === "ws" &&
          recorded &&
          ageMs !== undefined &&
          ageMs <= 72 * 60 * 60 * 1000,
      );
      rows.push({
        repo: repo.backing,
        dir: ws.dir,
        name: ws.name,
        kind,
        recorded,
        classification,
        ageMs,
      });
    }
  }
  return good(rows);
}

const doctorClean = (value: string) => value.replaceAll(/[\t\r\n]/gu, " ");

export async function doctorSummaries() {
  const paths = await registeredRepoPaths();
  if (!paths.ok) return paths;
  const records = await agxRecords(process.cwd());
  if (!records.ok) return records;
  const summaries = [];
  for (const path of paths.value) {
    const resolved = resolveRepo(path);
    if (!resolved.ok) return resolved;
    const repo = resolved.value;
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    const candidates = await workspaces(repo);
    if (!candidates.ok) return candidates;
    const runs = records.value.filter((run) =>
      run.state === "ended" && run.returned !== undefined && (run.judgment === null || run.judgment === undefined) &&
      (within(run.workspace, repo.backing) || within(run.cwd, repo.backing) || within(run.workspace, repo.wsRoot) || within(run.cwd, repo.wsRoot) ||
       candidates.value.some((ws) => within(run.workspace, realOr(ws.dir)) || within(run.cwd, realOr(ws.dir))))
    );
    const dates = runs.flatMap((run) => {
      const parsed = fromThrowable(() => Temporal.Instant.from(run.ended_at ?? "").epochMilliseconds)();
      return parsed.isOk() ? [parsed.value] : [];
    });
    const age = dates.length === 0 || dates.length !== runs.length ? null : Math.max(0, (Temporal.Now.instant().epochMilliseconds - Math.min(...dates)) / 3_600_000);
    summaries.push({ type: "workspace_summary" as const, repo: repo.backing, workspace_count: candidates.value.length, unjudged_returned_runs: runs.length, oldest_unjudged_age_hours: age, unjudged_warn_hours: cfg.value.unjudgedWarnHours ?? 24 });
  }
  return good(summaries);
}

/** Map gc classifier outcomes to doctor findings; kept rows remain deliberately silent. */
export async function doctor(): Promise<Attempt<string[]>> {
  const inventory = await doctorInventory(undefined, true);
  if (!inventory.ok) return inventory;
  return good(doctorFindings(inventory.value));
}

/** Findings count workspaces that the unattended `agx ws gc --all --legacy` cannot collect. */
export function doctorFindings(rows: DoctorWorkspaceRow[]): string[] {
  const findings: string[] = [];
  for (const row of rows) {
    const c = row.classification;
    if (
      c.verdict === "kept" ||
      c.verdict === "keep" ||
      c.verdict === "land-temp"
    )
      continue;
    if (
      c.collect &&
      c.verdict !== "abandoned" &&
      (row.kind === "legacy" || row.recorded)
    )
      continue;
    const emit = (finding: string, fix: string) => {
      findings.push(
        ["agx-ws", row.repo, row.name, finding, fix]
          .map((value) => doctorClean(value))
          .join("\t"),
      );
    };
    if (c.verdict === "stale") {
      const slug = row.name.startsWith("ws_") ? row.name.slice(3) : row.name;
      emit("stale", `agx ws refresh ${slug} --repo ${row.repo}`);
      continue;
    }
    if (c.verdict === "abandoned") {
      emit(
        "abandoned",
        `agx ws gc --abandoned${row.kind === "legacy" ? " --legacy" : ""} --repo ${row.repo}`,
      );
    } else if (row.kind === "legacy") {
      emit(
        c.verdict === "empty" ? "legacy-empty" : "legacy-layout",
        `agx ws gc --legacy --repo ${row.repo}`,
      );
    } else if (c.verdict === "empty") {
      emit("empty", `agx ws gc --include-unrecorded --repo ${row.repo}`);
    } else if (c.verdict === "landed") {
      emit("collectable", `agx ws gc --include-unrecorded --repo ${row.repo}`);
    }
    if (
      c.verdict === "unlanded" &&
      row.ageMs !== undefined &&
      row.ageMs > 72 * 60 * 60 * 1000
    )
      emit("unlanded-72h", `cd ${row.dir} && mise run land`);
  }
  return findings;
}

/** Discover from creation history, every run and optional machine policy. */
export async function gcAll(
  options: Omit<GcOptions, "repo">,
  _root?: string,
): Promise<Attempt<GcResult>> {
  const discovered = await discoverRepos();
  if (!discovered.ok) return discovered;
  const roots = discovered.value;
  const lines: string[] = [];
  const failed: string[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  const repositories: NonNullable<GcResult["repositories"]> = [];
  const broken: string[] = [];
  for (const [path, sources] of [...roots].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const started = performance.now();
    const repo = resolveRepo(path);
    if (repo.ok) requireJjTemplateVersion(["jj", "-T"]);
    process.stderr.write(`gc --all start ${path}\n`);
    const report = (outcome: string) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(3);
      process.stderr.write(
        `gc --all end ${path} elapsed=${seconds}s ${outcome}\n`,
      );
    };
    if (!repo.ok) {
      report("failure=unreachable");
      failed.push(path);
      repositories.push({
        root: path,
        sources: [...sources].toSorted(),
        status: "unreachable",
        counts: gcCounts([]),
      });
      continue;
    }
    seen.add(repo.value.backing);
    const done = await gc({
      ...options,
      includeMain: false,
      repo: repo.value.backing,
    });
    if (done.ok) {
      report(
        `rows=${done.value.lines.length}${done.value.complete ? "" : " failure=incomplete"}`,
      );
      repositories.push({
        root: path,
        sources: [...sources].toSorted(),
        status: done.value.complete ? "complete" : "incomplete",
        counts: done.value.counts,
      });
      lines.push(...done.value.lines);
      failed.push(...done.value.failed);
      broken.push(...done.value.broken);
      continue;
    }
    if (done.error instanceof LegacyWorkspaceConfigError) {
      report("failure=refused");
      refused.push(path);
      repositories.push({
        root: path,
        sources: [...sources].toSorted(),
        status: "refused",
        counts: gcCounts([]),
      });
      lines.push(`${path}\trepo\trefused\t?\t?\t${msg(done)}`);
      continue;
    }
    failed.push(path);
    report("failure=FAILED");
    repositories.push({
      root: path,
      sources: [...sources].toSorted(),
      status: "FAILED",
      counts: gcCounts([]),
    });
    lines.push(`${path}\trepo\tFAILED\t?\t?\t${msg(done)}`);
  }
  const discovery = {
    state: repositories.filter((repo) => repo.sources.includes("state")).length,
    record: repositories.filter((repo) => repo.sources.includes("record"))
      .length,
    L2: repositories.filter((repo) => repo.sources.includes("L2")).length,
    note: "unindexed historical repositories are not covered",
  };
  const result = {
    lines,
    failed,
    refused,
    repositories,
    discovery,
    counts: gcCounts(lines),
    broken,
    complete:
      failed.length === 0 &&
      broken.length === 0 &&
      refused.length === 0 &&
      repositories.every((repo) => repo.status === "complete") &&
      !lines.some((line) =>
        ["unknown", "broken"].includes(line.split("\t")[2] ?? ""),
      ),
  };
  if (!options.dryRun && failed.length === 0 && refused.length === 0)
    await publishVerdicts(undefined, result, seen);
  return good(result);
}

const Counts = z.object({
  total: z.number(),
  unlanded: z.number(),
  collectable: z.number(),
  legacy: z.number(),
});
const VerdictCache = z.object({
  fleetComplete: z.boolean().optional(),
  repos: z.record(
    z.string(),
    z.object({
      lines: z.array(z.string()),
      counts: Counts,
      capturedAt: z.number(),
    }),
  ),
});
/** One fixed, atomic owner output. Per-repo observations retain their own age. */
async function publishVerdicts(
  repo: string | undefined,
  result: GcResult,
  retained?: Set<string>,
): Promise<void> {
  const root = stateDir();
  const path = join(root, "workspace-verdicts.json");
  await mkdir(root, { recursive: true });
  const release = await acquire(
    path + ".lock",
    {
      pid: process.pid,
      host: hostname(),
      what: "publish workspace verdicts",
      since: Temporal.Now.instant().toString(),
    },
    { pollMs: 5, waitMs: 10_000 },
  );
  if (typeof release !== "function") return;
  const done = await attempt(async () => {
    const text = await Bun.file(path)
      .text()
      .catch(() => "");
    const parsed = jsonOf(VerdictCache).safeParse(text);
    const repos = parsed.success ? parsed.data.repos : {};
    for (const key of Object.keys(repos).filter(
      (candidate) => retained !== undefined && !retained.has(candidate),
    ))
      delete repos[key];
    if (repo !== undefined)
      repos[repo] = {
        lines: result.lines.filter(
          (line) => line.split("\t")[2] !== "collected",
        ),
        counts: result.counts,
        capturedAt: Temporal.Now.instant().epochMilliseconds,
      };
    const entries = Object.values(repos);
    const lines = entries.flatMap((entry) => entry.lines);
    const temp = path + "." + crypto.randomUUID() + ".tmp";
    await writeFile(
      temp,
      JSON.stringify({
        repos,
        fleetComplete:
          retained !== undefined ||
          (parsed.success && parsed.data.fleetComplete === true),
        rows: lines.map((line) => line.split("\t")),
        tsv: lines.join("\n"),
        counts: gcCounts(lines),
        capturedAt: Math.min(...entries.map((entry) => entry.capturedAt)),
        complete:
          result.complete &&
          !lines.some((line) => line.split("\t")[2] === "unknown"),
      }),
      { mode: 0o600 },
    );
    await rename(temp, path);
  });
  release();
  if (!done.ok)
    process.stderr.write("ws: cannot publish verdicts: " + msg(done) + "\n");
}

async function discoverRepos(): Promise<Attempt<Map<string, Set<string>>>> {
  const index = await indexedWorkspaces();
  if (!index.ok) return index;
  const registered = await registeredRepoPaths();
  if (!registered.ok) return registered;
  const records = await agxRecords(process.cwd());
  if (!records.ok) return records;
  const roots = new Map<string, Set<string>>();
  const addRoot = (path: string, source: string) => {
    const repo = resolveRepo(path);
    const root = repo.ok ? repo.value.backing : resolve(path);
    const sources = roots.get(root) ?? new Set<string>();
    sources.add(source);
    roots.set(root, sources);
  };
  for (const entry of index.value) addRoot(entry.root, "state");
  for (const path of records.value.flatMap((record) => [
    record.workspace,
    record.cwd,
  ])) {
    if (path === undefined || path === null || path === "") continue;
    const repo = resolveRepo(path);
    if (repo.ok) addRoot(repo.value.backing, "record");
  }
  for (const root of registered.value) addRoot(root, "L2");
  return good(roots);
}

export type HarvestFile = { path: string; bytes: number };
export type HarvestRun = {
  id: string;
  workspace: string;
  files: HarvestFile[];
  skipped: number;
  bytes: number;
};

/** Copy ordinary result files only; exclusive creation never overwrites earlier evidence. */
export async function harvest(options: {
  repo?: string | undefined;
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
}): Promise<Attempt<{ runs: HarvestRun[]; files: number; bytes: number }>> {
  if (options.all === true && options.repo !== undefined)
    return bad("--all and --repo cannot be combined");
  let roots: Attempt<Map<string, Set<string>>>;
  if (options.all === true) roots = await discoverRepos();
  else {
    const repo = resolveRepo(options.repo ?? process.cwd());
    if (!repo.ok) return repo;
    roots = good(new Map([[repo.value.backing, new Set<string>()]]));
  }
  if (!roots.ok) return roots;
  for (const root of roots.value.keys()) {
    const repo = resolveRepo(root);
    if (!repo.ok) return repo;
    const config = await readConfig(repo.value);
    if (!config.ok) return config;
  }
  const records = await agxRecords(process.cwd());
  if (!records.ok) return records;
  const runs: HarvestRun[] = [];
  for (const root of roots.value.keys()) {
    const done = await harvestRepo(
      root,
      records.value,
      options.dryRun === true,
    );
    if (!done.ok) return done;
    runs.push(...done.value);
  }
  return good({
    runs,
    files: runs.reduce((sum, run) => sum + run.files.length, 0),
    bytes: runs.reduce((sum, run) => sum + run.bytes, 0),
  });
}

async function harvestRepo(
  root: string,
  records: RunRecord[],
  dryRun: boolean,
): Promise<Attempt<HarvestRun[]>> {
  const repo = resolveRepo(root);
  if (!repo.ok) return repo;
  const config = await readConfig(repo.value);
  if (!config.ok) return config;
  const candidates = await workspaces(repo.value);
  if (!candidates.ok) return candidates;
  const rows: HarvestRun[] = [];
  for (const ws of candidates.value) {
    const done = await harvestWorkspace(ws.dir, records, dryRun);
    if (!done.ok) return done;
    rows.push(...done.value);
  }
  return good(rows);
}

async function harvestWorkspace(
  dir: string,
  records: RunRecord[],
  dryRun: boolean,
): Promise<Attempt<HarvestRun[]>> {
  if (!existsSync(dir)) return good([]);
  const lineage = lineageOf(records, realOr(dir));
  if (lineage.some((run) => !TERMINAL_STATES.has(run.state))) return good([]);
  const tracked = await jjOut(
    ["file", "list", "-T", 'path ++ "\\0"'],
    dir,
    true,
  );
  if (!tracked.ok) return tracked;
  const trackedPaths = new Set(tracked.value.split("\0").filter(Boolean));
  const rows: HarvestRun[] = [];
  for (const run of lineage) {
    if (run.state !== "ended" || !/^[a-zA-Z0-9_-]+$/u.test(run.id)) continue;
    const collected = await attempt(() => harvestPaths(dir, run, trackedPaths));
    if (!collected.ok) return collected;
    const copied = await attempt(() =>
      harvestRun(dir, run, collected.value, dryRun),
    );
    if (!copied.ok) return copied;
    if (!copied.value.ok) return copied.value;
    rows.push(copied.value.value);
  }
  return good(rows);
}

async function harvestPaths(
  dir: string,
  run: RunRecord,
  trackedPaths: Set<string>,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const pattern of run.writes ?? []) {
    const local = pattern.startsWith("/") ? relative(dir, pattern) : pattern;
    if (!local.startsWith(".agent-state/") || local.split("/").includes(".."))
      continue;
    for await (const path of new Bun.Glob(local).scan({
      cwd: dir,
      dot: true,
      onlyFiles: true,
      followSymlinks: false,
    }))
      paths.add(path);
  }
  for (const declared of [run.report_path, run.last_progress_path]) {
    if (declared === undefined || declared === null) continue;
    const local = relative(dir, resolve(dir, declared));
    if (
      local !== "" &&
      !local.startsWith("../") &&
      !local.split("/").some((part) => part === ".jj" || part === ".git")
    )
      paths.add(local);
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      trackedPaths.has(entry.name) ||
      [".git", ".jj"].includes(entry.name)
    )
      continue;
    const info = await lstat(join(dir, entry.name));
    const started = fromThrowable(
      () => Temporal.Instant.from(run.started_at ?? "").epochMilliseconds,
    )().unwrapOr(Number.NaN);
    const ended = fromThrowable(
      () => Temporal.Instant.from(run.ended_at ?? "").epochMilliseconds,
    )().unwrapOr(Number.NaN);
    if (Number.isFinite(started) && info.mtimeMs < started) continue;
    if (Number.isFinite(ended) && info.mtimeMs > ended) continue;
    paths.add(entry.name);
  }
  return paths;
}

async function harvestRun(
  dir: string,
  run: RunRecord,
  paths: Set<string>,
  dryRun: boolean,
): Promise<Attempt<HarvestRun>> {
  const row: HarvestRun = {
    id: run.id,
    workspace: dir,
    files: [],
    skipped: 0,
    bytes: 0,
  };
  const destination = join(stateDir(), "runs", run.id, "harvest");
  for (const path of [...paths].toSorted()) {
    const copied = await copyHarvestFile(dir, destination, path, dryRun);
    if (!copied.ok) return copied;
    if (copied.value === "skipped") row.skipped++;
    if (typeof copied.value !== "number") continue;
    row.files.push({ path, bytes: copied.value });
    row.bytes += copied.value;
  }
  return good(row);
}

async function copyHarvestFile(
  dir: string,
  destination: string,
  path: string,
  dryRun: boolean,
): Promise<Attempt<number | "ignored" | "skipped">> {
  const source = join(dir, path);
  if (!existsSync(source)) return good("ignored");
  const info = await lstat(source);
  if (!info.isFile() || (await realpath(source)) !== resolve(source))
    return good("ignored");
  const bytes = await readFile(source);
  const target = join(destination, path);
  if (existsSync(target)) {
    if (
      !(await lstat(target)).isFile() ||
      (await realpath(target)) !== resolve(target)
    )
      return bad(`unsafe harvest target: ${target}`);
    if (!bytes.equals(await readFile(target)))
      return bad(`harvest conflict: ${target}`);
    return good("skipped");
  }
  // Check every existing ancestor before mkdir/open; never write through a symlink.
  let parent = dirname(target);
  while (parent !== dirname(parent)) {
    if (existsSync(parent) && (await lstat(parent)).isSymbolicLink())
      return bad(`unsafe harvest parent: ${parent}`);
    parent = dirname(parent);
  }
  if (!dryRun) {
    await mkdir(dirname(target), { recursive: true });
    await using file = await open(target, "wx", 0o600);
    await file.writeFile(bytes);
  }
  return good(bytes.length);
}
