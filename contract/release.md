# Release assets

Release `v<suite>` contains exactly four suite archives:

- `agx-<suite>-linux-x64.tar.gz`
- `agx-<suite>-linux-arm64.tar.gz`
- `agx-<suite>-darwin-x64.tar.gz`
- `agx-<suite>-darwin-arm64.tar.gz`

Each archive contains all suite commands in `bin/`, including `xmsg` as a
hard link to `agx-msg`. Unsupported platforms have no suite asset: mise
installation fails without a library fallback.

The platform-independent library is published only at `usehooks-v<suite>`:

`https://github.com/fuyutarow/agx/releases/download/usehooks-v<suite>/agx-usehooks-<suite>.tgz`

Both releases check uploaded states and byte sizes before publication. The
library release is never marked latest. See [release operations](../docs/release.md).

Local `release:publish` creates the two version tags and atomically pushes alpha
and both tags. It never builds or uploads archives. `.github/workflows/release.yml`
runs on pushes of `v[0-9]*` and `usehooks-v[0-9]*`; its Bun entry point rejects
a tag that differs from the suite manifest. Each run builds and verifies the
assets for its own tag. Missing archives or incomplete uploads fail the run
before that release is published.

## Machine completion

Declare agx exactly once, in the user-global mise configuration, as
`"github:fuyutarow/agx" = "latest"`, with no lock. Repositories must not declare
agx in `mise.toml` or `mise.lock`.

A release is complete only after the machine completion step passes.
`release:publish -- suite --yes` ends with this step; after separate publication,
run `mise run release:machine`. It waits up to 900 seconds for the published
`v<suite>` release to list all four platform archives as uploaded and nonempty,
then runs `mise install github:fuyutarow/agx@<suite>` from the user's home.
Repeatable `--verify-in DIR` adds consumers to the mandatory home check.
Each check runs `mise exec -C DIR -- agx -V`, requiring exactly `agx <suite>`.
The step prints one success line per distinct directory and exits 1 naming the
step and directory on failure. It never writes into consumer directories.
`--wait-seconds` and `--poll-seconds` control the bounded asset wait.
