bump: minor

A repository can set the default sandbox of its worker runs: `[worker] sandbox = "none"` (or `read-only`, `workspace-write`) in the committed `agx.toml`. The order is `--sandbox`, then the ticket, then the continued run, then `agx.toml`, then `workspace-write`; a ticket that names a sandbox keeps it. Dispatch and run output show the value with the source `agx.toml`, and `agx worker config` lists `worker.sandbox`. The machine-local `repos/<name>.toml` rejects the key.
