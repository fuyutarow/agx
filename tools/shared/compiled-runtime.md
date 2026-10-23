# Compiled command runtime paths

Build each package's entry with `bun build --compile <entry> --outfile <command>`.
Keep the suite command names on `PATH`, including `agx-msg` as an alias for `xmsg`.
The router and worker launcher resolve those names through `PATH`; installing a
different suite on that path selects that suite explicitly.

Versions, the default worker catalog, default price roster, and consumer-checker
registry are static imports embedded by the compiler. Explicit catalog and price
paths select exactly that file. A missing or invalid override never selects the
embedded default instead. Worker policy remains external: `AGX_CONFIG`, otherwise
`$XDG_CONFIG_HOME/agx/agx.toml` (default `~/.config/agx/agx.toml`).

Read-only VCS commands require `bun` on `PATH`, alongside the requested VCS binary.
The helper's complete source is embedded as text and evaluated in a separate Bun
process. It installs the existing kernel write restriction before native `execv`.
No helper source file is opened at runtime. This keeps restriction setup away from
the caller's native threads and keeps deadline cancellation safe.

Worker subprocesses use `agx-worker --internal-codex` or `--internal-claude` and
load the bundled modules. These flags are internal transport, not additional
public commands. `AGX_WORKER_BIN` remains an explicit Bun script override for
custom workers and fixtures; its path is supplied by the caller.

Workspace fleet operations use `AGX_REGISTRY_ROOT`, defaulting to the invocation's
current directory, for `presets/consumers.toml`. API callers can pass the root
directly. `AGX_REPOS_ROOT` retains its directory-inventory meaning for workspace
doctor. No registry is guessed from an executable or source directory.

The consumer compatibility checker embeds `tools/agx-usehooks/consumers.toml` but
needs an explicit checkout to compare revisions: `USEHOOKS_REPO_ROOT`, defaulting
to the current directory. It derives `tools/agx-usehooks` from that checkout.
Consumer roots in the embedded registry are user input and are expanded as before.

State continues to use `AGX_STATE_DIR` or the existing XDG location. Ticket homes,
target repository policy, host declarations, session inventories and operating
system files are runtime inputs, not files shipped next to the executable.
