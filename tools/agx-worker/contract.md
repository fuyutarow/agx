# agx-worker CLI contract

`agx-worker` owns worker runs. Its package bin points to `src/next/cli.ts`. The suite also accepts `agx worker`.

| Command                                                                                 | Purpose                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agx worker run TICKET [--cd TREE] [--sandbox MODE] [--continue RUN_ID] [--session ID]` | Route a ticket to a roster worker, run it, and append run records.                                                                    |
| `agx worker check TICKET [--cd TREE]`                                                   | Validate a ticket and its premises without starting a worker.                                                                         |
| `agx worker ls [SELECTOR] [--workspace PATH] [--json]`                                  | List runs and judgments; SELECTOR is a run id, unique run-id prefix, or exact ticket name. Ticket selections put the newest run last. |
| `agx worker judge RUN_ID accept\|reject [--note TEXT]`                                  | Append an acceptance or rejection judgment.                                                                                           |
| `agx worker stats [--import-legacy]`                                                    | Report run counts; optionally import legacy run records.                                                                              |
| `agx worker dispatch TICKET [--ws SLUG] [--unit NAME] [--continue RUN_ID]`              | Obtain a workspace through `agx ws`, or reuse a continuation's recorded workspace, and start a durable worker unit.                   |
| `agx worker roster TICKET`                                                              | Print one selected roster row. `roster --json` prints the full validated roster and routing objective.                                |
| `agx worker doctor`                                                                     | Diagnose worker records as tool/object/finding/remedy JSON Lines.                                                                     |

The top-level `objective` field in `roster --json` is the routing objective text used to select workers; the per-ticket `roster TICKET` output remains one selected row.

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
metadata. `scripts/land.ts` consumes this view alongside legacy run records when deciding whether a
workspace has an accepted run.

Every ordinary `ls --json` row (including selector, `--all`, `--running`, `--wait`, workspace
and `--summary` run rows) includes `progress`, `progress_source`,
`progress_status`, and `progress_fresh_at`. The separate `--ticket --latest`
receipt projection is unchanged.

`progress` is null or `{last, at, commands, files, turns, usage, cost_usd, session}`.
Commands count observed command invocations; files count distinct paths in observed
edit events, and turns carry the worker tally's vendor turn count. These are cumulative within
the worker invocation, not a repository diff or session lifetime total. Optional
turns, usage, cost and session are explicitly null when unreported. Usage retains
the reported token fields; absent token fields are unknown, not zero. Reported
zeros remain zero. `session` is the vendor worker identity, never the dispatcher.

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

`scripts/agx-accept.ts SELECTOR`, exposed as `mise run accept -- SELECTOR`, composes the selected
latest run's verification exits, report preview, workspace diff stat, and suggested judge/land
commands. It is read-only; the coordinator runs those commands separately.

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

agx msg chooses `--from` > explicit `AGX_MSG_FROM` > unknown, validates the selected
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
