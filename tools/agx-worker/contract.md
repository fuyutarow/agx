# agx-worker CLI contract

`agx-worker` owns worker runs. Its package bin points to `src/next/cli.ts`. The suite also accepts `agx worker`.

| Command                                                                                        | Purpose                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agx worker run TICKET [--cd TREE] [--sandbox MODE] [--continue RUN_ID] [--session ID]`        | Route a ticket to a roster worker, run it, and append run records.                                                                    |
| `agx worker check TICKET [--cd TREE]`                                                          | Validate a ticket and its premises without starting a worker.                                                                         |
| `agx worker ls [SELECTOR] [--workspace PATH] [--json]`                                         | List runs and judgments; SELECTOR is a run id, unique run-id prefix, or exact ticket name. Ticket selections put the newest run last. |
| `agx worker judge RUN_ID accept\|reject [--note TEXT]`                                         | Append an acceptance or rejection judgment.                                                                                           |
| `agx worker stats [--import-legacy\|--routing\|--usage jev] [--window DURATION] [--host NAME]` | Report run counts, import legacy records, routing statistics, or Jev token usage.                                                     |
| `agx worker probe --vendor codex --sandbox MODE --cd PATH --timeout-ms N --json`               | Run a bounded vendor diagnostic without a ticket or run record.                                                                       |
| `agx worker dispatch TICKET [--ws SLUG] [--unit NAME] [--continue RUN_ID]`                     | Obtain a workspace through `agx ws`, or reuse a continuation's recorded workspace, and start a durable worker unit.                   |
| `agx worker roster TICKET`                                                                     | Print one selected roster row. `roster --json` prints the full validated roster and routing objective.                                |
| `agx worker doctor`                                                                            | Diagnose worker records as tool/object/finding/remedy JSON Lines.                                                                     |

The top-level `objective` field in `roster --json` is the routing objective text used to select workers; the per-ticket `roster TICKET` output remains one selected row.

## Sandbox capability preflight

`check TICKET --cd TREE [--sandbox MODE]`, `run`, and dispatch's check emit
advisory `WARN sandbox` lines on stderr before worker startup. A warning does not
change the exit status, requested sandbox, sandbox provenance, or launch arguments.
Dispatch forwards successful check stderr before starting the worker unit.
`none` suppresses these restricted-sandbox warnings. No detector executes a verify
command, contacts systemd, runs a declared tool, writes VCS metadata, or upgrades
the sandbox.

Each warning contains `capability`, `requested`, JSON-quoted `evidence`,
`allows=none` with an explicit unsandboxed explanation, and `sandbox unchanged`.
One user-bus warning is emitted per matching verification entry. One external-store
warning is emitted per distinct canonical store path, with writes and VCS verify
evidence (or an explicit empty-writes qualification).

`user-systemd-bus` detects literal `systemctl` or `systemd-run` commands followed
by `--user`, and the known `agent-resource-run` wrapper, in ticket `verify` and
repository `[verify].always`. `external-vcs-store-write` resolves the nearest
workspace/ancestor `.git` directory or gitdir file, its `commondir`, and `.jj/repo`
directory or relative repo pointer, following symlinks. A store outside canonical
`--cd` warns even when writes is empty. A shared store may need writes for VCS
operations that do not change tracked files.

Detection is conservative static inspection. It does not expand aliases, inspect
arbitrary scripts or nested task definitions, infer unknown tool requirements,
certify host bus availability, or model vendor-specific writable roots and host
declarations. Quoted/commented commands may warn; absent warnings do not certify
capability. The operator chooses any different sandbox explicitly. Acceptance
coverage lives in `tests/next/sandbox-needs.test.ts`, `tests/next/preflight.test.ts`
and `tests/dispatch.test.ts`, using disposable filesystem pointers and fake launchers.

`agx worker stats` emits one JSON object without requiring `--json`. Its additive
`legacy_land` field is the public legacy landing presence contract (C4):

| `present` | `status`    | Meaning                                                                                                                                          |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `true`    | `"present"` | A `land` entry exists, including an empty directory. Keep the legacy landing refusal until separate owner migration evidence permits retirement. |
| `false`   | `"absent"`  | The state directory or its `land` entry is confirmed absent. This observation does not certify that migration completed.                         |
| `null`    | `"refused"` | State inspection is unavailable; presence is unknown. Refuse the dependent operation.                                                            |

Every variant includes a nonempty `reason` string for diagnostics; consumers branch on
`status` and `present`, not the wording of `reason`. The owner resolver selects
`AGX_STATE_DIR`, then `XDG_STATE_HOME/agx`, then `~/.local/state/agx` (empty variables
fall through). The probe lists that directory without parsing landing journals; any
entry named `land`, including a file or symlink, conservatively counts as present.
Unreadable directories, dangling state symlinks, non-directory state paths and other
inspection errors produce only `{"legacy_land":{"present":null,"status":"refused","reason":"..."}}`
on stdout and exit 2, before importing or reading run records. Successful presence
inspection retains the existing stats fields and exit behavior. Existing retired
state-variable and required state-migration diagnostics still refuse on stderr with
exit 2 before stats runs.

Ordinary stats creates, renames, deletes and rewrites no state files, and performs
no migration. `--import-legacy` retains its explicit run-record import behavior;
it neither migrates landing state nor proves its migration. Consumers need no
private path or file-format knowledge. This field follows the worker CLI's package
version and compatibility policy; further object fields may be added compatibly.

## Legacy judgments

For shell and machine consumers, `agx worker stats --import-legacy` is the explicit
owner mutation that imports history. It emits one JSON object on stdout, including
`legacy_import`. Plain `stats` and `ls --json` never import or modify state.
`agx worker ls --json --all` exposes the canonical imported runs and judgments;
consumers need no journal reader. These additive fields follow the worker package
version; consumers must tolerate additional JSON fields.

The importer reads `<state>/legacy-v1/runs.jsonl`, `lifecycle.jsonl`, and dated
`runs-YYYY-MM-DD.jsonl` and `lifecycle-YYYY-MM-DD.jsonl` archives. It never changes
these source files. Run rows (`kind=run`) establish run identity. Acceptance rows
(`kind=acceptance`, boolean `accept`), landing rows (`kind=landed`), and lifecycle
rows (`type=judged`, `decision=accept|reject|landed`) become judgment events.
`landed` means `accept`. Existing `kind=judged` rows are also accepted. Interim
rows retain their progress import behavior; grades and other lifecycle types are
ignored. Judgments require an ISO 8601 `at` with UTC or an explicit offset.

Every non-null listing `judgment` contains `decision`, `note`, and `at`, including
current judgments and history imported before this extension. The latest instant
wins across all sources, regardless of archive date, file order, import time, or
canonical log position. Equal instants use these rules:

- A current judgment wins over an imported judgment.
- Between imported judgments, the lexicographically greater `legacy_key` wins.
  This stable owner-generated key is included in imported listing judgments;
  consumers compare the resulting judgment rather than reconstructing keys.
- Between current judgments, the later canonical log event wins.

Imported runs expose `legacy: {run_id, source: "legacy-v1"}` alongside canonical
`id`, `workspace`, `ticket`, and start/end timestamps. Original run IDs share one
namespace across legacy files; the canonical ID is `legacy-` plus the first 24
hexadecimal characters of SHA-256 of the original UTF-8 run ID. Re-import and
archive relocation preserve this mapping. Current runs omit `legacy`.

`legacy_import.runs_imported` counts newly imported run identities;
`judgments_imported` and `progress_imported` count newly appended events.
Repeated rows with the same event identity, including copies in multiple archives,
append once. Re-importing unchanged history returns zero for these three counters
and leaves `runs` and `judgments` unchanged. The top-level `judgments` counts all
stored judgment events, including superseded ones, rather than judged runs.
`malformed_lines` counts invalid JSON/non-object lines and recognized judgments
with an invalid timestamp or decision. `ignored_rows` counts unsupported rows,
rows without a usable kind/run ID, and events without an imported run. Both scan
counters recur on re-import. An orphan event can import after its run appears.

Successful scans exit 0, including scans with malformed/ignored source rows;
these counters expose partial source coverage. Usage/state migration refusals
exit 2; a corrupt canonical log exits 1 with a stderr diagnostic. Import writes
are append-only and may be partial if interrupted; retry resumes using stable
event keys. The legacy landing refusal described above still applies before import.

Real CLI fixtures: `tests/next/legacy-judgments.test.ts` covers archive chronology,
late discovery, equal-time ties, source duplication, identity, timestamps, counts,
malformed rows, and read-only listings/stats.

## Tickets and dispatch

Tickets are caller-owned files. `agx worker run` accepts positional ticket paths and optionally a working
tree and sandbox mode. A continuation uses the previous run ID and resumes its vendor session,
except for the capacity recovery described below.

Sandbox resolution is `--sandbox` > ticket `sandbox` > continued run's recorded
sandbox > built-in `workspace-write`. An explicit flag overrides the ticket even
on continuation. Without a flag or ticket declaration, `--continue` inherits the
requested mode (for example `none`), rather than a vendor's effective fallback
(for example `danger-full-access`). Older runs are read from their saved native
receipt when their started event omits sandbox; if neither records it, the built-in
default applies. Invalid recorded sandbox data refuses resolution unless a flag
or ticket supplies the value. Repository L1/L2 and routing L3 do not configure sandbox.

Dispatch uses the same resolution and passes the selected value to the unit with
its provenance (`--sandbox-source`, an internal run argument requiring a dispatch
binding). Run receipts, saved native receipts, reports, started events and JSON
listings expose `sandbox` and `sandbox_source`. Source values are `flag`, `ticket`,
`continued run`, and `built-in default`. Historical events may omit these fields.

`dispatch --continue RUN_ID` uses that run's recorded `workspace` path, falling back to
`cwd` when `workspace` is absent or empty. Both preflight and the durable worker receive
that path and the unchanged continuation ID, preserving the ordinary vendor-session resume.
The ticket-derived default workspace is not used, even when the prior run used another
`--ws` slug or `run --cd` path. Dispatch never invokes `agx ws add` for a continuation.
An explicit `--ws` must name the recorded workspace (`ws_<slug>`); a different name exits 2.
The recorded path must exist as a directory and be a registered workspace of the ticket's
repository. A missing, unusable or unregistered path exits 2 before starting a worker,
with one diagnostic line naming the recorded path, reason and repair: restore/register
that path with `agx ws add`, or start a fresh run. Registry inspection timeouts retain
temporary-unavailability exit 75.

Dispatch starts the exact running worker: a compiled executable uses the absolute
`process.execPath`; a source invocation uses the absolute Bun executable followed by the
absolute source entry path. Preflight `check`, run-list inspection, and the default internal
Codex/Claude child worker use the same invocation. Explicit `AGX_WORKER_BIN` and
`AGX_WORKER_COMMAND` overrides retain their existing meaning.

The unit receives `--setenv=PATH=<dispatcher's PATH>` and
`AGX_WORKER_PATH_SOURCE=dispatcher`. Missing or empty dispatcher PATH refuses with exit 2
and one diagnostic line before workspace creation or unit launch. The dispatched run,
its worker, and verification preserve that PATH without repository mise environment
resolution or added link directories. Suite utilities such as `agx-ws` and `xmsg` resolve
through the supplied PATH. No bare worker-name fallback is used. The final JSON receipt
and saved report include `execution.executable_path`, `execution.executable_argv`, and
`execution.path_source: "PATH from dispatcher"` (direct runs say `"PATH from caller"`).

