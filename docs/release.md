# Suite releases

The distribution version is `tools/agx/package.json`. One GitHub release at
`v<version>` contains the whole suite. Every command prints this suite version. Member manifest versions are synchronized
for packaging only; consumer contracts retain their own schema numbers. Historical
`<pkg>@<version>` tags remain untouched; new releases create `v<version>` and `usehooks-v<version>`.
The root `CHANGELOG.md` owns new entries; member changelogs are frozen history.

## Consumers

Install the whole suite with one mise entry:

```toml
[tools]
"github:fuyutarow/agx" = "<version>"
```

mise strips the leading `v` and finds the executables in `bin/`.

Supported suite platforms are linux-x64, linux-arm64, darwin-x64 and
darwin-arm64 (macOS). Assets use `agx-<version>-<os>-<arch>.tar.gz`.
The OS tokens are `linux` and `darwin`; architecture tokens are `x64` and
`arm64`. mise recognizes aliases including `macos`, `x86_64` and `aarch64`.
Unsupported platforms have no suite archive and installation must fail.
There is no library fallback on the suite release.

For a Bun library consumer, pin the release asset in `package.json`:

```json
"agx-usehooks": "https://github.com/fuyutarow/agx/releases/download/usehooks-v<version>/agx-usehooks-<version>.tgz"
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
A separate library build produces `dist/agx-usehooks-<version>.tgz`, a platform-independent ESM library.
Asset paths and SHA-256 checksums are printed. Staging is cleared before building.

The default target is the host. `--target bun-linux-x64` selects cross compilation;
its Bun compiler runtime must already be available for offline builds. Other Bun
platform targets are accepted. Windows commands have the `.exe` suffix.
The library build uses the cached TypeScript 6.0.3 compiler offline to emit
public declarations. Per-member builds remain available for development.

## Publish

Publishing accepts only `suite`. A member argument exits 2 with a pointer to the
suite command. Publishing defaults to dry-run and refuses a dirty tree, HEAD
that differs from local alpha, either existing release tag, or missing version
changelog entries. A detached HEAD at alpha is accepted.

The preview performs no builds or uploads. It prints exact shell-quoted
commands to create both Git tags and atomically push alpha plus those tags.
An alpha commit ahead of origin is accepted; HEAD must match local alpha.
The command prints the matching workflow run URL when available, or a
tag-filtered workflow page while GitHub queues the runs.

`.github/workflows/release.yml` triggers on both tag patterns. Its Ubuntu runner
uses Bun 1.4.3 and the existing `tools/release/ci.ts` entry point, which calls
the same build and asset-naming code as `release:build`. The suite tag run
cross-compiles all four supported platforms; the usehooks tag run builds the
library and its declarations. Missing archives fail the run.

If no workflow run appears after the tag push, manually dispatch the existing
tags from alpha:

```sh
gh workflow run release.yml --ref alpha -f tag=v<version>
gh workflow run release.yml --ref alpha -f tag=usehooks-v<version>
```

The required `tag` input selects the exact tag to check out and passes that tag
to the same CI release entry point. This recovery never deletes or moves tags.
`release:publish` prints these commands when it cannot find a workflow run,
before waiting for assets. Dispatch only tags without a run or existing release;
use draft recovery below for a run that already created a release.

In CI, the library is published
at `usehooks-v<version>` with `--latest=false`; the suite release at
`v<version>` contains only the four platform archives and becomes latest.
Local publication refuses `--target` so a partial suite cannot be published.
CI creates an empty draft, uploads each asset separately, inspects the assets
with `gh release view --json assets`, and publishes with `--draft=false --latest`
only after every expected asset is `uploaded` with the local file's byte size.
CI creates each draft with `gh release create <tag> --draft --title <tag> --notes-file <file> --verify-tag`,
without `--target`. The already-pushed tag decides the release commit;
creation refuses if the remote tag is missing. Existing member tags are retained.
Release notes include suite changelog sections added since the previous reachable
suite tag. The first suite release includes the current section. Unreadable
previous suite history refuses publication.

Only `mise run release:publish -- suite --yes` executes the local push plan.
No local archives, compiler cache, or upload bandwidth are required. CI then
creates the GitHub releases and uploads the assets. Review the
preview in the canonical repository first. `--yes` and `--dry-run` conflict.
In CI, each asset upload has at most three attempts, with `--clobber` on retries and a
ten-minute timeout per attempt. Asset probes while waiting for CI use the
remaining asset-wait deadline. Other commands have a two-minute timeout.
Command timeout errors include the command, elapsed milliseconds and limit.
An upload or verification failure leaves the release as a draft and exits 2.
The refusal names the failing asset, includes captured stderr and stdout (or an
explicit empty-output diagnostic), and prints commands to recover the existing
draft. Tags are never deleted, and release creation is never retried.

For recovery, use the exact paths and expected byte sizes printed by the refusal.
Re-upload the assets to the existing draft with `--clobber`, then inspect them:

```sh
gh release upload v<version> dist/agx-<version>-linux-x64.tar.gz --clobber
gh release upload v<version> dist/agx-<version>-linux-arm64.tar.gz --clobber
gh release upload v<version> dist/agx-<version>-darwin-x64.tar.gz --clobber
gh release upload v<version> dist/agx-<version>-darwin-arm64.tar.gz --clobber
gh release view v<version> --json assets
```

Check that all four suite names appear exactly once, each state is `uploaded`, and each size
equals its local file's byte size. Only after those checks, publish the draft:

```sh
gh release edit v<version> --draft=false --latest
```

Use the failed CI run logs and runner artifacts when recovering a draft;
rebuild the exact tag in a separate recovery workspace if needed.
Do not re-create the release or rerun `release:publish` to recover a failed
upload: local tags may already exist. If creation or final publication fails,
inspect the remote release state before using the recovery commands.

Library draft recovery uses the same upload and view checks with tag
`usehooks-v<version>` and its single `agx-usehooks-<version>.tgz` asset.
Finalize that release with `--draft=false --latest=false`. If the library was
already published when suite publication failed, leave it published and recover
only the suite draft using the printed commands.

## Upgrade safety release notes

Every release must include an **Upgrade safety** entry in its root changelog
section, which is included in the generated release notes. Review this entry
before publishing; absent evidence means **drain runs before upgrading**.
This is a release review requirement, not an automated publisher check.

The entry must state:

- Whether upgrading with runs active is supported, and from which exact suite
  versions. Give evidence for mixed-version readers and writers; otherwise say
  to stop new dispatches and wait for runs to end.
- That active units retain their original absolute ExecStart executable and
  require the complete old installation until they end. Include the consequence
  of pruning it: later starts or self-reentry can fail.
- Which consumer contract schema numbers change, whether state migration is
  required, and whether the previous version can read newly written records.
- Exact migration and rollback actions, backup requirements, and any events lost
  by restoring a backup. Link to [the upgrade procedure](upgrading.md).
- Expected install time, identifying an observation or measurement rather than
  promising a fixed bound. The current consumer observation is about 25 seconds.

For a release without pair-specific compatibility evidence, use an entry such as:

> Upgrade safety: drain active runs before upgrading. Retain old installs until
> their runs end; pruning can break child re-entry through the old absolute path.
> State compatibility and rollback: document the reviewed schemas and migration
> steps here before publication. See the upgrade guide for backup and pin steps.

Replace the state-compatibility placeholder with concrete reviewed facts before
publishing. A version number or unchanged schema number alone is not evidence of
concurrent writer compatibility.

## Complete the release on this machine

Declare agx only once, user-globally, as latest with no lock:

```toml
[tools]
"github:fuyutarow/agx" = "latest"
```

Repositories must not declare agx in `mise.toml` or `mise.lock`. Remove obsolete
repository declarations through their normal review process; the release step
never edits consumer directories.

`mise run release:publish -- suite --yes --verify-in /path/to/consumer` now waits
for all four platform assets on the published suite release, installs the exact
suite version using the user-global configuration, and checks home plus every
repeatable `--verify-in DIR` using `mise exec -C DIR -- agx -V`.
A release is complete only after this step passes. Each distinct directory gets
one `OK DIR: agx <suite>` line. A stale pin, unexpected output, install failure,
or expired asset wait fails with exit 1 and names the step and directory.

After a release published separately, or to retry only machine completion:

```sh
mise run release:machine -- --verify-in /path/to/consumer --verify-in /another/repo
```

The asset wait defaults to 900 seconds with 5-second polling; override with
`--wait-seconds N --poll-seconds N`. This deadline also bounds each
`gh release view` probe, so waiting for CI can exceed two minutes without
resetting the overall deadline. Global installation runs from home, without
changing the global `latest` declaration or creating a repository lock.
