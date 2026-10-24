# agx-worker

Dispatch, inspect and judge worker runs. Invoke it directly or through `agx worker`.

The append-only records live at `<state>/records.jsonl`. State resolves from non-empty
`AGX_STATE_DIR`, then `$XDG_STATE_HOME/agx`, then `~/.local/state/agx`. Legacy ledgers
are read only from `<state>/legacy-v1`. Judgments remain available to audit and
statistics views; local run outcomes and grades do not enter model selection criteria.
See the [state migration refusals](contract.md) before migrating existing data.

Import historical runs and lifecycle judgments explicitly with
`agx worker stats --import-legacy`, then read `agx worker ls --json --all`.
Listings include `judgment.at` and imported runs' original identity in `legacy`.
Judgment time determines the latest decision across dated archives and current
records; repeated imports add no duplicate events. Plain listings and stats never
import. See [Legacy judgments](contract.md#legacy-judgments) for tie rules,
provenance, counters, supported sources, and failure semantics.

The [Worker environment, version 1](contract.md#worker-environment-version-1) specifies
`AGX_WORKER=1`, dispatcher identity precedence, child inheritance, and the other worker
environment variables, with source and test references.

[Scope and ownership](docs/scope.md) · Suite architecture · [Caller inventory](docs/suite-callers.md)

[acpx replacement decision](docs/acpx-boundary.md) records the executed hook, sandbox and
capacity comparison, including the code that could be replaced and the integration that remains.

## Dispatch roster

`agx-worker roster TICKET.md` prints the one selected roster row as JSON using the same routing
filter as a run, without starting a worker. Legacy `roster --json` still prints the full validated roster.

```sh
agx-worker roster --json
```

This prints the parsed and validated dispatch roster as JSON. Its shape is the `value` returned by
the internal `loadRoster` function; callers should consume this process output instead of importing
repository source files.

## Durable dispatch

```sh
agx-worker dispatch .agents/tickets/foo-bar.md [--ws other] [--unit agt_other-2] [--sandbox workspace-write] [--continue RUN_ID]
```

Dispatch defaults to the ticket's `name` (or its filename without `.md`): `ws_<name>` and
`agt_<name>`. `--ws` overrides the workspace slug passed to `agx ws add`; `--unit` overrides the
systemd service name. The repository comes from the ticket's location, independently of the caller's
working directory. Dispatch consumes `agx ws add --json` so readiness output cannot become a path.
Dispatch creates or reuses the workspace, refuses an active unit, verifies
the ticket and workspace resolve to the same repository default workspace, then starts the unit.
It waits for a run record containing its binding and prints a labeled dispatch receipt. It exits non-zero when the
unit cannot start or the record does not appear.

## Sandbox capability warnings

Run `agx worker check TICKET --cd TREE --sandbox workspace-write` before dispatch.
Check, run and dispatch warn on stderr before worker startup when a restricted
sandbox conflicts with detectable needs. Warnings name the capability, requested
sandbox, exact `writes`/`verify` entry or workspace store pointer, and `--sandbox none`
as the mode permitting that capability. They are advisory: check still exits 0
when validation succeeds, and no sandbox is upgraded or retried automatically.

Detection covers external Git directories and common stores, jj repo pointers,
symlinked stores, `systemctl`/`systemd-run` commands with `--user`, and the known
`agent-resource-run` wrapper in ticket verification or repository `[verify].always`.
External stores warn even with empty writes because VCS operations may mutate them.
Paths are compared with the canonical `--cd` workspace boundary.

This is static evidence, not an execution or permission probe. Aliases, arbitrary
scripts, nested task definitions, tool internals, additional vendor writable roots,
and host isolation policy are not inferred. Quoted or commented command text may
produce conservative warnings. Unknown tools require operator review; absence of
a warning does not establish compatibility. Choose `--sandbox none` explicitly
only when the task and host policy allow unsandboxed execution.

## Doctor

`agx-worker doctor` diagnoses worker records only. Each finding is one JSON line with
`tool`, `object` (repository and run id), `finding`, and `remedy`. Exit 0 means clean, 1 means
findings, and 2 means incomplete diagnostics or usage failure. `scripts/agx-doctor.ts` composes
this output with `agx ws doctor` and `agx ticket doctor`; composition is outside the suite dispatcher.

## Host declaration

Provision an isolated host through the owner CLI:

```sh
agx worker host declare --unsandboxed-reason "This disposable host is itself the isolation boundary"
agx worker host check --json
```

`check` exits 0 for valid, 1 for absent, and 2 for invalid or unreadable declarations.
It emits one versioned JSON object with `path`, `status`, `declaration` and `reason`.
`declare` creates exclusively with file mode 0600 and missing directory mode 0700;
it refuses existing files, final symlinks and unmigrated retired declarations.
Use this CLI for provisioning and validation instead of copying the file reader.
See the [host declaration contract](contract.md#host-declaration) for path overrides,
JSON compatibility, input schema, permissions and failure handling.

## Routing statistics

```sh
agx worker stats --routing --window 24h
agx worker stats --routing --window 24h --host build-host
```

This prints schema 1 JSON for selections recorded in the trailing window on the
exact host name (the local hostname by default). `jev.denominator` counts Jev
selections; `jev.codex_pick_count` counts those selecting Codex. `jev.codex_share`
is their ratio from 0 to 1, or null when the denominator is zero. Fallback selections
are counted separately. Counts describe selections, including `roster TICKET`,
not successful worker launches. History coverage is explicitly partial, including
when no events were observed. Subscription allowance, executable presence and
unprobed sandbox capability are separate fields; unknown usage is not a failure.
See the [routing statistics contract](contract.md#routing-statistics-schema-1)
for bounds, freshness, coverage, failures and compatibility.

## Vendor diagnostic

Run a bounded Codex sandbox diagnostic on the target host without a ticket or run
records:

```sh
agx worker probe --vendor codex --sandbox workspace-write --cd /path/to/tree --timeout-ms 30000 --json
```

The fixed diagnostic runs a marker command and returns a marker reply. JSON schema
1 reports requested and effective sandbox, executable, process/startup/result
timing, timeout, vendor exit and a classified outcome. Exit 0 means the complete
diagnostic succeeded; exit 1 means timeout, failed execution or invalid output;
exit 2 means refusal or an unavailable executable. A host declaration can change
the effective sandbox, which the report states explicitly. See the
[vendor probe contract](contract.md#vendor-probe-json-schema-1) for bounds,
nullable fields, cleanup and compatibility. Invoke this command through SSH to
inspect a remote host; its output is the public interface.

## Jev token usage

```sh
agx worker stats --usage jev --window 7d
```

Returns schema-1 JSON with trailing seven-day token totals, known subtotals,
window and collection timestamps, effective USD rates with their catalog source
and date, estimates, completeness and unknown counters. Missing historical usage
is explicit; no usage evidence produces `null` rather than zero tokens.
Totals cover retained observations only, and are `null` when inspected records
have missing usage. Routing attempts are captured even when selection falls back
or no worker subsequently starts. Retained legacy usage is included without an
import. Prices describe effective configuration, not a historical bill.
See [Jev usage JSON, version 1](contract.md#jev-usage-json-version-1) for count,
coverage, compatibility and exit semantics. The command is read-only; consume its
JSON rather than reading private journals.

## List runs

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

## Receipts and outcomes

`agx worker dispatch TICKET --json` returns the run ID, actual absolute workspace,
selected roster row, route, model and effort, plus requested/effective sandbox and
source. Plain dispatch prints the same fields with labels after the ID; scripts
should use JSON and read `id`. A dispatch receipt confirms launch, not completion.

`agx worker ls --json` exposes each run's outcome; `agx worker stats` counts ended
runs in `by_outcome`. A run killed at its own deadline is `timeout`. Vendor resource
unavailability is `capacity`; a worker/execution refusal is `refused`. Successful
completion is `ok` when promised files changed and `no-change` when none changed;
both require a valid report and passing verification. See the full
[receipt and outcome contract](contract.md#dispatch-receipt-and-run-outcomes)
for all values, precedence, compatibility and exit semantics.

Routing audits are retained in the private routing journal before worker startup.
`agx worker stats --routing --json` reports row pick counts, top-two probability
margins, TB4 luna exclusions, refusals and pre-start failures. Counts describe
routing selections, including fallbacks, rather than worker success or rejection.
See [the routing audit contract](contract.md#routing-audit-journal) for retained
request, filtering, replay and missing-evidence semantics.

Worker results belong in `$AGX_RUN_DIR`, the current run's directory under the agx
state root (`runs/<run-id>`, alongside `report.json`). The runner creates and exports
this directory and grants it sandbox write access. Write results, logs and
measurements there; keep source changes in the workspace. Each continuation has
its own run directory.
