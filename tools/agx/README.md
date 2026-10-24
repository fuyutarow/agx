# agx

A suite dispatcher with an aggregate doctor:

- `agx doctor --json --refresh` → bounded, coalesced refresh with last-good findings and stale/error fields
- `agx worker ARGS` → `agx-worker ARGS`
- `agx ticket ARGS` → `agx-ticket ARGS`
- `agx ws ARGS` → `agx-ws ARGS`
- `agx status ARGS` → `agx-status ARGS`
- `agx msg ARGS` → `agx-msg ARGS`

`agx msg` is the canonical messaging command; `xmsg` aliases the same executable.
Help, version output, and diagnostics use `agx msg`.

Arguments and child exit status pass through. `agx -V` prints the suite version only.
Compiled `agx` first uses executable tools in its own installation directory, then
falls back to PATH. Running from source under Bun uses PATH only.
`agx -h` takes each tool’s one-line description from its help using the same lookup.

Only `worker`, `ticket`, `ws`, `status`, `msg`, and `doctor` are accepted as tools. An unknown tool exits 2
with one stderr line naming the accepted tools and no stdout output.

See [worker interfaces](../agx-worker/README.md) for worker commands.

The suite forwards the environment unchanged. Its owner tools use non-empty
`AGX_STATE_DIR`, then `$XDG_STATE_HOME/agx`, then `~/.local/state/agx`.
The legacy ledger is read-only at `<state dir>/legacy-v1/`. Owner tools refuse
retired state configuration with exit 2 before running a command.

Poll `agx status --json` every 60 seconds (`poll_after_ms:60000`); schedule
`agx doctor --json --refresh` at that cadence to refresh member observations.
The default whole-request deadline is 25 seconds, including queue wait.

See the [doctor contract](../../contract/doctor.md) for JSON, deadlines, exits and persistence.
