# Doctor consumer contract (schema 1)

Shell scripts, agents and interactive operators use `agx doctor --json --refresh`
for bounded member observation. `agx status --json` reads the latest owner result
without running doctors. Composition, refresh admission and persistence belong to
agx. Consumers poll CLI JSON; no state file or filesystem watch is a public API.

## Invocation and effects

`agx doctor [--json] [--refresh] [--timeout-ms N] [--deadline-ms N]` accepts no
operands or stdin. Output is one JSON object followed by a newline, including when
`--json` is omitted. Help and version do not collect or publish. Unknown flags are
rejected by the standard parser; invalid operands or deadlines exit 2 before
collection. Retired state configuration is refused before collection.

Refresh remains the default for compatibility with the original aggregate
command. `--refresh` explicitly requests that same behavior. Use status for a
read-only snapshot. A collection concurrently runs `agx-worker doctor --quiet`,
`agx-ws doctor --quiet` and `agx-ticket doctor --quiet`. Those members may reconcile
or publish their own state; refresh is not a preview or a transaction across them.
Compiled installs prefer executable sibling tools; source runs resolve members on
PATH. Existing member JSONL and exits are unchanged.

| Bound               | Default   | Accepted values and meaning                                                                                                                                          |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--timeout-ms`      | 60000 ms  | Integer 1..60000; each member's collection deadline.                                                                                                                 |
| `--deadline-ms`     | 125000 ms | Integer 1..125000; whole request budget including admission, queue wait and collection. A member gets the smaller of its timeout and the request's remaining budget. |
| Output              | 1 MiB     | Per member, separately for stdout and stderr; overflow kills the member.                                                                                             |
| Active collections  | 1         | Per resolved state directory, across CLI processes; the three members run concurrently within that collection.                                                       |
| Pending collections | 1         | Concurrent arrivals coalesce into the next collection, sharing its completed response. No per-caller collection queue is created.                                    |

The 60000 ms member default allows real inventories that take tens of seconds:
production agx-ticket returned 263 findings after more than ten seconds, so the
former 10000 ms limit killed a healthy doctor. Sixty seconds provides headroom
while bounding a stalled member. The 125000 ms request default allows one active
and one pending 60000 ms collection plus admission and publication overhead.
Explicit shorter request budgets still cap the effective member deadline.

A caller arriving during a collection requests the single pending collection.
After the active collection finishes, one waiting caller collects and the others
share its result. Further arrivals during that next collection may request one
more pending collection. Pending work needs a surviving caller: if every waiter
times out, no background refresh is launched. A waiter's timeout returns its own
stale/error response and does not cancel the active owner or replace the shared
result. The caller elected to collect supplies that collection's deadlines; a
waiter's flags cannot lengthen the active owner's deadline.

Timeout kills the direct member and closes its output readers, including pipes
held open by descendants. Process scheduling, uninterruptible filesystem I/O and
startup overhead can delay return beyond the requested budget; the deadline is
not a real-time scheduling guarantee. No automatic retries occur inside a request.
An abruptly terminated owner is not replaced automatically: admission fails closed
and later callers reach their deadlines rather than risk duplicate member effects.

Member stderr and collection diagnostics go to stderr. Stdout contains only JSON
on TTY and pipes alike. Finding order is deterministic: worker, ws, ticket, then
member line order. A joined caller receives the completed JSON result, while
member stderr belongs to the collecting caller.

## JSON and outcomes

| Field          | Meaning                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`       | Integer 1.                                                                                                                                                           |
| `findings`     | Validated member records `{tool,object,finding,remedy}`; no synthetic collection errors.                                                                             |
| `kinds`        | Counts keyed by the exact finding string.                                                                                                                            |
| `total`        | Number of validated records, including duplicates.                                                                                                                   |
| `lost`         | Count whose finding is exactly `lost`, also included in total and kinds.                                                                                             |
| `complete`     | Latest completed refresh collected valid observations and published successfully. False for a failed request even when cached findings are available.                |
| `captured_at`  | Unix epoch milliseconds when the displayed findings were collected. A failed refresh does not advance the last-good observation time.                                |
| `members`      | Three member objects described below; on collection failure these describe the attempted collection, including when findings are cached.                             |
| `stale`        | Always present. True on refresh failure; status also marks observations stale at age 60000 ms or when another observed owner publication is newer.                   |
| `error`        | Always present. Null on success, otherwise a diagnostic string for collection, deadline, publication or coordination failure. Text is diagnostic, not a stable enum. |
| `last_good_at` | Always present. Last complete observation's epoch milliseconds, or null if no good snapshot is available.                                                            |

