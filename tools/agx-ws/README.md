# agx-ws — `agx ws`

`tools/agx-ws/` is the sole owner of the run-workspace lifecycle: where a workspace lives, how it
is made ready, when it may be removed. Use `agx ws` or the `agx-ws` bin from the suite distribution. Repository behavior comes from jj and explicit policy.

Template-based agx commands require jj 0.46.0 or newer. The version on PATH is checked before the first template call.

## Lifecycle guarantees

`add` creates the declared path and runs readiness. `rm` refuses unlanded work. GC derives
collection decisions from jj, run records and the filesystem, rechecking under a store lock.
Explicit GC observations publish a derived verdict inventory; there is no separate lifecycle ledger.
The fixtures live in `tools/agx-ws/tests/`. The detailed rules below describe the current implementation.

## Layout and naming

For a repo whose backing store is `<parent>/<repo>`:

| Thing                         | Name                             |
| ----------------------------- | -------------------------------- |
| workspace directory           | `<parent>/<repo>.ws/ws_<slug>`   |
| jj workspace name             | `ws_<slug>` (the directory name) |
| agx-worker worker (elsewhere) | `agt_<slug>`                     |

`--repo P` (default: the cwd) may be the main checkout or any workspace of the store; `agx ws` resolves
the backing store from jj's own metadata without invoking jj. Creation slugs are lowercase ASCII words separated by single hyphens. Refresh and removal also accept historical letters, digits, underscores and hyphens, starting with a letter or digit.

agx-ws and agx-worker compose by data and by names, never by a shared ledger: agx routes commands to the
parts, agx-worker consumes a tree through `--cd`, and `agx ws gc` reads `agx worker ls --json`.

## Verbs

```text
agx ws add <slug> [--rev R] [--repo P] [--reuse] [--json]
agx ws refresh <slug> [--repo P]
agx ws rm  <slug> [--repo P]
agx ws gc  [--apply | --dry-run] [--include-unrecorded] [--abandoned] [--json] [--repo P | --all]
```

- **add** — resolves `--rev` (exactly one commit), updates stale source/backing workspaces with
  `jj workspace update-stale`, runs `jj workspace add --name ws_<slug> [-r R]`, then checks the new
  workspace for staleness and sets `jj sparse set --clear --add .` before trust and each
  readiness command in order inside the new directory, in the foreground. Child stdin is ignored;
  output is streamed, with readiness stdout redirected to stderr for JSON mode. A failing readiness
  command preserves its exit code and attempts to forget and bury the new workspace; a failed rollback
  is reported with the path. A whole-command deadline can interrupt rollback. `--reuse` returns an
  existing registered workspace unchanged; it does not rerun readiness or widen sparse patterns.
- **refresh** — checks the named registered workspace with `jj status` and runs
  `jj workspace update-stale` only when jj reports `working copy is stale`. Other failures are
  returned without attempting repair. It does not run readiness, trust mise, or change sparse
  patterns. Repeating refresh on a current workspace succeeds. It requires valid shared
  repository policy, refuses a root `.ws.toml`, needs no readiness declaration or graveyard,
  and uses the same store lock as the other verbs.
- **rm** — judges the workspace, then `jj workspace forget ws_<slug>` and `rip <dir>`. It refuses if
  any change reachable from the workspace's `@` is not reachable from trunk and is non-empty.
  The working copy is snapshotted first, so an uncommitted edit counts. Land or abandon the change
  first; there is no force flag.
- **gc** — one line per registered candidate: `path <TAB> kind <TAB> verdict <TAB> change id <TAB> age <TAB> reason`.
  `--dry-run` removes no workspace and checks the same initial preconditions as a real run. Inventory and initial
  classification use saved jj snapshots without locking, snapshotting or repairing stale
  workspaces. Untracked and ignored disk files are checked even in a dry run. Unsnapshotted tracked edits can change a dry-run verdict; collection always snapshots and
  re-checks the selected workspace under the lock before removal.

To protect a workspace, set `keep = ["ws_<name>"]` under `[ws]` in the repository root
`agx.toml`, for example `keep = ["ws_reference"]`. Machine-local keep entries are unioned
from the matching L2 `[ws]` table. A config in a secondary workspace does not override this.

