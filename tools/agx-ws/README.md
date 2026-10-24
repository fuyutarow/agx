# agx-ws — `agx ws`

`tools/agx-ws/` is the sole owner of the run-workspace lifecycle: where a workspace lives, how it
is made ready, when it may be removed. Use `agx ws` or the `agx-ws` bin from the suite distribution. Repository behavior comes from jj and explicit policy.

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
agx ws gc  [--dry-run] [--include-unrecorded] [--legacy] [--abandoned] [--json] [--repo P | --all]
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
  patterns. Repeating refresh on a current workspace succeeds. It needs neither repo readiness
  configuration nor a graveyard, and uses the same store lock as the other verbs.
- **rm** — judges the workspace, then `jj workspace forget ws_<slug>` and `rip <dir>`. It refuses if
  any change reachable from the workspace's `@` is not reachable from trunk and is non-empty.
  The working copy is snapshotted first, so an uncommitted edit counts. Land or abandon the change
  first; there is no force flag.
- **gc** — one line per registered candidate: `path <TAB> kind <TAB> verdict <TAB> change id <TAB> age <TAB> reason`.
  `--dry-run` removes no workspace and checks the same initial preconditions as a real run. Inventory and initial
  classification use saved jj snapshots without locking, snapshotting or repairing stale
  workspaces. Untracked and ignored disk files are checked even in a dry run. Unsnapshotted tracked edits can change a dry-run verdict; collection always snapshots and
  re-checks the selected workspace under the lock before removal.

## gc: what is collected

Inventory comes from registered jj workspaces, excluding the main checkout. The standard
`<repo>.ws/ws_*` layout has kind `ws`; other registered layouts, including historical
`<parent>/<repo>-ws-*` and `<parent>/<repo>-arm-*`, have kind `legacy` and require `--legacy`.
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
unrecorded reason and need `--include-unrecorded`. Legacy rows use the separate `--legacy` permission.
Ordinary classification checks sparse patterns after keep, process, run and staleness checks.
Any set other than exactly `.` (including empty), or an unreadable set, keeps the workspace;
an earlier veto may supply the report reason instead. GC never widens sparse patterns.

`--abandoned` opts into abandoning a workspace whose local runs all ended with an outcome over
24 hours ago and whose lineage has no acceptance. This classification follows process, run,
staleness and sparse guards but precedes content comparison; it can discard unlanded rejected work.
Legacy layouts also need `--legacy`. Land-temporary checkouts use their separate land lock and
are retained when that lock is busy or uncertain. Removal holds the land lock when applicable.

Dry runs use saved snapshots and never take the exclusive store lock or create foreground waiter
markers; they can publish the verdict observation described below. Collection re-reads policy,
trunk, records and registration under a separate store lock for each removal and keeps changed
verdicts. Failed removal yields `FAILED`, preserves completed output, and exits nonzero.
JSON output is `{ rows, counts, complete }`, with rows as six-element string arrays. Counts exclude
`collected` rows; `collectable` counts `empty`, `landed` and `abandoned` classifications even when
an opt-in flag is absent. `--all` visits L2-registered repositories and cannot combine with `--repo`.

## Repo configuration: `.ws.toml`

A small repo-owned file at the backing store root. Every command, including add, adopt, rm,
gc and doctor, uses the main checkout's working `.ws.toml` when present, whether tracked or
untracked. Otherwise it reads `.ws.toml` from that checkout's `@-` revision. If neither
exists, defaults are no readiness commands, trunk `trunk()` and no keep entries. A config
in a secondary workspace does not override this rule. Read or parse failures are errors,
not a reason to fall back and silently lose keep protection. GC applies the same rule
again under the store lock before removal. To clear committed policy, leave an empty
working `.ws.toml`; deleting the working file selects the committed fallback.

```toml
ready = ["mise trust -q", "bun install --frozen-lockfile"]   # sh -c, in order, in the new workspace
trunk = "alpha"                                              # revset that defines "landed"
keep = ["ws_reference"]                                      # workspace names or paths to preserve
regenerable = [".cache/", "build/generated"]                    # optional literal paths whose disk content may be discarded
```

GC always treats real directories named `node_modules` at any depth as regenerable, matching readiness dependency installation. The optional `regenerable` list adds literal repository-relative file or directory paths (a trailing slash is optional); a directory entry includes its descendants. No glob expansion occurs. Absolute paths, empty components, backslashes, `.` and `..` components are rejected. An absent list adds no exceptions. Policy comes from the backing checkout under the same resolution and lock rules above; a candidate cannot declare its own content disposable.

Unknown keys are an error. This remains the active workspace policy; it is not retired by the shared ticket configuration reader.

## Invariants

- **Derived observations.** Decisions are derived from jj, `.ws.toml`, `agx worker ls --json` and the filesystem. Explicit GC, including dry runs, publishes `<state dir>/workspace-verdicts.json` atomically under its own publication lock when no removal failed. This is an observation, not lifecycle authority. The lock directory `<parent>/<repo>.ws.lock` is removed on release. Foreground
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
`~/.local/state/agx`. The legacy ledger is read-only at `<state dir>/legacy-v1/`.
Startup refuses retired state configuration and pending migration with exit 2 and guidance,
without moving data. `AGX_NEXT_STATE_DIR` is retired. Workspace discovery rejects retired
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
The old assertion that no state file is written is superseded by explicit verdict publication.

Legacy workspace adoption strips `<repository>-arm-` and `<repository>-ws-`
from directory names. Set `AGX_WS_LEGACY_PREFIX` to an additional literal prefix
(including its trailing separator) to adopt a consumer's older layout. Orphan
inventory includes that prefix only when jj confirms the workspace belongs to the
selected backing repository. Unset or empty means no additional prefix.
