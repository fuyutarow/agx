# Suite releases

The distribution version is `tools/agx/package.json`. One GitHub release at
`v<version>` contains the whole suite. Members retain their own versions and
changelogs, with `<pkg>@<version>` Git tags for history only.

## Consumers

Install the whole suite with one mise entry:

```toml
[tools]
"github:fuyutarow/agx" = "<version>"
```

mise strips the leading `v` and finds the executables in `bin/`.

For a Bun library consumer, pin the release asset in `package.json`:

```json
"agx-usehooks": "https://github.com/fuyutarow/agx/releases/download/v<version>/agx-usehooks-<v>.tgz"
```

Here `<version>` is the suite version and `<v>` is the library member version.
The library includes its public TypeScript declarations.

## Record and apply changes

```sh
mise run changeset -- agx-status patch "Fix status output"
mise run lint:changesets
mise run release:version -- agx-status
```

The generator writes a pending Markdown changeset under `tools/<pkg>/.changes/`.
Its entry is one plain-text line. Versioning applies the highest pending level
(`major > minor > patch`) with normal SemVer resets, prepends dated changelog
bullets, and removes the consumed changesets. The current version must have three
numeric components. Missing changesets or malformed inputs refuse before writes.

Applying a member's changesets also bumps agx by the highest level among that
member's changesets and agx's pending changesets. The agx changelog names the
member and its new version. Applying agx directly bumps it once. Separate member
version commands each advance the suite; review the resulting version before
release. Other members' versions and pending changesets remain untouched.

Review and commit these changes through the normal repository workflow before
publishing. Release commands never commit.

## Build and preview

```sh
mise run release:build -- suite
mise run release:publish -- suite --dry-run
```

The build compiles every member command into `dist/suite/bin/`, retaining each
member's own version output. It produces one platform archive:
`dist/agx-<version>-linux-x64.tar.gz` on linux-x64. Its commands are agx,
agx-worker, agx-ws, agx-ticket, agx-status, agx-msg, xmsg and jex.
Messaging is compiled once as `agx-msg`; `xmsg` is a hard link to it inside `bin/`.
The tar archive retains the hard link when extracted, so both names share one
executable. Messaging help, version output and diagnostics name `agx msg`.
The second asset is `dist/agx-usehooks-<v>.tgz`, a platform-independent ESM library.
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
suite Git tag, missing member Git tags, and one GitHub release at `v<version>`.
It creates an empty draft, uploads each asset separately, inspects the assets
with `gh release view --json assets`, and publishes with `--draft=false --latest`
only after every expected asset is `uploaded` with the local file's byte size.
The release targets the inspected HEAD. Existing member tags are retained.
Release notes list every member version and include all changelog sections added
since the previous reachable suite tag. The first suite release includes current
sections. Unreadable previous member history refuses publication.

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
gh release upload v<version> dist/agx-usehooks-<v>.tgz --clobber
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