Run events, progress, and judgments are stored in one append-only `records.jsonl` file. The state
directory resolves from non-empty `AGX_STATE_DIR`, then non-empty `$XDG_STATE_HOME/agx`,
then `~/.local/state/agx`. Legacy ledgers are read only from `<state>/legacy-v1`.
Every worker command refuses `AGX_NEXT_STATE_DIR`, even when empty, with exit 2 and
`agx: AGX_NEXT_STATE_DIR is retired; use AGX_STATE_DIR`. If the resolved state directory
is missing but `<base>/agx-next` exists, startup refuses with exit 2 and prints:
`mv <base>/agx <base>/agx.legacy-v1.tmp && mv <base>/agx-next <base>/agx && mv <base>/agx.legacy-v1.tmp <base>/agx/legacy-v1`.
Here `<base>` is non-empty `XDG_STATE_HOME` or `~/.local/state`. The CLI never moves data.

Local judgments and graded run summaries remain audit data and do not enter the Jev request or
deterministic fallback ranking. Selection uses the ticket, roster evidence, explicit route and
capability policy, live quota availability, and operational capacity guards.

Use `agx worker ls --json` as the machine-readable view. Its rows include the run ID, ticket, state,
workspace, selected roster row, write globs, judgment, report path, progress path, and continuation
metadata. External acceptance and landing tools consume this public view; their policies and
deployment belong to the consumer repository.

Every ordinary `ls --json` row (including selector, `--all`, `--running`, `--wait`, workspace
and `--summary` run rows) includes `progress`, `progress_source`,
`progress_status`, and `progress_fresh_at`. The separate `--ticket --latest`
receipt projection is unchanged.

`progress` is null or `{last, at, commands, files, turns, usage, usage_reason,
cost_usd, cost_reason, session}`.
Commands count observed command invocations; files count distinct paths in observed
edit events, and turns carry the worker tally's vendor turn count. These are cumulative within
the worker invocation, not a repository diff or session lifetime total. Optional
turns, usage, cost and session are explicitly null when unreported. Usage retains
the reported token fields; absent token fields are unknown, not zero. Reported
zeros remain zero. `session` is the vendor worker identity, never the dispatcher.

When progress is null, the row's `progress_reason` explains a missing sink,
invalid record, or unreadable record; otherwise it is null. Missing sinks can
mean an older producer predates the sink or no event has arrived. Listing cannot
distinguish these causes from file absence alone. In particular, a run launched
by an older binary need not acquire progress merely because the reader is upgraded.
When `usage` or `cost_usd` is null, `usage_reason` or `cost_reason` respectively
explains the absence; each reason is null when its value is available. Empty usage
objects count as unreported. Partial usage preserves only reported token fields;
it does not invent zero counts. Cumulative fields sum the values actually reported,
so omitted fields do not certify a complete total for every event.

| Vendor route | When usage becomes known                                                                                                               | When cost becomes known                                                                                                                                                                                          | Wrapper evidence                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codex        | At each `turn.completed` event carrying usage; cumulative across those events. Command/file events do not carry usage into this tally. | The live writer estimates cost once reported input/output usage and selected prices are available. During an unfinished first turn, cost is unknowable; a prior completed turn's estimate excludes current work. | [foldEvent, `turn.completed` branch](src/workers/codex-progress.ts), [codex live stdout reader and `progress.feed`](src/workers/codex.ts)                |
| claude       | On each `assistant` event with top-level or message usage. A `result` event with usage replaces the event sums with final totals.      | The live writer can estimate from reported input/output usage and prices. Reported `total_cost_usd` from `result` takes precedence over the estimate.                                                            | [foldClaudeEvent, `assistant` and `result` branches](src/workers/claude-progress.ts), [runClaude, `feed` and `progress.feed`](src/workers/run-claude.ts) |

Both routes use [progressWriter](src/workers/codex-progress.ts) to atomically
replace the sink while reading stream events and to flush on exit. Publication is
event-driven: command/usage changes write immediately; other events write after
the throttle interval. This does not promise a timer-driven update while silent.
`cost_reason` means no reported cost and no estimate is available; listing does
not infer whether usage or price configuration is responsible from an absent cost.

| Field               | Meaning                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `progress_source`   | `"run"` for the current run's cumulative record, `"active"` for the older active progress record, or null when neither exists. |
| `progress_status`   | `"available"`, `"missing"`, `"invalid"` (JSON, shape, or timestamp), or `"unreadable"` (I/O failure other than missing).       |
| `progress_fresh_at` | Valid progress record's `at`, or null. This is the writer's observation time, not listing time or a freshness guarantee.       |

The current run record takes precedence; only a missing current record permits
the older active record fallback. Invalid or unreadable progress is null with
its source and status retained; it does not fail the listing or fabricate counts.
An old timestamp is returned unchanged so consumers can apply their own age
limit. Quiet workers need not update continuously. Records are read independently
of the run fold, so concurrent updates can produce observations from different
instants. No last-good cache is substituted after a read failure.

Only canonical runs appear: active markers do not create extra rows. For running
rows, `vendor_session` prefers progress `session`, then a matching active marker's
worker session, then the canonical run's recorded vendor session. Marker identity
must match run ID, process ID and working directory. `dispatcher_session` always
retains the canonical dispatching session. Ended rows retain their recorded vendor
session. Current progress retained after exit can still be shown; older active
records are normally removed at exit. Imported historical runs without cumulative
progress return null/missing; listing does not import or reconstruct counters.

`last_progress_path` keeps its existing meaning: the saved interim-return artifact,
not the cumulative progress record. It is independent of inline `progress` and
must not be used to discover live counters. The progress source labels describe
coverage, not public file paths; consumers use CLI JSON. New JSON fields are
additive and consumers must tolerate unknown fields/source or status values in
future releases. Existing listing exit semantics are unchanged.