## gc: what is collected

Inventory comes from registered jj workspaces, excluding the main checkout. The standard
`<repo>.ws/ws_*` layout has kind `ws`. Registered workspaces outside the workspace root
are kept, including historical `<parent>/<repo>-ws-*` and `<parent>/<repo>-arm-*` paths.
Missing or foreign workspace directories are kept. Ordinary collection requires:

1. **Lineage is terminal.** The lineage is every `agx worker ls --json` record whose `workspace` or `cwd` lies
   inside the directory, closed over `continues` in both directions. Every record in it must have
   state `ended` or `orphaned`. Any other state, including a later run that continues an ended
   one, keeps the workspace.
2. **No live pid.** On Linux no process may have its cwd inside the directory (`/proc/*/cwd`); other
   platforms rely on agx state alone.
3. **Run judgment permits removal.** Continuations supersede their parents. Latest leaf runs
   are selected by timestamps; missing/invalid dates retain all leaves. Cycles and
   unjudged leaves keep the workspace. Rejected leaves do not require acceptance.
   Acceptance permits collection when the current workspace content has landed; run-end commit
   reachability is not required after squash or rebase integration.
4. **No irreplaceable disk content.** Before any removable verdict (including abandoned and land-temporary checkouts), GC compares a filesystem walk with jj's saved tracked-file inventory. It excludes `.jj`/`.git` metadata and regenerable paths. Any remaining untracked or ignored file keeps the workspace with `untracked content: N files (path, ...)`, naming up to five paths. The count includes symlinks and other non-directory entries; directory symlinks are never followed. Inventory read errors or timeouts yield `unknown`, prevent removal and make JSON/cache coverage `complete: false`. The jj listing and filesystem walk each have a 10-second deadline. The same guard runs again under the removal lock for every layout and collection mode.
5. **Nothing unlanded.** Ordinary GC compares the current workspace working-copy commit chain against
   trunk content, including changesets consumed by a release and matching historical release
   snapshots. Recorded `end_commit` values do not retain obsolete content superseded by a
   continuation in the same workspace. Differing paths are named in the keep reason; failed
   comparisons also keep the workspace. Accepted work with a real unlanded diff must be landed
   or explicitly rejected before collection. `rm` instead uses
   nonempty ancestry outside configured trunk. Collection refreshes stale workspaces and
   snapshots/rechecks under the lock immediately before removal.

A standard workspace with no agx record is **unrecorded**: otherwise collectable rows carry an
unrecorded reason and need `--include-unrecorded`.
Ordinary classification checks sparse patterns after keep, process, run and staleness checks.
Any set other than exactly `.` (including empty), or an unreadable set, keeps the workspace;
an earlier veto may supply the report reason instead. GC never widens sparse patterns.

`--abandoned` opts into abandoning a workspace whose local runs all ended with an outcome over
24 hours ago and whose lineage has no acceptance. This classification follows process, run,
staleness and sparse guards but precedes content comparison; it can discard unlanded rejected work.
Land-temporary checkouts use their separate land lock and
are retained when that lock is busy or uncertain. Removal holds the land lock when applicable.

Dry runs use saved snapshots and never take the exclusive store lock or create foreground waiter
markers; they can publish the verdict observation described below. Collection re-reads policy,
trunk, records and registration under a separate store lock for each removal and keeps changed
verdicts. Failed removal yields `FAILED`, preserves completed output, and exits nonzero.
JSON output is `{ rows, counts, complete }`, with rows as six-element string arrays. Counts exclude
`collected` rows; `collectable` counts `empty`, `landed` and `abandoned` classifications even when
an opt-in flag is absent. `--all` visits L2-registered repositories and cannot combine with `--repo`.

## Repository policy: `agx.toml`

