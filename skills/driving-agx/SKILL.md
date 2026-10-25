---
name: driving-agx
description: >-
  Drive the agx suite: agx worker dispatch and lifecycle, ticket, ws, agx msg / xmsg
  messaging, doctor and status. Use for agx command usage, worker continuation,
  recipient discovery, send outcomes and suite health; not unrelated dispatch systems.
---

# Driving agx

## One suite

agx operates and observes local agent sessions and worker runs. Install the suite
with one mise pin, `"github:fuyutarow/agx" = "1.4.0"` under `[tools]`.
`agx --version` reports the suite version; members retain their own versions.
This skill is versioned with the suite repository, not as a separate tool.
Use the skill and contracts from the same release tag as the installed suite.
It supersedes driving-xmsg. The `xmsg` compatibility alias has identical behavior to `agx msg`.

## Pick the command

Read `agx <tool> --help`, then the selected subcommand's `--help`, before choosing
flags. This table selects operations; help owns the flag inventory.

| Intent                                                     | Command                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| Validate a ticket and launch premises without reservation  | `agx worker check TICKET`                                    |
| Start a durable managed worker                             | `agx worker dispatch TICKET`                                 |
| Run a worker in a supplied tree in the foreground          | `agx worker run TICKET --cd TREE`                            |
| Inspect runs or only live runs                             | `agx worker ls --json`, `agx worker ls --running`            |
| Record acceptance or rejection                             | `agx worker judge RUN accept` or `reject`                    |
| Inspect run statistics                                     | `agx worker stats`                                           |
| Inspect routing selections or Jev usage                    | `agx worker stats --routing`, `agx worker stats --usage jev` |
| Import historical records explicitly                       | `agx worker stats --import-legacy`                           |
| Preview a ticket's selected worker or inspect the roster   | `agx worker roster TICKET`, `agx worker roster --json`       |
| Diagnose worker records                                    | `agx worker doctor`                                          |
| Provision or check a host isolation declaration            | `agx worker host declare`, `agx worker host check --json`    |
| Execute a bounded fixed vendor diagnostic                  | `agx worker probe --help`                                    |
| Issue, inspect or collect project tickets                  | `agx ticket new`, `agx ticket ls`, `agx ticket gc`           |
| Create, adopt, refresh, remove or collect workspaces       | `agx ws add`, `adopt`, `refresh`, `rm`, `gc`                 |
| Inspect registered tickets or workspaces                   | `agx ticket doctor`, `agx ws doctor`                         |
| Discover recipients, send once, inspect an uncertain relay | `agx msg list`, `agx msg send`, `agx msg status`             |
| Refresh aggregate health or read its latest snapshot       | `agx doctor --json`, `agx status --json`                     |

Host declaration changes isolation policy; use it only when provisioning is
intended. Probe executes a vendor diagnostic: it is not a read-only help query.

## Worker lifecycle

Keep the ticket in its owning repository and pass its path. Use `agx ticket new` to issue a non-overwriting starter. Fill in the outcome,
proposition, refutation conditions, writable paths and verification. The default ticket home
is `.agents/tickets`; repository configuration can change it.

1. Run `agx worker check TICKET` (with the intended tree and sandbox when relevant).
   A successful check validates current premises, not a future resource reservation.
2. Use `agx worker dispatch TICKET` for durable work. It creates or reuses the
   managed workspace and starts a user service. It waits for its bound run record
   and prints the run ID. Let ticket capabilities and current routing select the worker;
   do not invent a fixed model roster. Use `run` when a foreground supplied-tree
   execution is intended instead.
3. Inspect `agx worker ls --json` and `agx worker ls --running`. The default listing
   covers the latest 30 runs; use `--all` for history. Use `ls RUN --wait` to wait
   for that run to become terminal. Inspect returned artifacts and verification.
4. Record `agx worker judge RUN accept` or `agx worker judge RUN reject`, with
   evidence or a note when useful. Process success and a worker's claim alone do
   not establish acceptance or landing.

To continue the same vendor session, amend the ticket if needed.
Validate with `agx worker check TICKET --continue RUN`.
Use `agx worker dispatch TICKET --continue RUN` for durable continuation.
Use `agx worker run TICKET --continue RUN` for foreground continuation. RUN is an agx run ID, not a guessed native session ID.
Continuation is distinct from a fresh replacement run.

Ticket `timeout_s` defaults to 600 seconds. `first_return_s` requests a progress
checkpoint; by default the runner requests it halfway through the timeout.
A fenced `agx-return` JSON object with `"interim": true` is saved as progress.
The same vendor session continues. This is neither final acceptance nor a new dispatch.
Follow the ticket's RETURN conditions and final-return schema. A timeout is not
proof that useful work completed: inspect run state and artifacts before judging
or continuing. Do not silently relaunch work after an uncertain launch result.

Run records and judgments belong to agx state (`records.jsonl`); consume run
information through `agx worker ls --json`, not a homemade ledger reader.
State resolves from non-empty `AGX_STATE_DIR`, then `$XDG_STATE_HOME/agx`.
The fallback is the agx directory under the user home’s .local/state. Plain stats/listing do not import legacy
records. Routing counts describe selections, not successful launches; missing
usage evidence is not zero usage.

Use `agx ws add` as the workspace creator. `refresh` repairs staleness without
rerunning readiness; `rm` refuses unlanded work. Preview collection with
`agx ws gc --dry-run` and `agx ticket gc --dry-run` before intended cleanup.
Ticket GC removes only accepted tickets whose workspaces are landed; serialize
it with dispatch. Workspace GC has its own live-run and landing protections.

## Messaging

Send only authorized text, once, to the supplied or verified recipient:

