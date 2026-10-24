# agx-status

State uses non-empty `AGX_STATE_DIR`, otherwise non-empty `XDG_STATE_HOME` plus
`/agx`, otherwise `~/.local/state/agx`. The legacy ledger is read-only at
`<state dir>/legacy-v1/` and has no separate environment variable.

Startup refuses retired state configuration with exit 2 and migration guidance.
It never moves data automatically.

See tools architecture.

`agx status --json` is read-only. Poll every **60 seconds**, as indicated by
top-level `poll_after_ms:60000`. Schedule `agx doctor --json --refresh` on the same
cadence when fresh member observations are required. Keep one request outstanding
per poller and coalesce overlapping ticks; agx also bounds collections across
processes. Read CLI JSON instead of watching private files.

Aggregate `findings` includes `complete`, `stale`, `error` and `last_good_at`. A
failed refresh retains last-good findings with an explicit error; a later success
clears it. Observations at least 60 seconds old are stale. Missing/malformed state
can yield null; status exiting 0 does not establish freshness. See the
[doctor contract](../../contract/doctor.md) for deadlines, coalescing, exits and
legacy fallback.