All workspace commands use the shared configuration reader. L1 comes from the repository
root's committed `agx.toml` at `trunk()`. Its `[ws]` table accepts `ready`, `trunk`, `keep`
and `regenerable`. L2 lives in `$XDG_CONFIG_HOME/agx/repos/<name>.toml` and identifies its
main checkout with `root = "<absolute path>"`; its `[ws]` table may set `ready` and `keep`.
L2 `ready` replaces L1 `ready`; L2 `keep` is unioned with L1 `keep`. `trunk` and
`regenerable` are L1-only. Unknown keys and invalid values fail closed. A secondary
workspace's own `agx.toml` does not override the main checkout's policy.

```toml
schema = 1

[ws]
ready = ["mise trust -q", "bun install --frozen-lockfile"]
trunk = "alpha"                                  # revset that defines "landed"
keep = ["ws_reference"]                          # workspace names or paths to preserve
regenerable = [".cache/", "build/generated"]     # literal file or directory paths
```

GC and doctor inventory always treat real directories named `node_modules` at any depth as
regenerable. `[ws].regenerable` adds literal repository-relative paths; a trailing slash is
optional and a directory entry includes its descendants. No glob expansion occurs. Absolute
paths, empty components, backslashes, `.` and `..` components are rejected. These patterns
filter the existing untracked-content inventory used by GC and doctor; `rm` gains no separate
untracked-content guard.

A repository root that still has `.ws.toml` is refused by each agx-ws command with exit 2 and
one stderr line. The line includes the exact `[ws]` table equivalent for copying into
`agx.toml` and says to delete `.ws.toml`. `gc --all` emits one refused row for that repository
and continues with the others. The file is inspected only to produce this refusal diagnostic;
it is never used as workspace policy.

When `trunk` is absent and jj's `trunk()` resolves to `root()`, agx checks local
bookmarks named `alpha`, `main`, `master` and `trunk`, in that order. Exactly one
candidate is used as trunk, which supports repositories without a remote. The count
is bookmark names, even when several point to the same commit. With zero or multiple
candidates, GC retains its `no trunk` classification and the dry-run reason names
the missing setting and an exact `[ws].trunk` line to add to `agx.toml`. A conflicted
or root-pointing candidate cannot provide a usable trunk. Explicit settings and
`trunk()` resolving to a real commit take precedence. Dry-run workspace reasons
include `trunk source`, without changing the six-column TSV or JSON row shape.

## Invariants

- **Derived observations.** Decisions are derived from jj, shared `agx.toml` policy, `agx worker ls --json` and the filesystem. Explicit non-dry GC publishes `<state dir>/workspace-verdicts.json` atomically under its own publication lock when no removal failed. This is an observation, not lifecycle authority. The lock directory `<parent>/<repo>.ws.lock` is removed on release. Foreground
  waiters advertise transient intent in the adjacent `.ws.lock.waiters/` directory, cleaned on
  completion; dead local waiter entries are discarded by GC.
- **One lock per backing store**, shared by mutating verbs (`tools/shared` dir-lock; a dead holder's
  lock is taken over). GC classifies without it, then acquires it separately for each removal,
  refreshing config, trunk, run records and workspace registration before judging again. GC skips
  busy stores and yields to advertised foreground waiters, so another removal cannot jump ahead
  of a waiting add. Dry runs never acquire it. Other commands wait, reporting holder and elapsed
  time every five seconds, then refuse after fifteen minutes; the holder is never killed.
- **Foreground and loud.** Every failure is a `ws: …` line on stderr and a non-zero exit.
- **Bounded subprocesses.** Every workspace subprocess, including jj, has a 900,000 ms deadline and can be killed with SIGKILL. Add also has a whole-command deadline, default 900,000 ms, overridden by positive integer `WS_ADD_TIMEOUT_MS` up to 2147483647. Deadline failures exit 124 and name the step. Read-only probes use `--ignore-working-copy`; Git ref locks are named and refused, never removed.
- **Removal is `rip`, never `rm`.** `add`, `rm` and `gc` refuse when the graveyard (`RIP_GRAVEYARD`,
  else `GRAVEYARD`, else `$XDG_DATA_HOME/graveyard`) is on tmpfs/ramfs or its filesystem cannot be read.
