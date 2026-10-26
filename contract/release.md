# Release assets

Release `v<suite>` contains exactly four suite archives:

- `agx-<suite>-linux-x64.tar.gz`
- `agx-<suite>-linux-arm64.tar.gz`
- `agx-<suite>-darwin-x64.tar.gz`
- `agx-<suite>-darwin-arm64.tar.gz`

Each archive contains all suite commands in `bin/`, including `xmsg` as a
hard link to `agx-msg`. Unsupported platforms have no suite asset and cannot
install the suite.

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

The workflow also accepts a manual dispatch with one required string input,
`tag` (`v<suite>` or `usehooks-v<suite>`). It checks out exactly that tag and
passes it to the same CI entry point. When no run appears after a push,
`release:publish` prints `gh workflow run release.yml --ref alpha -f tag=v<suite>`
and the equivalent library command before waiting for assets. Recovery leaves
existing tags unchanged.

## Machine completion

Install agx from the existing Homebrew tap:

```sh
brew install fuyutarow/tap/agx
```

A release is complete only after `release:machine` succeeds. After the four
assets are uploaded, it triggers `gh workflow run update-formulas.yml -R
fuyutarow/homebrew-tap -f tool=agx` and prints the tap run URL. Failure to
start that workflow is a warning. The workflow in the tap repository owns
formula updates. `release:publish -- suite --yes` runs this same completion
step at the end.

The machine step waits for the tap's default-branch `Formula/agx.rb` to name the
release version, then runs `brew update` and `brew upgrade fuyutarow/tap/agx`
(or `brew install fuyutarow/tap/agx` when absent). The formula is fetched from
the raw file with an independent 900-second default deadline. Home and each
requested consumer are checked by running `agx -V` through `PATH` in that
directory. A resolved path outside Homebrew fails and names the path.

Repeatable `--verify-in DIR` adds consumer checks to the mandatory home check.
Each check requires exactly `agx <suite>`.
The step prints one success line per distinct directory and exits 1 naming the
step and directory on failure. `--wait-seconds` and `--poll-seconds` control
the bounded asset wait; `--formula-seconds` bounds waiting for the tap formula.
