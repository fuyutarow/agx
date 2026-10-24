# Suite releases

The distribution version is `tools/agx/package.json`. One GitHub release at
`v<version>` contains the whole suite. Every command prints this suite version. Member manifest versions are synchronized
for packaging only; consumer contracts retain their own schema numbers. Historical
`<pkg>@<version>` tags remain untouched; new releases create only `v<version>`.
The root `CHANGELOG.md` owns new entries; member changelogs are frozen history.

## Consumers

Install the whole suite with one mise entry:

```toml
[tools]
"github:fuyutarow/agx" = "<version>"
```

mise strips the leading `v` and finds the executables in `bin/`.

For a Bun library consumer, pin the release asset in `package.json`:

```json
"agx-usehooks": "https://github.com/fuyutarow/agx/releases/download/v<version>/agx-usehooks-<version>.tgz"
```

Both asset versions are the suite version.
The library includes its public TypeScript declarations.

## Record and apply changes

```sh
mise run changeset -- minor "Add a suite feature"
mise run lint:changesets
mise run release:version
```

The generator writes a pending Markdown changeset under root `.changes/`.
An optional member scope is accepted: `mise run changeset -- agx-status patch "Fix status output"`.
One invocation consumes all root changesets and any remaining
`tools/*/.changes/*.md` from in-flight branches. The largest bump wins
(`major > minor > patch`), using normal three-component version resets.
All inputs are validated before writes. The suite manifest and packaging mirrors
advance together, one dated section is written to the root changelog, and every
consumed file is removed. The displayed count is the number of consumed files.
An optional legacy member argument to `release:version` still applies the whole
suite. No pending changesets or malformed inputs refuse before writes.
Repeated preparation before a release tag retains one pending suite section.

Review and commit these changes through the normal repository workflow before
publishing. Release commands never commit.

## Build and preview

```sh
mise run release:build -- suite
mise run release:publish -- suite --dry-run
```

The build compiles every member command into `dist/suite/bin/`, printing the suite version for every command. It produces one platform archive:
`dist/agx-<version>-linux-x64.tar.gz` on linux-x64. Its commands are agx,
agx-worker, agx-ws, agx-ticket, agx-status, agx-msg, xmsg and jex.
Messaging is compiled once as `agx-msg`; `xmsg` is a hard link to it inside `bin/`.
The tar archive retains the hard link when extracted, so both names share one
executable. Messaging help, version output and diagnostics name `agx msg`.
The second asset is `dist/agx-usehooks-<version>.tgz`, a platform-independent ESM library.
Both paths and SHA-256 checksums are printed. Staging is cleared before building.

The default target is the host. `--target bun-linux-x64` selects cross compilation;
its Bun compiler runtime must already be available for offline builds. Other Bun
platform targets are accepted. Windows commands have the `.exe` suffix.
The library build uses the cached TypeScript 6.0.3 compiler offline to emit
public declarations. Per-member builds remain available for development.

## Publish

Publishing accepts only `suite`. A member argument exits 2 with a pointer to the
suite command. Publishing defaults to dry-run and refuses a dirty tree, a branch
other than alpha, an existing suite tag, or missing version changelog entries.

The preview builds both assets and prints exact shell-quoted commands for the
suite Git tag and one GitHub release at `v<version>`.
It creates an empty draft, uploads each asset separately, inspects the assets
with `gh release view --json assets`, and publishes with `--draft=false --latest`
only after every expected asset is `uploaded` with the local file's byte size.
The release targets the inspected HEAD. Existing member tags are retained.
Release notes include suite changelog sections added since the previous reachable
suite tag. The first suite release includes the current section. Unreadable
previous suite history refuses publication.

Only `mise run release:publish -- suite --yes` executes the plan. Review the
preview in the canonical repository first. `--yes` and `--dry-run` conflict.
Each asset upload has at most three attempts, with `--clobber` on retries and a
ten-minute timeout per attempt. Other commands have a two-minute timeout.
An upload or verification failure leaves the release as a draft and exits 2.
The refusal names the failing asset, includes captured stderr and stdout (or an
explicit empty-output diagnostic), and prints commands to recover the existing
draft. Tags are never deleted, and release creation is never retried.

For recovery, use the exact paths and expected byte sizes printed by the refusal.
Re-upload the assets to the existing draft with `--clobber`, then inspect them:

```sh
gh release upload v<version> dist/agx-<version>-linux-x64.tar.gz --clobber
gh release upload v<version> dist/agx-usehooks-<version>.tgz --clobber
gh release view v<version> --json assets
```

Check that both names appear exactly once, each state is `uploaded`, and each size
equals its local file's byte size. Only after those checks, publish the draft:

```sh
gh release edit v<version> --draft=false --latest
```

Do not re-create the release or rerun `release:publish` to recover a failed
upload: local tags may already exist. If creation or final publication fails,
inspect the remote release state before using the recovery commands.
