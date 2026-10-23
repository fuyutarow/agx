# Package releases

Each release contains exactly one package, at the version in its own
`tools/<pkg>/package.json`. Each package owns its `CHANGELOG.md` and `.changes`.
There is no repository release version or repository release tag. Only
`release:version` changes a package version, using that package's pending
changesets. Release tags are `<pkg>@<version>`, with one GitHub release per tag.

## Record and apply changes

Record each package change before releasing it:

```sh
mise run changeset -- agx-status patch "Fix status output"
mise run lint:changesets
mise run release:version -- agx-status
```

`changeset` writes `tools/<pkg>/.changes/<slug>.md`, choosing a numbered suffix
when the slug already exists. Packages are directories under `tools/` with a
`package.json`. The entry must be one plain-text line without a Markdown bullet
or heading. The file format is:

```md
---
bump: patch
---

Fix status output
```

Existing delimiter-free changesets remain valid. `lint:changesets` rejects unknown
packages, invalid levels and malformed entries. It also runs through `lint` and
`check`.

`release:version -- <pkg>` reads only the selected package's pending Markdown
files. It applies the highest level (`major > minor > patch`) once, with normal
SemVer resets: `1.2.3` becomes `2.0.0`, `1.3.0` or `1.2.4`, respectively. This
rule also applies below `1.0.0`. The current version must be three numeric
components, without a prerelease or build suffix.

The task updates `tools/<pkg>/package.json`, prepends a dated version section
under `# Changelog` in `tools/<pkg>/CHANGELOG.md`, and removes the applied files.
Every entry becomes one bullet, ordered by changeset filename. A missing changelog
is created. With no pending changesets, it refuses with exit 2 and changes no
files. Other packages' versions and changesets stay untouched.

Review and commit the updated package manifest, changelog and changeset deletions
before building or publishing. The complete sequence is changeset →
release:version → commit → release:build → release:publish. Commit through the
repository's normal review and commit workflow; the release tasks never commit.

## Build and preview

```sh
mise run release:build -- agx-status
mise run release:publish -- agx-status
mise run release:publish -- agx-status --dry-run
```

Build compiles the package's manifest commands into single-file executables in
`dist/<pkg>/bin/`. The archive is
`dist/<pkg>-<version>-<os>-<arch>.tar.gz`, containing only `bin/` and its executables.
The output includes the absolute archive path and its SHA-256 checksum. A build
clears that package's staging directory, so removed commands cannot leak into
later archives. xmsg includes both `bin/xmsg` and `bin/agx-msg`.

The default target is the host. Cross compilation accepts Bun targets:

```sh
mise run release:build -- agx-status --target bun-linux-x64
mise run release:publish -- agx-status --target bun-linux-x64 --dry-run
```

OS and architecture names use Bun/Node host conventions (`linux`, `darwin`,
`win32`; `x64`, `arm64`). Windows commands have the `.exe` suffix. Cross compilation
requires the matching Bun runtime to be available to the compiler; it may require
a download.

Executable packages are agx, agx-worker, agx-ws, agx-ticket, agx-status, xmsg and
jex. Unknown packages are refused with exit 2.

Packages without commands are built as Bun ESM libraries. The library's `source`
entry is bundled into `dist/<pkg>/index.js`, including sibling shared runtime
sources. TypeScript 6.0.3 emits public declarations using the package's
`tsconfig.release.json`; referenced local declarations are copied alongside them.
The staged manifest selects the runtime and type entries. Its `files` allowlist
ships the bundle, declarations, README and CHANGELOG, excluding tests and pending
changesets. Declaration dependencies are pinned to the repository's resolved
versions. This build requires the pinned TypeScript compiler in Bun's local cache
and runs it offline.

`bun pm pack` packs the staging directory as `dist/<pkg>-<version>.tgz`.
The output includes its absolute path and SHA-256 checksum. Library archives are
platform independent; `--target` applies only to executable packages.

`mise run release:build -- agx-usehooks` builds the library tarball;
`mise run release:publish -- agx-usehooks` previews attaching it to its own
`agx-usehooks@<version>` release with the same publication refusals.

## Publish

Publish defaults to dry-run, including when no flag is supplied. It refuses a
dirty working copy (including untracked files), an existing local package tag, or
a missing or empty changelog entry for the package version. It reads the dated
version section written by `release:version`, then builds the
archive and writes just that version's changelog section to
`dist/<pkg>/release-notes.md`.

The preview prints shell-quoted, exact `git tag` and `gh release create` commands.
The release title is the package tag. The GitHub release targets the inspected
HEAD commit, rather than relying on the remote default branch. Run previews from
the repository root. No tag or GitHub release is created during a preview.

Only an explicit `--yes` executes publication, using Git and an authenticated
GitHub CLI. `--yes` and `--dry-run` together are refused. Run this only from the
canonical repository after reviewing the preview:

```sh
mise run release:publish -- agx-status --yes
```

Publication stops on the first command failure. If GitHub publication fails after
the local tag was created, inspect the local tag and remote release before taking
recovery action; the task never deletes a tag or retries publication automatically.

## Consumers

Pin each tool independently with mise:

```toml
[tool_alias]
agx-status = "github:fuyutarow/agx"

[tools]
agx-status = { version = "1.0.0", version_prefix = "agx-status@", bin_path = "bin" }
```

Choose the version of the individual package. Other packages can advance without
changing this pin.

For a Bun library consumer, pin the public release tarball in `package.json`:

```json
"agx-usehooks": "https://github.com/fuyutarow/agx/releases/download/agx-usehooks@<v>/agx-usehooks-<v>.tgz"
```

Replace both `<v>` placeholders with the same package version. URL installation
requires the repository and its release assets to be public. The tarball includes
TypeScript declarations for the public API.
