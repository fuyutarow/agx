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