- Preconditions (`jj` and `rip` on PATH, valid slug and config, repo resolves, `agx` works for gc,
  graveyard disk-backed, target absent for add / present and registered for rm) are all checked
  before the first mutation.
  Refresh uses only the applicable subset described above.

State uses non-empty `AGX_STATE_DIR`, otherwise non-empty `XDG_STATE_HOME` plus `/agx`, otherwise
`~/.local/state/agx`. Workspace discovery rejects retired
`AGX_DOCTOR_HOME` and `AGX_DOCTOR_WORKSPACE` in favor of `AGX_REPOS_ROOT`.

## Interface with agx-worker

`agx ws gc` needs from each `agx worker ls --json` record: `id`, `state`, `workspace`, `cwd`, `continues`, and
optionally `end_commit` (the commit id of the run's working copy when the run ended). Landing is
judged from the current `@` chain even when a historical `end_commit` is present. The agx-worker
scope row for workspaces should read: "agx-worker consumes a tree via `--cd`; creating, readying and
collecting trees is `agx ws` (`tools/agx-ws`)".

## Retained design and fixture expectations

The original lifecycle propositions remain useful fixture goals with the implementation limits
stated above: add should either return a ready workspace or report failed rollback; refresh should
repair only staleness; creation should set sparse patterns to exactly `.`; collection should retain
live or continuing lineages and work the selected collection mode does not authorize discarding.
Lock-scope fixtures must show that slow classification does not hold up foreground creation for an
entire GC pass, and that changed removal inputs are checked again under the store lock. Waits over
five seconds must identify the holder's command, pid, host, start time and elapsed seconds.
A dry run writes no state file, neither the verdict observation nor the classification order; the read-only dry-run fixtures assert this (CHANGELOG 1.10.1: "Keep workspace gc dry-runs read-only with unwritable repository parents and state directories").

`gc --all` discovers repositories from the append-only
`$AGX_STATE_DIR/workspace-index.jsonl` creation history, every run's workspace
and cwd via `agx worker ls --all --json`, and optional machine-local L2 files.
`add` (including `--reuse`) records the repository root and workspace path;
no manual repository registration is needed. Each discovered repository's
sibling `<root>.ws/` is also inspected, admitting only local jj workspaces
belonging to that repository. Existing GC protection rules still apply.

Text output includes a discovery summary and a repository row with its sources
(`state`, `record`, `L2`), status and workspace counts. JSON output adds
`repositories` and `discovery` alongside the existing workspace `rows` and
`counts`. Counts describe classified workspaces, excluding repository summary
rows; source counts describe distinct repositories and can overlap. Unreachable
roots have zero inspected workspaces, are reported explicitly, cause a nonzero
exit, and are never collected. Unindexed historical repositories outside all
three sources are not covered; the discovery summary states this limitation.

Worker results belong in `$AGX_RUN_DIR`, not the workspace. GC can collect a
workspace immediately, without `--abandoned`, when every run in its lineage is
judged reject, no source changes remain unlanded, and there are no unpreserved
untracked files. For existing results, copy each file to
`<its-run-directory>/results/<workspace-relative-path>` before collection. GC
compares the bytes and refuses missing, changed or symlink copies. It does not
infer preservation from a result-like filename or copy files itself.
Live processes/runs, conflicts, unjudged runs, unlanded changes, keep declarations,
and other untracked content retain their protections. Dry-run rows retain the existing `empty` or `landed` labels and landing evidence,
and append `all runs judged reject; remaining results preserved in run directories
(...); no age wait`. `collectable` counts classified candidates; layout and
explicit opt-in rules still govern collection.

## Preserving ended-run results

Before removing a selected workspace, GC copies ordinary files from ended runs’ `.agent-state/` write globs, workspace-local report and progress paths, and eligible untracked root files to the corresponding run directory under `harvest/`. Identical copies are retained; conflicts and copy failures keep the workspace. The GC row names the recovery directory. Existing selection and keep protections still apply.

GC remembers when it last classified each workspace, so a subsequent run starts
with candidates deferred by the repository time budget. Deferred workspaces are
kept and reported. A large jj operation store is reported separately; GC does not
modify it. Classification history is stored in the agx state directory.