`ls --workspace PATH` compares real absolute paths, including symlink resolution. A missing or
unresolvable path exits 2 with one diagnostic line. It combines with `--json`, `--all`,
`--running`, selectors and `--summary`; it cannot combine with `--latest` or `--wait`.
Filtering happens before the human output limit and running counts. JSON run objects retain
the ordinary listing fields and observation-time elapsed values.

The owner publishes complete per-workspace folds under `workspaces/<sha256-of-real-path>.json`
alongside `current-runs.json`. These include all ended runs and running runs, without an age
cutoff. A workspace read validates the log's device, inode, size, modification time and change
time using metadata, then reads only that workspace's fold and rechecks liveness with the
ordinary listing producer. Its work scales with the selected workspace's runs and output,
not the number of historical records or runs in other workspaces. Missing publications
(including those from older writers), invalid publications and stale log identities trigger
the existing replay path with an explicit stderr diagnostic. Listing does not write or repair
publications. The next owner publication produces them; rollout must update that writer.

Owner publication, including the on-demand `agx worker doctor` command, reconciles lost
runs. Under the publication lock and the run's workspace lock, it replays records and
rechecks pid/start and unit liveness before appending exactly one `ended` event with
outcome `lost`, the observed loss evidence, and `at` set to that locked observation time.
A busy workspace is skipped until a later publication. An active unit or a live pid with
a matching start prevents reconciliation. Existing records are never rewritten.
After reconciliation, `ls --json --all` exposes a non-null `ended_at` and fixed
`elapsed_seconds` for the lost run. Before an owner publication, read-only listing can
still report derived loss with a null `ended_at`; run `agx worker doctor` to record it.
Liveness always comes from pid/start and unit observations, never a missing end record.
In-process full and incremental fold readers wait for already scheduled owner
publication before reading. Publication uses its internal replay path to avoid
waiting on itself; a read never schedules publication.

External acceptance tools can compose the selected latest run's verification exits and report
with a workspace diff. A human or coordinator decides acceptance and records it with
`agx worker judge`; landing and publication remain the consumer repository's responsibility.
The standalone suite does not provide an acceptance script or landing task.

