# Compiled command runtime paths

Build each package's entry with `bun build --compile <entry> --outfile <command>`.
Keep the suite command names on `PATH`, including `agx-msg`, the executable for `agx msg`, and its `xmsg` alias.
Compile messaging once as `agx-msg`; `xmsg` is a hard link to it in `bin/`.
The router and worker launcher resolve those names through `PATH`; installing a
different suite on that path selects that suite explicitly.

Versions, the default worker catalog, and default price roster are static imports
embedded by the compiler. Explicit catalog and price
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

Workspace fleet operations read the L2 repository registry at
`$XDG_CONFIG_HOME/agx/repos/*.toml` (default `~/.config/agx/repos/*.toml`).
Each schema-1 declaration supplies an absolute repository `root`.
`AGX_REPOS_ROOT` retains its directory-inventory meaning for workspace doctor.
See the [configuration contract](../../contract/config.md) for registry rules.

The consumer compatibility checker selects L2-registered repositories with a
`[usehooks]` table; its registry is a runtime input. Revision comparison uses
`USEHOOKS_REPO_ROOT`, defaulting to the current directory, as the suite checkout
and derives `tools/agx-usehooks` from it. `USEHOOKS_BASE` selects the comparison
revision, defaulting to `alpha`. These inputs select the checkout and revision,
independently of consumer discovery.

State continues to use `AGX_STATE_DIR` or the existing XDG location. Ticket homes,
target repository policy, host declarations, session inventories and operating
system files are runtime inputs, not files shipped next to the executable.