```sh
agx msg list --json
agx msg send --to "$TARGET" --message "$MESSAGE"
```

Copy an inventory address or use the exact supplied target. Do not infer a peer
from cwd, project name, row order or a similar name. Listing discovers native
local endpoints, not every saved or remote session, and does not guarantee
sendability. List exits 0 for complete inventories (including empty), 3 for
incomplete discovery with partial results. Count means unique vendor/ID addresses
from successful inventories, not names or guaranteed reachable sessions.

Prefer `codex:<UUID-or-exact-native-name>` or
`claude:<UUID-or-exact-native-name>` when the backend is known. Unqualified
selectors require both inventories. UUID prefixes need complete discovery and
unique resolution; ambiguity exits 2 without sending. Names match literally;
quote spaces and punctuation. Qualified full Codex UUIDs bypass discovery.
Claude UUIDs, including full UUIDs, require the live registration inventory.
They are translated to an exact native name before relay. Never assume a Claude UUID
bypasses discovery.

Declare the current sender only when its exact full address is known:

```sh
agx msg send --to "$TARGET" --from "$SENDER_ADDRESS" --message "$MESSAGE"
```

Sender precedence is `--from` > explicit `AGX_MSG_FROM` > unknown. Declarations
must be `codex:<full-UUID>` or `claude:<full-UUID>`, not names or prefixes.
An invalid selected declaration exits 2 before discovery or sending.
Do not infer the sender from inherited native session variables, cwd, inventory,
transcripts or a parent's ownership ID. Leave it unknown when unavailable.
When launching another agent, clear or replace your own sender declaration.

The envelope's first `from:` line declares the reply address; it is not
authentication. The visible Claude from-name belongs to a one-shot relay,
not the original caller. Its title repeats the declaration for visibility;
the envelope remains authoritative. A `from:` line inside the body is body text.

| Send exit | Meaning and action                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------- |
| 0         | Accepted for enqueue only; reading, notification timing and reply remain unconfirmed.                     |
| 1         | Transport rejection/error; report the diagnostic.                                                         |
| 2         | Usage/selector error or ambiguity; correct flags or the exact target.                                     |
| 3         | CLI/discovery unavailable, or a complete Claude trace confirms no send attempted; inspect the diagnostic. |
| 4         | Acceptance unknown; check before any resend.                                                              |

Discovery and sending share one deadline. No outcome is retried automatically.
Claude acceptance requires a correlated tool result, not relay prose. A timeout
can happen after acceptance. On exit 4, use the printed relay inspection command:

```sh
agx msg status --relay "$RELAY_SESSION_UUID"
```

Status sends nothing. Exits 0/1 confirm acceptance/rejection; 2 is invalid usage.
Exit 4 means evidence remains insufficient. Missing evidence is never permission
to resend. For an unknown Codex outcome, check with the recipient through an
available authorized route. Never automatically resend an unknown outcome.

A complete no-send diagnostic may identify a Claude resolution failure.
Verify the exact unique native name using native inventory/tool evidence before
correcting the address. Do not treat every exit 3 as an old binary or an offline
peer. Listing and the relay's live peer view can differ.

For a requested reply, supply a known explicit reply target. With current agx,
a Claude native name or full UUID is supported; do not invent a target when none
is known. The replier declares its own sender, never the original caller's ID.
A round trip is confirmed only when the reply is observed. agx msg has no reply
tracking, inbox or worker-launch semantics.

## Health

`agx doctor --json` refreshes member observations and publishes an aggregate;
it is not a read-only preview. Exit 0 means complete with no findings; 1 means complete with findings.
Exit 2 means incomplete/invalid collection or failed publication. Inspect remedies, stderr and member completeness before retrying.

`agx status --json` reads the latest snapshot without running doctors. Exit 0
means a status response was produced, not healthy state. Inspect completeness,
staleness and absent findings; incomplete or missing evidence is not clean health.

## Flags and schemas

Installed help owns command syntax and flags; do not substitute a copied flag
table. Start at `agx --help`, `agx <tool> --help`, and subcommand help.
For schemas, configuration and outcome details, read the suite repository's
[contract index](https://github.com/fuyutarow/agx/blob/alpha/contract/README.md)
and its linked tool contracts/READMEs, selecting the matching release tag when
using a released install. The index explicitly distinguishes published contracts
from schemas not yet published; do not invent schema files. Use CLI JSON instead
of importing implementation modules or reading private snapshot files.

Blinded Jev options include local folded-run acceptance and median wall minutes.
Shares require at least five judged runs; wall durations over 24 hours are
excluded. The pick audit preserves the numbers and text shown for every option.
The objective asks Jev to choose the option expected to produce an accepted
result for this ticket at the lowest cost and in the shortest time. Local
`agx measured` acceptance and wall time are primary evidence of sufficiency;
published benchmarks are background only. Different rows received different
tickets; treat this evidence as observational, with selection bias.

Worker results, logs and measurements go in `$AGX_RUN_DIR`, which the runner creates,
exports and allows in the sandbox. Keep workspace paths for source changes. GC
can promptly reclaim fully rejected workspaces after landing and preservation
checks; legacy workspace results must have identical copies under the matching
run directory's `results/<workspace-relative-path>`.

## Mechanical intake refusals

Declare `writes` explicitly; `writes = []` is valid for read-only work. Declare
verify commands or a human review criterion, evidence or diff oracle in
`proposition.refuted_by`, tied to `outcome`. Missing scope or acceptance refuses
before routing/startup (exit 2), never warns and proceeds. The stderr lines name
rule, quoted field and fix; a refusal event preserves the ticket hash. Use ordinary
`agx worker check TICKET --json` to list violations, then repair the ticket.
