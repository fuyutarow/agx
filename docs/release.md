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
agx-worker, agx-ws, agx-ticket, agx-status, xmsg, agx-msg and jex.
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
The release targets the inspected HEAD. Existing member tags are retained.
Release notes list every member version and include all changelog sections added
since the previous reachable suite tag. The first suite release includes current
sections. Unreadable previous member history refuses publication.

Only `mise run release:publish -- suite --yes` executes the plan. Review the
preview in the canonical repository first. `--yes` and `--dry-run` conflict.
Publication stops at the first failure; inspect existing tags and the remote
release before recovery. The command never deletes tags or retries publication.