Each member has `tool`, `exit` (numeric or null if unavailable), `complete`,
`timed_out`, `deadline_ms` (effective budget after the request cap), and `signal`
(signal name or null). Deadline kills set `timed_out:true` and name the tool,
budget and signal on stderr, for example `agx-ticket exceeded 60000 ms (signal
SIGKILL, exit 137)`. External kills and output overflow do not set `timed_out`.
Older snapshots and failures before collection may omit the additive fields.

A member is complete only for valid JSONL matching its tool, exit 0 without
findings, or exit 1 with findings. Blank lines are ignored. Invalid JSON or fields,
a different tool, unexplained exit 1, findings with exit 0, exit 2 or another exit,
spawn failure, timeout and overflow make the observation incomplete.

On failure, findings, counts and capture time come from the last complete
snapshot, with `complete:false`, `stale:true` and a non-null error. If no complete
snapshot exists, validated records from the failed attempt remain visible with
`last_good_at:null`; they are partial evidence, never an estimate of missing
findings. Members describe the failed attempt when one was collected; failures
before collection retain cached members or unavailable placeholders. Inspect
stderr for failed-member details.

| Exit | Meaning                                                                                   | Caller action                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0    | Complete refresh, no findings.                                                            | Continue polling.                                                                                                        |
| 1    | Complete refresh, findings present.                                                       | Inspect findings and remedies.                                                                                           |
| 2    | Invalid invocation, incomplete collection, deadline, coordination or publication failure. | Inspect JSON error and stderr; retain the displayed last-good observation and retry on the polling cadence after repair. |

Usage and startup refusals can exit before a JSON response exists. A rendered
error response never exits 0. A subsequent successful refresh clears the retained
error and replaces the good snapshot.

## Polling and persistence

Poll `agx status --json` every **60 seconds**; its top-level `poll_after_ms:60000`
publishes this cadence. Arrange `agx doctor --json --refresh` on the same cadence
when fresh member observations are required. Keep one invocation outstanding per
poller; skip overlapping ticks or coalesce them into one pending tick. Agx enforces
the collection bounds across pollers too. Use process completion and JSON fields,
not private file changes, as the observation boundary.

Agx uses non-empty `AGX_STATE_DIR`, otherwise `$XDG_STATE_HOME/agx`, otherwise
`~/.local/state/agx`. Its private coordination database atomically admits collectors
and retains one completed response. It does not hold a database transaction while
members run. A complete aggregate is written to an exclusive mode-0600 temporary
file beside the owner snapshot, then atomically renamed over it. Failed collection
and publication leave the prior good target intact. Handled failures clean up
temporary files. These guarantees concern visibility, not power-loss durability.

`agx status --json` exposes the completed response under `findings`, including the
retained failure and cached findings. While a refresh is active, status reads the
previous completed result; age and publication checks still apply. Malformed or
unreadable owner state yields `findings:null`. Before any aggregate exists, status
preserves the legacy summary fallback or null. Legacy summaries do not supply the
full refresh contract. Status is read-only and exits 0 when it produces a status
response; consumers must inspect completeness, stale/error and absence.

Consumers tolerate additive fields and unknown finding strings. The new fields
extend schema 1. Removal, renaming, incompatible types/meanings or exit changes
require a major release and an incompatible shape uses a new schema version.
No pathname or direct-file compatibility promise is made.

## Verification

`bun test ./tools/agx ./tools/agx-status` spawns the real umbrella CLI against
isolated fixture executables. It checks exits 0/1/2, invalid records, missing
members, timeout, overflow, partial evidence, publication failure, atomic
replacement and permissions, plus real status output. The refresh tests also
check seven simultaneous callers producing exactly two non-overlapping member
rounds, last-good bytes and inode surviving failure, error visibility through
status, successful recovery, a whole-request deadline and an independent waiter's
deadline. Slow-member fixtures also verify that 15-second and 30-second doctors
complete under defaults, deadline kills retain their tool, budget and signal
through status and cached findings, and external SIGKILL is distinguished from
a deadline. CLI fixtures set both AGX_STATE_DIR and XDG_STATE_HOME.
