import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt, type Attempt } from "../../shared/src/attempt.ts";
import { validateSlug } from "../../shared/src/slug.ts";
import { readConfig, reportReadyPlan, type Config, type Repo } from "./config.ts";
import { enterStep } from "./deadline.ts";
import { recordWorkspace } from "./workspace-index.ts";
import { jjWorkspace } from "./jj-workspace.ts";
import { runStep, StepFailure } from "./subprocess.ts";
import { bad, checkGraveyard, common, exec, good, jjOut, legacyWorkspaceName, msg, removalGuard, resolveRepo, updateStale, withLock, workspaceNames, untrackMiseWorkspace, type Graveyard } from "./workspace.ts";

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
  remotes: string[],
): Promise<Attempt<string>> {
  if (/^[A-Za-z0-9_./-]+$/u.test(trunk)) return good(trunk);
  const result = await jjOut(
    [
      "log",
      "--no-graph",
      "-r",
      trunk,
      "-T",
      'bookmarks.map(|b| b.name()).join("\\n")',
    ],
    repo.backing,
    true,
  );
  if (!result.ok) return result;
  const name = result.value.trim().split("\n").find(Boolean) ?? "";
  // A bookmark name never carries its remote: name@origin is the remote-tracking copy of name.
  const remote = remotes.find((candidate) => name.endsWith(`@${candidate}`));
  return good(
    remote === undefined ? name : name.slice(0, -(remote.length + 1)),
  );
}

const short = (commit: string): string => commit.slice(0, 12);

/** Commit ids the local bookmark targets: none (absent), one, or several (conflicted). */
async function localTrunkCommits(
  repo: Repo,
  bookmark: string,
): Promise<Attempt<string[]>> {
  const result = await jjOut(
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
  return result.ok
    ? good(result.value.split("\n").filter((line) => line !== ""))
    : result;
}

async function remoteTrunk(
  repo: Repo,
  bookmark: string,
  remotes: string[],
): Promise<Attempt<{ ref: string; commit: string }>> {
  const local = await localTrunkCommits(repo, bookmark);
  if (local.ok && local.value.length > 1)
    return bad(
      `trunk bookmark ${JSON.stringify(bookmark)} is conflicted: it targets ${local.value.map(short).join(", ")}; resolve it with jj bookmark set ${bookmark} -r <commit> or pass --rev <commit> explicitly`,
    );
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
  const only = local.ok ? local.value[0] : undefined;
  const have =
    only === undefined
      ? "no local bookmark either"
      : `local ${bookmark} is ${short(only)}, not on any remote`;
  return bad(
    `no remote-tracking trunk bookmark found for ${JSON.stringify(bookmark)} on ${orderedRemotes.join(", ")} (${have}); fetch the trunk bookmark, push ${bookmark} to a remote, pass --rev explicitly, or set [ws].trunk in agx.toml`,
  );
}

type TrunkRelation = {
  kind: "same" | "ahead" | "behind" | "diverged" | "none";
  local: string | undefined;
};

async function trunkRelation(
  repo: Repo,
  bookmark: string,
  remote: { ref: string; commit: string },
): Promise<TrunkRelation> {
  const local = await localTrunkCommits(repo, bookmark);
  const only = local.ok ? local.value[0] : undefined;
  if (only === undefined) return { kind: "none", local: undefined };
  if (only === remote.commit) return { kind: "same", local: only };
  const nonEmpty = async (revset: string): Promise<boolean> => {
    const found = await jjOut(
      ["log", "--no-graph", "-r", revset, "-T", "commit_id"],
      repo.backing,
      true,
    );
    return found.ok && found.value.trim() !== "";
  };
  if (await nonEmpty(`${remote.commit} & ::${only}`))
    return { kind: "ahead", local: only };
  if (await nonEmpty(`${only} & ::${remote.commit}`))
    return { kind: "behind", local: only };
  return { kind: "diverged", local: only };
}

const write = (line: string) => process.stderr.write(`ws: ${line}\n`);

async function warnTrunkCopyDifferences(
  repo: Repo,
  bookmark: string,
  remote: { ref: string; commit: string },
  relation: TrunkRelation,
): Promise<void> {
  const { local } = relation;
  const both =
    local === undefined
      ? ""
      : `local ${bookmark} ${short(local)} and ${remote.ref} ${short(remote.commit)}`;
  if (relation.kind === "ahead")
    write(
      `${both}: local is ahead; basing on local ${bookmark} (push ${bookmark} to publish it)`,
    );
  if (relation.kind === "behind")
    write(`warning: ${both}: local is behind; using ${remote.ref}`);
  const gitCopy = await commitId(repo, `${bookmark}@git`);
  if (
    gitCopy.ok &&
    gitCopy.value !== "" &&
    gitCopy.value !== remote.commit &&
    gitCopy.value !== local
  )
    write(
      `warning: ${bookmark}@git ${short(gitCopy.value)} differs from ${remote.ref} ${short(remote.commit)}; using ${remote.ref}`,
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
    const bookmark = await trunkBookmark(repo, trunk, remotes);
    if (!bookmark.ok) return bookmark;
    if (bookmark.value === "")
      return bad(
        `cannot identify a bookmark for configured trunk ${JSON.stringify(trunk)}; set [ws].trunk in agx.toml to a bookmark name`,
      );
    const remote = await remoteTrunk(repo, bookmark.value, remotes);
    if (!remote.ok) return remote;
    const relation = await trunkRelation(repo, bookmark.value, remote.value);
    const name = bookmark.value;
    if (relation.kind === "diverged" && relation.local !== undefined) {
      const local = short(relation.local);
      const remoteShort = short(remote.value.commit);
      return bad(
        `trunk bookmark ${JSON.stringify(name)} has diverged: local ${name} ${local} and ${remote.value.ref} ${remoteShort} are not ancestors of each other; pass --rev ${local} to base on the local commit, or --rev ${remoteShort} to base on the remote, or move the local bookmark with jj bookmark set ${name} -r ${remoteShort}`,
      );
    }
    await warnTrunkCopyDifferences(
      repo,
      bookmark.value,
      remote.value,
      relation,
    );
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

export async function forgetAndBury(
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

/** Forget and atomically detach the checkout while the store lock is held. */
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

