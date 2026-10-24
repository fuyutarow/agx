# Doctor consumer contract (schema 1)

Shell scripts, agents and interactive operators use `agx doctor --json` to refresh
all member observations. `agx status --json` reads the latest owner snapshot without
running doctors. The aggregate is implemented inside the agx package: composition
and persistence belong to the umbrella, so no additional member binary is needed.

## Invocation and effects

`agx doctor [--json] [--timeout-ms N]` accepts no operands or stdin. Output is always
one JSON object followed by a newline, including when `--json` is omitted. Help
(`--help`, `-h`) and version (`--version`, `-V`) do not collect or publish.
Unknown flags are rejected by the standard parser; invalid operands or deadlines
exit 2 before collection. `--timeout-ms` is an integer from 1 through 60000;
the default is 10000 milliseconds per member.

The default is **refresh**, not snapshot. Every invocation concurrently runs
`agx-worker doctor --quiet`, `agx-ws doctor --quiet` and
`agx-ticket doctor --quiet`, then publishes the result. The member commands may
reconcile or publish their own state; this command is not a read-only preview.
There is no separate `--refresh` flag. Use status for a read-only snapshot.
Compiled installs prefer executable sibling member tools; source runs resolve
members on PATH. Existing member JSONL and exit behavior remain unchanged.

Each member has a deadline and a 1 MiB limit for each of stdout and stderr.
Timeout or overflow kills the member. Member stderr and collection diagnostics
are relayed to stderr; stdout contains only aggregate JSON, on TTY and pipes alike.
Member order and finding order are deterministic (worker, ws, ticket; then member
line order). This is a bounded collection, not a transaction across member state.

## JSON and outcomes

The object has these fields:

| Field         | Meaning                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`      | Integer 1.                                                                                                                                 |
| `findings`    | Validated member records `{tool,object,finding,remedy}`; no synthetic collection-error records.                                            |
| `kinds`       | Counts keyed by the exact `finding` string.                                                                                                |
| `total`       | Number of validated records, including duplicates.                                                                                         |
| `lost`        | Count whose `finding` is exactly `lost`; also included in total and kinds.                                                                 |
| `complete`    | All three observations valid and publication succeeded.                                                                                    |
| `captured_at` | Unix epoch milliseconds at the end of collection.                                                                                          |
| `members`     | Three `{tool,exit,complete}` objects; tool is the member executable name; exit is its numeric status, or null if it could not be observed. |

A member is complete only for valid JSONL matching its tool, exit 0 with no
findings, or exit 1 with at least one finding. Blank lines are ignored. Malformed
JSON, invalid fields, a different tool, unexplained exit 1, findings with exit 0,
exit 2 or another exit, spawn failure, timeout and overflow make it incomplete.
Valid records already collected remain visible; counts describe observed records,
never an estimate of missing findings. A member failure is not itself a finding.

| Exit | Meaning                                              | Caller action                                   |
| ---- | ---------------------------------------------------- | ----------------------------------------------- |
| 0    | Complete, no findings.                               | Continue.                                       |
| 1    | Complete, findings present.                          | Inspect findings and remedies.                  |
| 2    | Incomplete/invalid collection or failed publication. | Inspect stderr and members; retry after repair. |

Incomplete aggregates are published too, replacing an older successful snapshot,
so status cannot silently present an older success after failed collection.
Publication failure emits `complete:false` and exits 2, leaving the prior target
intact. Retrying refresh is supported; member reconciliation effects still apply.

## Persistence, status and compatibility

Agx owns `doctor-aggregate.json` under non-empty `AGX_STATE_DIR`, otherwise
`$XDG_STATE_HOME/agx`, otherwise `~/.local/state/agx`. Retired state configuration
is refused before collection. A unique, exclusive, mode-0600 temporary file in the
same directory is fully written, then renamed over the target. Readers see a
whole old or new snapshot; concurrent writers use last successful rename wins.
This provides atomic visibility, not power-loss durability or global locking.
Temporary files are cleaned on handled failures. A forced umbrella termination can
leave a temporary file and the previous snapshot.

The file is private storage, **not a public file API**; consumers use CLI JSON.
`agx status --json` exposes the validated aggregate under `findings`, adding
`stale` when incomplete or captured before another observed state file changed.
A malformed aggregate yields `findings:null`. When the aggregate is absent,
status preserves its existing legacy summary fallback (or null). Status itself
remains read-only and exits 0 for a successfully produced status response;
callers must inspect `findings.complete`, `stale`, or absence.

Consumers must tolerate additive fields and unknown finding strings. Field
removal, renaming, type/meaning changes or incompatible exit semantics require a
major release. Shape changes use a new schema version. No public pathname
or direct-file compatibility promise is made.

## Verification

`bun test ./tools/agx ./tools/agx-status` spawns the real umbrella against isolated
fixture member executables, checks exits 0/1/2, invalid JSONL/records, tool mismatch,
unexplained exits, timeout, output overflow, partial retention, publication failure,
replacement inode and file permissions, and the real status CLI reading exactly
the persisted aggregate. All CLI fixtures set both AGX_STATE_DIR and XDG_STATE_HOME.