See [Worker environment, version 1](#worker-environment-version-1) for dispatcher identity,
worker markers, inheritance, and operational environment variables. Use
`agx worker dispatch TICKET.md` to construct the durable unit.

## Worker environment

The vendor wrapper removes inherited native session variables and clears inherited
`AGX_MSG_FROM`, even though other `AGX_*` configuration is forwarded. Dispatcher
session metadata identifies the coordinator and never declares the worker's sender.

For a fresh Claude process the wrapper generates a UUID, passes it through
`--session-id`, and explicitly sets `AGX_MSG_FROM=claude:<full-UUID>` in that
vendor process's environment. On Claude or Codex resume, it declares the full UUID
supplied to resume. A non-UUID resume selector is not converted or guessed.
Fresh Codex thread IDs are learned after spawn, so no declaration is installed
for them. The generated brief tells these workers to pass
`--from codex:<full-thread-UUID>` using the current thread ID reported by the vendor,
or leave sender unknown when that ID is unavailable. Native inherited IDs, cwd,
inventory, transcript order and the dispatcher address are not substitutes.

`agx worker run` exports its own `AGX_RUN_ID` at the worker spawn boundary,
replacing an inherited run ID. Vendor wrappers forward that run ID. With neither
explicit sender declaration, agx msg uses the existing run reader and live progress
projection to resolve that exact run's `route` and full `vendor_session` UUID.
Missing runs, missing sessions, unsupported routes and non-UUID sessions remain unknown.

agx msg chooses `--from` > explicit `AGX_MSG_FROM` > recorded run sender > unknown, validates the selected
declaration before transport, and never infers native session identity. Its envelope's
`from:` line is authoritative caller attribution, not authentication. Claude's
visible from-name describes the relay transport, named
`agx msg relay from <declared sender or unknown>`. A worker spawning another agent
must clear or replace its own declaration; environment inheritance is not proof
of that agent's identity.

Harness VCS reads in premise checks, official-execution tracking and repo-retrieve run inside
OS-enforced write denial before jj/Git starts: Landlock ABI >=3 on Linux x64/arm64 and
`sandbox-exec` on macOS. An unavailable boundary fails closed. CLI read flags alone do not
prevent backend metadata writes. See [the call-site and patch inventory](docs/ref-writer-inventory.md).

The dispatcher does not detach, amend, or create ticket stores and does not run a pre-dispatch
grader. `agx worker run` records an interim return as progress and continues the worker until completion or
its timeout. After the worker exits, effective `[verify].always` commands run in array order,
followed by the ticket's `verify` commands. Both use the same working directory, environment,
per-command logs, exit classification and outcome handling; any nonzero verification exit
prevents an `ok` outcome. As with ticket verification, all commands run even after a failure.

Repositories may declare `[verify]` with `always = ["command", "another command"]` in L1
`agx.toml` or their XDG L2 repository override. The table is strict: only `always` is accepted,
and its value must be an array of non-empty strings. The default is `[]`; L1 then L2 replace
the array rather than concatenating it. An omitted key inherits, while `always = []` clears it.
Resolution follows the existing immutable L1 and machine-local L2 reader for the execution
repository. `agx worker check` prints effective non-empty always commands without executing them.
Always command results carry `source: "[verify].always"` in the run's `verify` array and
diagnostic output. When always commands are configured, the saved report also includes the
complete ordered `verify` results. Without the key, existing output and verification behavior
are preserved. Capacity runs skip both always and ticket verification.

Vendor capacity ends a run with outcome `capacity` and temporary-unavailability exit 75. Codex's
`Selected model is at capacity` and Claude's documented HTTP 529 `overloaded_error` are vendor
unavailability, not worker failures ([Claude error reference](https://platform.claude.com/docs/en/api/errors)).
The wrappers stop on either error immediately, allow one second for termination, then force a kill;
pipe draining has a further one-second bound. No vendor retry is started by the wrapper.

The initial model wait is bounded to 120 seconds, allowing ordinary startup and network latency
without consuming a long ticket's budget. Session/turn metadata and reconnect messages do not
renew this bound. Substantive model output or tool activity ends the initial wait; an active
worker then has the ticket's normal timeout. Expiring the initial wait also yields `capacity`.

The selected row remains in the run record. A capacity outcome excludes that row, and every
effort variant for its vendor model, for 300 seconds after completion. Five minutes prevents
immediate relaunch loops while allowing automatic recovery. Existing capability, subscription,
route-allowlist and Jev/fallback rules choose among the remaining rows; exhausting them refuses
dispatch rather than waiting or retrying a cooled model. Capacity runs skip ticket verification,
do not require a worker judgment, and never contribute to graded worker acceptance/failure counts.

`--continue` on a capacity run always routes away from the old vendor model, even after its
cool-down expires. A recorded Codex session can resume on another Codex model using `-m/--model`
(verified with `codex exec resume --help`). Otherwise the command announces a fresh dispatch and
records `supersedes` with `continues: null`. A resumed session records `continues` normally.

See [next-records.md](docs/next-records.md) for the append-only record schema and JSON listing.

## Worker environment, version 1

This is the public launch-environment specification for the behavior in agx-worker 10.0.5.
It describes the environment passed by the built-in Codex and Claude wrappers, rather than
a runtime file format or a new command. Source links and existing tests below delimit the
observed behavior; a related test is identified when it does not directly assert a variable.
Consumers should retain worker guards when adopting this specification.

### Worker marker and identity

`AGX_WORKER=1` means that the process was launched as an agx vendor worker. Both wrappers
set it unconditionally, overriding any inherited value. It identifies a worker context,
not a run ID, dispatcher identity, authorization, or proof that a process is still alive.
Ordinary child processes inherit it unless their launcher changes the environment. Its
lifetime is that process environment and its inheriting descendants; agx does not clear it
when the run ends or attach an expiry. A guard against nested dispatch or coordinator-only
operations should test this marker before acting. The marker itself does not enforce a
dispatch prohibition. An absent marker alone does not prove coordinator authority.

The wrappers copy every defined `AGX_*` value, including empty strings, then force the
marker to `1`. Other variables use an explicit allow-list. In particular,
`TASK_CONTINUATION_SLOT`, `CLAUDE_CODE_SESSION_ID`, and `CODEX_SESSION_ID` are excluded
from the vendor child environment. A vendor may establish its own session after startup.
Source: [marker constants](../shared/src/worker-env.ts),
[environment builder](src/workers/environment.ts),
[Codex launch](src/workers/codex.ts), and [Claude launch](src/workers/run-claude.ts).
Existing tests: [environment.test.ts](tests/environment.test.ts), “forwards the complete
declared allow-list and AGX namespace” and “excludes coordinator continuation and vendor
session state”; [codex.test.ts](tests/codex.test.ts), the child-environment assertions;
[run-claude.test.ts](tests/run-claude.test.ts), “marks the Claude child as an agx worker”.

`AGX_DISPATCHER_SESSION` carries the caller-supplied dispatcher session identity. It is
not the worker's vendor session or the agx run ID. The **recorded** `dispatcher_session`
selects the first defined, non-empty value in this order:

1. `--session ID`
2. `AGX_DISPATCHER_SESSION`
3. `CLAUDE_CODE_SESSION_ID`
4. `CODEX_SESSION_ID`
5. `null`, with a `WARN dispatcher session is unavailable` diagnostic

The selection does not trim values; an empty string falls through, while whitespace is
non-empty. This resolution does not assign the result back to the child environment.
For example, `--session flag-session` with `AGX_DISPATCHER_SESSION=caller-session` records
`flag-session` while the built-in vendor child inherits `caller-session`. If the variable
is absent, the builder does not synthesize it from `--session` or a vendor session fallback;
if empty, the child retains the empty string. Consumers must not assume equality between
the variable and the record. Use `agx worker ls --json` for recorded attribution.
Normalizing these identities would require a separate behavior change and acceptance tests.

Source: [run.ts](src/next/run.ts), the dispatcher selection and `runEnv`/child launch;
[environment.ts](src/workers/environment.ts), the namespace copy.
Existing tests: [next/run.test.ts](tests/next/run.test.ts), the fixture with
`flag-session`, `dispatcher-session`, `claude-session`, `codex-session`, and missing-session
warning assertions; the wrapper environment tests above check child propagation separately.
They do not assert the complete record-versus-child matrix in one invocation.
Durable dispatch explicitly forwards `CLAUDE_CODE_SESSION_ID` and `CODEX_SESSION_ID` with
systemd `-E`; it does not explicitly forward `AGX_DISPATCHER_SESSION` or every `AGX_*`
variable to the unit. Do not assume the invoking shell and service manager have identical
environments. Source: [dispatch.ts](src/dispatch.ts), `systemd-run` arguments;
existing test: [dispatch.test.ts](tests/dispatch.test.ts), session-forwarding assertions.

### Other environment variables

Paths in the source and test columns are relative to this directory. These are the named
`AGX_*` inputs and outputs read or set by the worker implementation, including internal
transport and test seams. Inherited arbitrary `AGX_*` names are preserved, but that does
not give them a meaning or make internal file contents a public API. A path override is
not a guarantee of file discovery, schema compatibility, or successful writes.

| Variable                       | Observed meaning and lifetime                                                                                                                                                                                                                                                                                                  | Source locator                                                                                                                                                              | Existing test                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGX_WORKER_PATH_SOURCE`       | Dispatch sets `dispatcher` in the unit. That exact value preserves caller PATH through run/verification without repository mise resolution; other values use ordinary caller environment assembly. Inherited by the vendor child.                                                                                              | [dispatch.ts](src/dispatch.ts), `--setenv`; [next/verify.ts](src/next/verify.ts), environment assembly; [next/run.ts](src/next/run.ts), receipt attribution                 | [dispatch.test.ts](tests/dispatch.test.ts), “source dispatch pins bun, absolute source entry and dispatcher PATH”; [next/continue.test.ts](tests/next/continue.test.ts), dispatcher PATH fixture |
| `AGX_INTERIM_REPORTS_FILE`     | Run sets a per-run interim-return journal path on the wrapper child, overriding an inherited value. Both wrappers append valid interim returns there. The value can reach vendor descendants; it is not a consumer journal contract.                                                                                           | [next/run.ts](src/next/run.ts), child `env`; [workers/codex.ts](src/workers/codex.ts), `recordInterim`; [workers/run-claude.ts](src/workers/run-claude.ts), `recordInterim` | [next/run.test.ts](tests/next/run.test.ts), interim-return fixture and assertions                                                                                                                |
| `AGX_STATE_DIR`                | Non-empty state-root override; otherwise non-empty XDG_STATE_HOME/agx, then ~/.local/state/agx. Inherited when supplied; state startup can refuse migration as described above.                                                                                                                                                | [state.ts](src/state.ts), state resolver; [dispatch-state.ts](../shared/src/dispatch-state.ts), directory resolver                                                          | [next/state-dir.test.ts](tests/next/state-dir.test.ts)                                                                                                                                           |
| `AGX_CONFIG`                   | Non-empty operator policy path; otherwise non-empty XDG_CONFIG_HOME/agx/agx.toml, then ~/.config/agx/agx.toml. No silent fallback on an invalid explicit policy.                                                                                                                                                               | [roster/load.ts](src/roster/load.ts), policy path resolution                                                                                                                | [public.test.ts](tests/public.test.ts), policy fixtures; see [operator configuration](../../contract/config.md)                                                                                  |
| `AGX_TMP_ROOT`                 | Temp parent, defaulting to XDG_CACHE_HOME/agx/tmp or ~/.cache/agx/tmp when unset. Each run creates a private directory and sets TMPDIR/TMP/TEMP for worker and verification; removes it on completion, with later stale-owner cleanup after abrupt death. /tmp itself is refused. Empty is an explicit value, not the default. | [temp.ts](src/temp.ts), temp root and run directory                                                                                                                         | [next/run-temp.test.ts](tests/next/run-temp.test.ts), worker/verify, cleanup and refusal fixtures                                                                                                |
| `AGX_WORKER_BIN`               | Script override for the internal worker; takes precedence over AGX_WORKER_COMMAND. Run executes it through Bun. Unset uses the built-in invocation; empty is still a supplied override.                                                                                                                                        | [next/run.ts](src/next/run.ts), worker selection and spawn                                                                                                                  | [next/run.test.ts](tests/next/run.test.ts), fake-worker fixtures                                                                                                                                 |
| `AGX_WORKER_COMMAND`           | Executable override when AGX_WORKER_BIN is unset; otherwise the current worker invocation is reused. This is executable selection, not a shell command string.                                                                                                                                                                 | [next/run.ts](src/next/run.ts), worker path and default command                                                                                                             | [capacity.test.ts](tests/capacity.test.ts), worker-command fixture                                                                                                                               |
| `AGX_CODEX_BIN`                | Codex executable override, default `codex` only when unset; also used for resource probes and interim-return requests.                                                                                                                                                                                                         | [workers/codex.ts](src/workers/codex.ts), binary selection; [workers/codex-resource-probe.ts](src/workers/codex-resource-probe.ts); [lifecycle.ts](src/lifecycle.ts)        | [codex.test.ts](tests/codex.test.ts), fake Codex CLI; [capacity.test.ts](tests/capacity.test.ts)                                                                                                 |
| `AGX_CODEX_HOST_FILE`          | Host declaration path override; unset uses XDG_CONFIG_HOME/agx/host.toml or ~/.config/agx/host.toml. Empty remains explicit. Invalid declarations and read errors refuse launch; only ENOENT with no retired declaration means absent.                                                                                         | [workers/codex-host.ts](src/workers/codex-host.ts), path and reader                                                                                                         | [codex.test.ts](tests/codex.test.ts), host declaration fixtures; not an exhaustive read-error test                                                                                               |
| `AGX_CODEX_PROGRESS_FILE`      | Optional Codex wrapper progress-output path. Unset disables this writer; inherited value is read, not synthesized by run. Contents remain internal.                                                                                                                                                                            | [workers/codex.ts](src/workers/codex.ts), progress writer                                                                                                                   | [codex.test.ts](tests/codex.test.ts), “AGX_CODEX_PROGRESS_FILE gets the final progress record”                                                                                                   |
| `AGX_LAST_MESSAGE_FILE`        | Optional Claude output path; valid accumulated return text is saved there and then submitted to the interim writer. Unset skips that part of the feed handler.                                                                                                                                                                 | [workers/run-claude.ts](src/workers/run-claude.ts), `feed`                                                                                                                  | [run-claude.test.ts](tests/run-claude.test.ts) covers streaming; no direct variable assertion                                                                                                    |
| `AGX_WORKER_ACTIVITY_FILE`     | Optional vendor-stream byte-count output path. Unset makes the writer a no-op; write errors are swallowed. No liveness or public file guarantee.                                                                                                                                                                               | [lifecycle.ts](src/lifecycle.ts), `activityWriter`; both vendor wrappers call it                                                                                            | [lifecycle.test.ts](tests/lifecycle.test.ts) covers activity/stall accounting; no direct path-variable assertion                                                                                 |
| `AGX_PROGRESS_EVERY_S`         | Positive integer seconds for wrapper progress messages; unset, invalid, zero, negative, fractional or overflowing values use 300 seconds.                                                                                                                                                                                      | [progress.ts](src/progress.ts), interval parser                                                                                                                             | [progress.test.ts](tests/progress.test.ts); [codex.test.ts](tests/codex.test.ts), progress interval fixture                                                                                      |
| `AGX_DISPATCH_WAIT_MS`         | Dispatch's wait for a matching run record, milliseconds; unset or non-finite uses 60000. Finite values are used as supplied. Expiry reports that the service started without a matching record.                                                                                                                                | [dispatch.ts](src/dispatch.ts), configured wait                                                                                                                             | [dispatch.test.ts](tests/dispatch.test.ts), missing and delayed run-record fixtures                                                                                                              |
| `AGX_WAIT_POLL_MS`             | Listing wait's fallback polling interval; finite values at least 5000 ms are used, otherwise 5000 ms. Filesystem notifications can wake it earlier.                                                                                                                                                                            | [next/wait.ts](src/next/wait.ts), polling and notifications                                                                                                                 | [next/wait-cursor.test.ts](tests/next/wait-cursor.test.ts), delayed polling fixture; [next/ls-wait.test.ts](tests/next/ls-wait.test.ts)                                                          |
| `AGX_READONLY_COMMAND_JOB`     | Internal serialized argv/cwd binding for the isolated read-only helper. Mismatch exits 2 before target execution; the helper removes it from both runtime and native environment before exec. Do not set it as an operator input.                                                                                              | [readonly-command.ts](../shared/src/readonly-command.ts); [readonly-exec.ts](../shared/src/readonly-exec.ts), envelope validation and removal                               | [readonly-command.test.ts](tests/readonly-command.test.ts), invalid isolation job                                                                                                                |
| `AGX_TEST_MODEL_WAIT_MS`       | Test seam: finite positive model-start wait, capped at 120000 ms; otherwise 120000 ms. Not a routing or sandbox override.                                                                                                                                                                                                      | [workers/capacity.ts](src/workers/capacity.ts), `modelWaitMs`                                                                                                               | [capacity.test.ts](tests/capacity.test.ts), startup-wait fixtures                                                                                                                                |
| `AGX_CODEX_TEST_STDIN_WAIT_MS` | Test seam: Codex prompt stdin wait, default 30000 ms when unset; supplied values use Math.max(1, Number(value)).                                                                                                                                                                                                               | [workers/codex.ts](src/workers/codex.ts), stdin wait                                                                                                                        | [codex.test.ts](tests/codex.test.ts), stdin wait fixture                                                                                                                                         |
| `AGX_TEST_PROCESS_TREE_CPU`    | Test seam: exact `flat` selects a zero CPU observation. Other values use normal process-tree sampling.                                                                                                                                                                                                                         | [lifecycle.ts](src/lifecycle.ts), process CPU sampling                                                                                                                      | [lifecycle.test.ts](tests/lifecycle.test.ts) covers CPU sampling; no direct variable assertion                                                                                                   |

Retired names are refusals, not aliases. Merely defining `AGX_NEXT_STATE_DIR` (even empty)
refuses worker startup with exit 2; defining `AGX_NEXT_WORKER` refuses run with exit 2 and
directs callers to `AGX_WORKER_BIN`. Defining `AGX_NEXT_JEV_URL` is rejected by the Jev
client in favor of `JEV_URL`. Defining `AGX_DOCTOR_QUIET` refuses doctor with exit 2 in
favor of `--quiet`. Sources: [state.ts](src/state.ts), [next/run.ts](src/next/run.ts),
[jev-client.ts](../shared/src/jev-client.ts), [next/cli.ts](src/next/cli.ts).
Existing tests: [next/state-dir.test.ts](tests/next/state-dir.test.ts),
[next/run.test.ts](tests/next/run.test.ts), [jev-client.test.ts](tests/jev-client.test.ts),
respectively. Doctor's retired-variable refusal has no direct existing test assertion.

Version 1 records these observed semantics. It adds no runtime version variable or negotiated
environment schema. Consumers should ignore unfamiliar inherited names. Removing or changing
the marker, identity resolution, or propagation rules requires an explicitly versioned contract
revision and a separately reviewed behavior change; this documentation does not implement a
new compatibility mechanism. Internal transports and test seams are identified above so that
their propagation is visible without making them supported integration interfaces.

## Host declaration

Operators provision a host with `agx worker host declare --unsandboxed-reason TEXT`.
Shell, CI and agent consumers inspect it with `agx worker host check --json` instead
of importing a reader or parsing its TOML. Both commands use the same path resolver
and strict validator as Codex launch. `agx-worker host` is the equivalent direct bin.
The reason explains why the host itself provides isolation; a valid declaration is
an operator assertion, not a sandbox capability probe.

`check --json` is read-only. It emits exactly one JSON object and newline on stdout,
with the same framing on a terminal or pipe:

```json
{
  "schema": 1,
  "path": "/example/config/agx/host.toml",
  "status": "valid",
  "declaration": { "schema": 1, "unsandboxed_reason": "isolated host" },
  "reason": null
}
```

| Status    | Exit | Declaration                           | Reason            |
| --------- | ---- | ------------------------------------- | ----------------- |
| `valid`   | 0    | Validated schema 1 and trimmed reason | `null`            |
| `absent`  | 1    | `null`                                | `null`            |
| `invalid` | 2    | `null`                                | Diagnostic string |

Only ENOENT with no retired declaration means absent. Malformed TOML, unsupported
schema, extra keys, blank reasons, non-regular files (including symlinks), and
unreadable files or parent directories are invalid. Files disappearing after the
initial metadata check are invalid. Diagnostics are explanatory text, not stable
identifiers. JSON schema 1 field meanings and status/exit mappings are public;
consumers must tolerate added fields. Changes to these meanings require a breaking
release. Both JSON schema and declaration schema are currently 1.

The owner resolves the path from `AGX_CODEX_HOST_FILE` when set, otherwise
`$XDG_CONFIG_HOME/agx/host.toml`, with XDG_CONFIG_HOME defaulting to `~/.config`.
Relative overrides resolve against the caller's working directory; `path` reports
the selected spelling. Empty overrides are used literally and are not defaults.
The human-authored input is TOML containing exactly `schema = 1` and
`unsandboxed_reason = "nonblank explanation"`; agx owns its validation, path
discovery and compatibility. Consumers should use the JSON projection rather than
copying these input rules. Existing valid regular files remain accepted regardless
of their mode; creation modes are described below.

`declare` requires nonblank TEXT and trims it. On success it prints the selected
path and newline and exits 0. On refusal or I/O failure it prints a diagnostic on
stderr and exits 2. It creates missing parent directories with mode 0700 and opens
the new file with mode 0600 (both subject to umask). Existing parent permissions
are unchanged; parent directories use normal OS path resolution. Exclusive create
and no-follow flags prevent replacing any existing final entry or following a
final symlink, including a dangling symlink. Concurrent declarations yield one
creator and a refusal. There is no overwrite or force option. A write failure may
leave a partial newly created file; inspect/remove that file before retrying.
The command rereads the result through the launch reader before reporting success.

When the selected file is missing and its parent is named `agx`, a sibling
`codex-run/host.toml` entry is retired input: check exits 2 with a migration
instruction and declare refuses. Neither command moves, deletes or imports it.
A current valid file takes precedence over retired input. An inaccessible retired
path is invalid rather than evidence of absence.

Help is available with `agx worker host --help`. Unknown flags, extra arguments and
missing positional arguments follow the CLI parser's exit 1 behavior; unsupported
actions/flag combinations and blank declaration reasons exit 2. Usage failures
write stderr and do not emit a check JSON object. Ordinary worker state migration
refusals still apply before host inspection. Neither host command writes run state.
Acceptance fixtures in `tests/host.test.ts` invoke the real `agx worker host` route
with isolated config and state directories, covering all three check statuses,
permissions, retired input, symlinks, competing creates and unchanged existing files.

## Statistics window parameter

`--window DURATION` is shared by `stats --routing` and `stats --usage jev`; it is
invalid with plain `stats` or `--import-legacy`. The default is `24h` for routing
statistics and `7d` for Jev usage. Its grammar is a positive decimal integer followed
by `m`, `h` or `d`; units mean exactly 60, 3600 or 86400 seconds. Unsafe durations
and windows beginning before the Unix epoch are rejected.

## Routing statistics (schema 1)

`agx worker stats --routing --window 24h [--host NAME]` emits one JSON object and
newline, identically on terminals and pipes. Direct `agx-worker stats` is equivalent.
This read-only projection does not import history or start workers. Plain `stats`
retains its existing output. `--routing` cannot combine with `--import-legacy`;
`--host` requires `--routing`. No positional arguments are accepted.

`observation.start` and `observation.end` are UTC instants; the interval is
`[start,end)`, with end sampled once at collection start. `duration_ms` is the
duration, and `window` retains the input spelling. `host` is an exact, case-sensitive name and defaults to the local
OS hostname. Blank host names are rejected. Selecting another host filters the
same owner journal; it does not query another machine or combine state stores.

Schema 1 fields:

| Field                               | Meaning                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `schema`                            | Public response version, currently 1.                                                         |
| `observation`                       | `start`, `end`, `window`, `duration_ms`, and `interval`.                                      |
| `host`                              | Selected routing host name.                                                                   |
| `jev.pick_count`, `jev.denominator` | Equal counts of recorded selections with source Jev, matching host and bounds.                |
| `jev.codex_pick_count`              | Subset of those selections whose selected route was Codex.                                    |
| `jev.codex_share`                   | Codex count divided by denominator, a fraction in [0,1]; null when denominator is zero.       |
| `fallback_count`                    | Recorded non-Jev selections in the same host and interval, excluded from the Jev denominator. |
| `routes.codex`, `routes.claude`     | Current local route assessment described below; unrelated to historical pick success.         |
| `coverage`                          | Explicit limits on the observed counts, described below.                                      |

One count means one completed routing selection. The owner now captures every
Jev or fallback selection at selection time, with host, timestamp, row, route and
source, before a worker starts. `roster TICKET` selections and retries count too;
explicit row choices and continuations that do not route do not count. Failed
routing attempts without a selected row do not count. Selections are retained
independently of run completion; run events are never added to these counts, so
audit copies cannot double count. The owner's event storage is private: consumers
must discover and read these metrics through this command, not through file paths.

Each route exposes `state` (`unknown` or `unavailable`), `configured` (boolean or
null), `executable` (`present`, `absent` or `unknown`), `sandbox` (`unknown`),
`reason`, and `subscription` (assessment object or null). For the local host,
configured means at least one effective roster row exists and the route filter
permits it. Executable presence is a PATH lookup of `codex` or `claude`; no binary
is executed. A known disabled route, missing binary, or exhausted subscription
with policy `stop` makes the state unavailable. Otherwise state stays unknown:
executable presence cannot establish execution or sandbox capability. No task's
capability tags or sandbox are assumed. For another host these checks and
subscription are unknown/null; local facts are never attributed to that host.

The subscription object reuses routing's `available`, `exhausted`, `usage_status`,
`preference`, `windows` and optional `source_reason` assessment. `available` is
subscription policy permission, not executable or sandbox capability. Missing or
invalid subscription observations are unknown and neutral, not failure. Future
measurements, measurements older than 15 minutes, and expired reset times are
stale and neutral. Window objects expose used percentage, reset epoch seconds,
window seconds, elapsed fraction, pace and status. Unknown/stale windows have null
elapsed fraction and pace. Fresh exhausted windows can veto a route only under
its configured `stop` policy. `continue` preserves subscription permission.

`coverage.status` is currently always `partial`, `history_complete` is false and
`legacy` is `unknown`: pre-journal picks have no reliable complete host history.
Zero observed picks do not prove zero activity. `journal_present` distinguishes
missing owner history from a present journal. `first_recorded_at` is the earliest
retained event across all hosts, or null; it does not establish uninterrupted
coverage. `trailing_partial_record` reports an unfinished last record, excluded
from counts. `unknown` lists further limits, including journal deletion/retention
and unprobed execution/sandbox capability. `subscription_max_age_ms` is 900000.
No legacy history is imported, inferred from row names, or represented as complete.

Exit 0 means the projection was collected, including empty/partial history,
unknown subscriptions or unavailable routes. Invalid combinations, windows and
blank host names exit 2 with a stderr diagnostic and no report. Missing journals
are reported as unknown coverage; unreadable journals, malformed complete records
or invalid local roster configuration fail collection with exit 2 and stderr.
Framework parsing errors (such as unknown flags) exit 1; existing state migration
refusals exit 2. An incomplete last journal line is reported in coverage rather
than silently treated as a complete observation.

Schema 1 field meanings and null semantics are public. Additive fields and new
status values are compatible; consumers must tolerate them. Changing existing
field meanings or removing fields requires a breaking release and a new schema.
Acceptance tests in `tests/next/routing-stats.test.ts` exercise real `agx worker`
JSON, isolated owner history and selection capture, out-of-window/future/other-host
fixtures, fallback denominators, unknown/stale/exhausted subscriptions, empty
windows, invalid input and corrupt/incomplete history. Window parsing lives in
one reusable stats helper for additional projections.

## Vendor probe (JSON schema 1)

`agx worker probe --vendor codex --sandbox workspace-write --cd PATH --timeout-ms N --json`
runs a fixed diagnostic on the host where the CLI is invoked. Callers can invoke it
through SSH; agx does not own SSH transport. Human operators, scripts and agents
consume the same single JSON object followed by a newline on stdout. It requires
all five flags, accepts no positionals or stdin, and offers `probe --help`.
`--sandbox` accepts `none`, `read-only` or `workspace-write`; N is an integer from
1 through 300000 milliseconds. Unknown flags and missing flag values follow the
parser's stderr/exit 1 behavior. Invalid values, missing required flags, extra
positionals and invalid directories return a `refused` report with exit 2.

The probe starts Codex directly with `exec --json --skip-git-repo-check`, the
selected sandbox, the canonical target directory and `approval_policy="never"`.
It supplies a fixed prompt asking for exactly one shell command,
`printf 'AGX_PROBE_OK\n'`, followed by the exact reply `AGX_PROBE_OK`, without
reading or changing files. There is no caller prompt, ticket, roster selection,
continuation, worker launch wrapper, reservation or run record. The probe neither
creates nor reads agx run records. The ordinary worker state-migration gate runs
before flag parsing: a retired state variable or unmigrated directory emits a
diagnostic on stderr and exits 2 without a JSON report or vendor launch. This
path inspection does not create state. Codex may
use its own configuration, credentials and session storage. The diagnostic prompt
requests no target writes; this is an execution probe, not a filesystem isolation
proof or a vendor configuration audit.

Sandbox selection uses the same host-declaration resolver and validator as worker
launch. Invalid or unreadable declarations refuse before spawn. A valid declaration
sets `sandbox_effective` to `danger-full-access` and supplies its
`unsandboxed_reason`; otherwise the requested mode is used (`none` maps to
`danger-full-access`). No failure triggers a sandbox retry or downgrade.
`sandbox_effective` reports the launch argument, not an independently measured
kernel boundary. It remains null when no process was started. The resolved
executable is `AGX_CODEX_BIN` when set, otherwise `codex` found on PATH; the override
also supports fake executables in acceptance tests.

| Field                                    | Meaning                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `schema`, `vendor`                       | `1`, `"codex"`                                                                        |
| `sandbox_requested`, `sandbox_effective` | Validated requested mode and actual launch mode; null when not validated/started      |
| `unsandboxed_reason`                     | Host-declaration explanation, or null                                                 |
| `executable`, `cwd`                      | Resolved executable and canonical target directory, or null before resolution         |
| `captured_at`, `ended_at`                | UTC observation and report completion timestamps                                      |
| `started_at`, `start_ms`                 | Successful process spawn timestamp and elapsed milliseconds, or null                  |
| `startup_at`, `startup_ms`               | First `thread.started` acknowledgement and elapsed milliseconds, or null              |
| `result_at`, `result_ms`                 | Observed `turn.completed` and elapsed milliseconds, or null                           |
| `elapsed_ms`, `timeout_ms`               | Total observation duration and validated execution deadline (null if input invalid)   |
| `timed_out`                              | Execution deadline fired, including after result output but before process exit/drain |
| `exit_code`, `signal`                    | Observed vendor process exit code and termination signal, nullable                    |
| `outcome`, `reason`                      | Classified outcome below and explanatory text                                         |
| `stderr`                                 | First 4096 decoded characters of vendor stderr; never mixed into stdout               |

Timestamps use UTC ISO 8601; durations use a monotonic clock relative to
`captured_at`. Spawn is not startup acknowledgement; startup acknowledgement alone
does not establish that a sandbox command ran. A result timestamp alone does not
establish success. A successful observation requires `thread.started`, a completed
command with exit 0 and marker output, the exact marker reply, `turn.completed`,
and a process exit of 0 before the deadline, without error events or invalid output.

| `outcome`        | CLI exit | Meaning                                                              |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `success`        | 0        | Fixed diagnostic completed with all evidence above                   |
| `timeout`        | 1        | Execution deadline exceeded; takes precedence over result output     |
| `failed`         | 1        | Vendor error event, nonzero exit, signal or stream failure           |
| `invalid_output` | 1        | Missing required evidence, malformed JSONL or excessive output       |
| `refused`        | 2        | Invalid invocation, directory or host declaration; no vendor started |
| `unavailable`    | 2        | Executable missing or process could not start                        |

The execution deadline bounds startup, command/result waiting and output draining
together. Maximum silent execution is N milliseconds plus process termination and
local scheduling overhead. Both output streams drain concurrently with a 1 MiB
byte bound per stream. Output overflow kills the process and fails. On supported
POSIX hosts, the probe owns a separate process group and sends SIGKILL to it on
timeout, overflow and normal parent exit, preventing lingering descendants from
holding the pipes open. No temporary probe files need cleanup. Retrying starts a
new diagnostic; it never resumes or registers a run.

Schema 1 field meanings, null semantics and outcome/exit mappings are public.
Consumers must tolerate added fields and treat unrecognized outcomes as non-success.
Changing existing meanings requires a breaking release. No private file is a probe
API. `tests/next/probe.test.ts` invokes the real umbrella CLI with only fake vendor
executables and isolated state, checking success, timeout before startup and after
result, process-group cleanup, malformed/missing/excessive output, unavailable
executables and valid/invalid host declarations.

## Jev usage JSON, version 1

Shell, CI and agent consumers use `agx worker stats --usage jev --window 7d`.
JSON is the default and only output mode for this projection. The window follows
the shared [statistics window parameter](#statistics-window-parameter).
`--usage` is exclusive with `--routing`, `--host`, `--import-legacy`, and positional
arguments. No stdin is consumed.

The read-only command emits one JSON object and newline on stdout, with `schema: 1`,
`usage: "jev"`, `window`, `from`, `to`, `captured_at`, and `interval: "[from,to)"`.
`from` and `to` bound the trailing window at collection start; `captured_at` is the
completion time. There is no network request or worker launch. It reads owner state
through the ordinary `AGX_STATE_DIR`/XDG resolver; callers must not discover or parse
the private journals themselves. Repeating the command observes a new window.

- `input_tokens` and `output_tokens` sum **retained observed evidence** when all
  observed records have usage and there are no unknown timestamps or partial tails.
  Otherwise both are `null`. Empty evidence also returns `null`, never an inferred zero.
  Explicit recorded zero tokens remain numeric zero.
- `known_input_tokens` and `known_output_tokens` always give the known subtotal, or
  `null` if there are no records with valid usage. They exclude missing usage rather
  than treating it as zero. Usage requires both nonnegative safe-integer
  `usage.input_tokens` and `usage.output_tokens`; partial, invalid or absent usage
  counts as unknown.
- `pricing` supplies USD `input_per_mtok`, `output_per_mtok`, `source`, `as_of`,
  `observed_at`, and `basis`. These are the effective roster catalog rates at
  observation (catalog `[jev]` overrides policy prices), with the catalog date as
  `as_of`. They are configuration evidence, not a verified provider bill.
  Missing prices are `null`. `known_tokens_at_effective_price_usd` reprices the
  known subtotal at these named rates; `estimated_cost_usd` uses the same formula
  only when observed evidence is complete. Both are `null` without usage or rates.
  Neither claims historical billing cost. Each newly captured call also preserves
  its then-effective prices privately for provenance.
- `completeness` is `"partial"` and `coverage.history_complete` is `false`: agx
  cannot certify deleted or unretained history. Even numeric totals describe only
  retained observations. `coverage.observed_records_complete` separately describes
  the inspected records. `coverage` includes call/known-record counts, legacy
  known-record count, journal presence, `first_capture_at` (earliest retained call),
  partial-tail status and an explicit reason. `first_capture_at` is not proof that
  the window before it was idle. Freshness is evaluated from `to`/`captured_at`;
  there is no cached-result TTL.
- `unknown.usage` counts missing captured-call usage plus historical runs lacking
  usage evidence; `historical_runs` and `captured_calls` split that count.
  `unknown.time` counts run records whose timestamps cannot establish window
  membership, separately from in-window counts. `unknown.historical_pricing`
  counts legacy records with known tokens but no preserved call-time price.
  Unknown counters describe observed evidence, not an upper bound on lost history.

New routing attempts capture usage after the Jev request, including failed requests,
HTTP errors and fallback selections, even if no worker starts. The count unit is
one captured routing attempt, not a worker execution. A run links to its capture
without recounting the call. Pre-capture started runs have unknown usage; historical
manual/routed eligibility cannot always be distinguished, so unmatched runs are
conservatively unknown. Retained legacy run journals (including dated rotations in
both the state root and `legacy-v1`) contribute response usage when available,
attributed to their `started_at`; current calls use response capture time.
Legacy run IDs deduplicate rotations and matching imported started records.
Runs outside `[from,to)` do not contribute tokens or missing-usage counts.

Exit 0 means a projection was collected, including explicitly partial results.
Invalid flag combinations/windows, unreadable journals, invalid complete JSON lines,
invalid capture records, or invalid effective configuration exit 2 with a diagnostic
on stderr and no JSON. Cleye parser failures (for example unknown flags) retain its
exit 1 behavior. An incomplete final journal line is excluded and disclosed, rather
than reported as a complete observation. No import, rewrite, cache publication or
migration occurs. JSON consumers must tolerate additive fields; incompatible meaning
or field changes require another schema version.

`tests/next/jev-usage.test.ts` exercises the real suite CLI with isolated state and
a local Jev HTTP fixture, including successful capture, fallbacks, missing historical
usage, legacy deduplication, invalid input, partial writes and out-of-window records.

## Listing visibility and moved reports

Use the selector directly instead of filtering JSON:

```sh
agx worker ls <id-prefix|ticket>
agx worker ls run-abc --json
agx worker ls exact-ticket-name --json
agx worker ls --json --summary
agx worker ls --include-legacy --all
```

A selector accepts an exact run ID, a unique ID prefix, or an exact ticket name.
Ticket matches are ordered oldest to newest. Plain unselected output shows the
newest 30; `--all` shows every visible run. JSON retains its array of all visible
runs; `--summary` wraps it in `{runs, summary}`.

Malformed imported runs are hidden by default. Only imported started records
that fail event decoding are malformed. Missing historical choice metadata and
placeholder strings do not make a decoded run malformed. Stderr reports
`hidden_legacy=N` when rows are excluded; `--json --summary` also includes
`summary.hidden_legacy` (including zero). The count covers the workspace scope
before selector/running/limit filtering; `--include-legacy` includes those rows
and sets the hidden count to zero. Undecodable imported started records are
shown as raw records for inspection. Invalid complete event-log JSON and
undecodable records without legacy provenance still fail.

If a report recorded under the sibling retired `agx-next/` root exists at the
same relative location under the current state root, listings return the current
`report_path`. Missing files and unrelated absolute paths retain their recorded
value. Listing does not rewrite records or move files.

Listing scans retained records, so latency scales with store size. The isolated
5,000-run acceptance fixture checks plain and JSON commands below one second;
missing progress directories are discovered once rather than opened per row.

## Dispatch receipt and run outcomes

Human and agent consumers receive a dispatch receipt on stdout after the matching
started record appears. `dispatch TICKET --json` emits exactly one JSON object;
plain `dispatch TICKET` emits one line starting with the run ID followed by labeled
fields. Diagnostics remain on stderr in both modes, independently of TTY state.
This replaces the former ID-only human line; scripts should select `--json` and
read `id`. Receipt fields are additive and consumers must tolerate new fields.

Both forms expose `id`, `workspace` (the absolute execution path, including a
custom or continued workspace), `row` (selected roster row ID), `route`, `model`,
`effort`, `sandbox`, `sandbox_source`, `sandbox_effective`, and
`sandbox_effective_source`. Routing values come from the selected run, never a
second routing request. Historical records without routing or effective sandbox
evidence yield JSON null / human `unknown`, rather than an invented selection.
`run` also includes these execution fields in its final JSON receipt.

`sandbox` and `sandbox_source` retain the requested policy and the resolution
precedence above. `sandbox_effective` describes the launch policy: Codex `none`
becomes `danger-full-access`; a valid host isolation declaration or a resource
probe fallback also selects `danger-full-access`. Its source identifies the
request source, host declaration path and reason, or blocked resource. Claude
retains the selected agx sandbox policy. These describe configured launch policy,
not certification of kernel isolation. Started records and `ls --json` retain
these fields, including while the worker runs. Dispatch exit 0 confirms the unit
and matching record, not completion or acceptance. Preflight/start failures and
record observation deadlines keep their existing nonzero exits and effects;
retrying a started unit requires inspecting it first.

Every ended run has exactly one of the following `outcome` values; running runs
have null. Judgment is independent of outcome. Historical explicit values remain
readable without reclassification. Historical records lacking an explicit outcome
are conservatively derived from available exit, verification and workspace evidence.

| Value               | Meaning                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                | Worker completed, report is valid, verification passed, and at least one promised file changed.                                                                                                                                                       |
| `no-change`         | Same completion requirements as `ok`, with zero changed promised files. This does not assert acceptance.                                                                                                                                              |
| `timeout`           | The run's own `timeout_s` deadline killed the worker, or its worker receipt/exit reports a timeout (`timed_out`, `timeout`, exit 3 or 124). Takes precedence over receipt content and all derived outcomes.                                           |
| `capacity`          | Worker reports vendor capacity/resource unavailability; promised work was not completed. Distinct from worker refusal; verification is skipped and continuation may reroute.                                                                          |
| `refused`           | Worker explicitly refuses, execution exits unsuccessfully for another reason, or promised workspace evidence cannot be measured. It does not mean capacity or deadline expiry. Preflight refusals before a started record do not create an ended run. |
| `verify-killed`     | At least one verification command was killed.                                                                                                                                                                                                         |
| `verify-unrunnable` | No killed verification; at least one command could not execute (126/127).                                                                                                                                                                             |
| `verify-failed`     | No killed/unrunnable verification; at least one command failed.                                                                                                                                                                                       |
| `malformed`         | Worker otherwise completed but its final report failed the report contract.                                                                                                                                                                           |
| `stopped`           | The runner received SIGINT, SIGTERM or SIGHUP and recorded its own cancellation.                                                                                                                                                                      |
| `lost`              | Reconciliation found the run's recorded process/unit ownership no longer alive, without a recorded completion.                                                                                                                                        |

For ordinary completion the precedence is timeout, capacity, refused, verification
killed/unrunnable/failed, malformed report, then no-change/ok. Stopped and lost
are lifecycle outcomes. `run` preserves its child exit status; a receipt outcome
can therefore be non-success even with exit 0 (for example failed verification).
Callers inspect both outcome and exit. Unknown future outcome values are non-success.

The changed-file count compares contents, modes and symlink targets before/after
execution within `writes`, including additions and deletions. It excludes preexisting
unchanged dirt and VCS/dependency metadata; the worker's claimed `changes` list
and commits do not determine this count. Changes outside `writes` do not make `ok`.
`ls` prints the outcome and `ls --json` retains it. Ordinary `stats` includes
`by_outcome`, with every listed value present even at zero; counts are ended runs
with that outcome, including historical runs, excluding currently running runs.

Fixtures: `tests/dispatch.test.ts` covers both receipt formats and custom workspace;
`tests/next/outcome.test.ts` runs a real worker past its 60-second ticket deadline,
checks persisted/listed timeout, refusal/capacity distinction, and stats counts.

## Blinded routing Choice

Routing sends one Choice containing the same eligible rows in their existing order,
with IDs `model_0` through `model_n`, followed by `split`, `uncheckable`,
`contradiction`, and `missing_input`. Row criteria retain published scores, prices,
and use-for meaning, replacing model identities, family versions, and effort words
with neutral grammatical wording. Routing has no capability levels or return
threshold: a chosen return option returns the ticket.
The user task text is retained. The four returns describe observable conditions
and exclusions; choosing one prints its reason and fix to stderr, records a refusal,
and exits 2 before worker startup. Model IDs are mapped back locally. The pick audit
retains the anonymization map, answer, and complete probability distribution.
Invalid or missing answers retain the eligible default-row fallback and its reason.

### Local evidence in blinded routing

At routing time, the existing folded run reader supplies one observation per run
for each exact roster row. The latest valid acceptance judgment determines its
judged status; accepted share uses all judged runs, not process exit status.
Every blinded option appends `agx measured: N% of M judged runs accepted, median
T min.` Percent is rounded to an integer and minutes to one decimal. Fewer than
five judged runs instead show `agx measured: too few judged runs`, without a share.
Wall time is the median of ended runs, including unjudged runs, with nonfinite,
negative and over-24-hour durations excluded. An empty duration sample says
`median unknown min.` Exactly 24 hours remains eligible.

The objective is: "Purpose: the owner pays for every token and waits for every
minute until a result is accepted. Choose the option expected to produce an
accepted result for this ticket at the lowest cost and in the shortest time.
Evidence: 'agx measured' is the acceptance and wall time of each option on this
machine and is the primary evidence of whether an option is sufficient;
published benchmarks are background only. Return the ticket instead of
choosing a model only when it cannot be done as written. Subscription health:
weigh 7-day windows most; 5-hour windows are secondary; keep the intended bias
toward the codex route; stale or unknown usage is neutral." These observations
have selection bias: rows received different tickets, so their shares are not
controlled comparisons or causal rankings.
Option IDs, ordering, prices and published scores retain their existing meaning.
The pick audit's `measured_evidence`, keyed by blinded option ID, saves judged and
accepted counts, displayed percent, eligible ended-run count, displayed median
minutes and exact evidence text for every candidate, including fallback picks
and ticket returns. The audit retains the separate private anonymization map.

### Routing audit journal

`routing.jsonl` retains each selection before a worker starts, independently of
worker judgments. Its optional `audit` adds a decision UUID, ticket path and
SHA-256, exact structured Jev input and SHA-256 of its JSON serialization,
truncation flag, ordered before/after filter traces and removal details,
capability tags, timeout class, effective temperature and selection mode,
normalized complete policy/catalog SHA-256 hashes (before exclusions), returned model version, redacted raw reply,
usage ID, sampling seed and top-two probability margin. Null means unavailable
or no request sent. No environment object or authorization headers are retained.
The sampling seed permits replay through the existing selection guard.

Refusal records have null row/route and outcome `refusal`; their audit outcome kind is `held` because no row was selected. The first filter records policy exclusions before route eligibility filters. Selected requests
that exit before a started receipt have an additional `pre-start failure`
record with the same decision ID. Ended workers add `returned` or `held`
lifecycle evidence; these records do not count as picks or worker rejects.
Preview calls do not count as pre-start failures. SIGKILL cannot execute an exit
hook; a selection without a subsequent receipt remains evidence of an unknown
launch outcome.

Routing stats add `per_row_pick_counts` (all Jev and fallback selections),
`top1_minus_top2_margins` (sorted values, known count and unknown count for Jev
picks), `tb4_removed_all_luna_pick_count` (the TB4 stage had luna rows and
removed all of them), `refusal_count`, and `pre_start_failure_count`.
Legacy records remain readable and contribute picks but no invented margins.
No tie threshold, cheaper-row preference or exploration policy is introduced.

## Worker result directory

`run` creates and exports absolute `AGX_RUN_DIR=<state-root>/runs/<run-id>` before
spawning the worker. It adds that directory to the worker sandbox's writable
paths and names it in the brief. Workers write results, logs and measurements
there, alongside runner-owned `report.json`; workspace paths hold source changes.
A continuation receives its own run directory, not its parent's directory.
After the worker exits, `[verify].always` and ticket `verify` commands receive the
same `AGX_RUN_DIR` and `AGX_RUN_ID` values as the worker. For example,
`verify = ["test -s \"$AGX_RUN_DIR/x.result.md\""]` succeeds when the worker wrote
that file and fails when it is missing. Verification also retains the run's
assembled repository environment and per-run temporary directory.

## Model-free ticket intake

Before routing or worker startup, check, run and continuation enforce two intake
rules. Dispatch applies the same parsed-ticket rules before workspace creation
and runs the shared preflight before starting its unit. Per-ticket roster selection
also enforces intake before Jev.

- `writes`: the `writes` key must be declared. `writes = []` explicitly authorizes
  read-only work and is valid; omission does not declare a scope.
- `acceptance`: declare a nonempty `verify` command array or an acceptance oracle
  in `proposition.refuted_by`, tied to `outcome`. Human review criteria, evidence
  and diff oracles are valid. No command is required for such review work. The
  existing proposition fields express this; no additional review field is needed.

Violations remain mechanical refusals, exit 2, with one stderr line per violation:
`agx: remand RULE: "FIELD" REASON. Fix: REPAIR`. Existing schema, premise,
resource and timeout constraints remain enforced. Ordinary `check --json` emits
`{ "ok": false, "violations": ["..."] }`, or `ok: true` and an empty array.

Each refused preflight appends a `kind: "refusal"` event to `records.jsonl` with
its own ID, timestamp, cwd, absolute `ticket_path`, `ticket_sha256` and violation
strings. Hashes cover the exact ticket bytes; an unreadable ticket has a null hash.
Refusal events are audit records and do not become runs or affect run counts.
