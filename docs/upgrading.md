# Upgrading and rolling back agx

Use one exact suite pin for all commands. A suite release has one version, one
`v<version>` tag, and a root changelog; schema numbers belong to individual
[consumer contracts](../contract/README.md), not to the suite version.
See [release preparation](release.md) for the single-version release method.

## May I change the pin while runs are active?

The default is to wait for runs to finish. An active-run upgrade is supported
only when the target release notes explicitly approve the old-to-new version
pair, including concurrent record readers/writers and rollback compatibility,
and you retain the entire old installation until its runs end. Missing or
unclear notes mean drain first. A patch or minor number alone is not approval.
Installing another version and changing the pin do not migrate an existing run.

A dispatched Linux unit executes the dispatcher's worker, using its absolute
path under the old installation. For example, its ExecStart command is
`/home/alice/.local/share/mise/installs/github-fuyutarow-agx/1.4.0/bin/agx-worker run ...`.
This is an illustrative path; use `mise where github:fuyutarow/agx@1.4.0` to
obtain the actual install directory. You can inspect a run's recorded unit with
`systemctl --user show UNIT.service --property=ExecStart`.

The implementation establishes the following boundary:

- [selfCommand](../tools/agx-worker/src/self-command.ts) returns
  `process.execPath` for a compiled worker, and the absolute Bun executable plus
  resolved source entry for source execution.
- [dispatch](../tools/agx-worker/src/dispatch.ts) captures `workerCommand =
selfCommand()` and passes it after `systemd-run ... --` followed by `run`.
  The unit does not resolve a new worker through mise on each invocation.
- [run](../tools/agx-worker/src/next/run.ts) uses `selfCommand()` again for the
  internal worker child by default. Changing PATH or a mise pin does not replace
  this executable. Explicit `AGX_WORKER_COMMAND`/`AGX_WORKER_BIN` overrides have
  their own lifetime requirements.
- The [suite resolver](../tools/shared/src/path-dispatch.ts) prefers executable
  siblings of the compiled `agx`, keeping an intact installation together.
  Missing siblings fall back to PATH, so retain the whole old install.

If mise prunes the old version, or another cleanup removes its directory, the
unit's stored absolute ExecStart path becomes unavailable. On Linux an already
loaded process can continue after unlinking its executable, but a subsequent
start or child re-entry through that deleted pathname fails; it does not switch
to the new version. A run may therefore fail after appearing to survive cleanup.
Do not rely on a particular mise version detecting running processes: keep the
old version explicitly selected in a retained config, avoid `mise prune` and
`mise uninstall` during the overlap, and check cleanup automation too. A
`mise prune --dry-run` preview is not an agx retention guarantee.

The [compiled install regression test](../tools/agx/tests/upgrade-install.test.ts)
uses the real `selfCommand`, competing PATH entries, and a temporary install
removed after process startup. It checks both successful old-version re-entry
while retained and failed re-entry after removal. It does not start real units
or vendors. The [dispatch tests](../tools/agx-worker/tests/dispatch.test.ts)
check the command handed to a fixture systemd runner.

## Records and state compatibility

Versions share state rather than receiving version-specific databases. The
[state resolver](../tools/shared/src/state-dir.ts) selects nonempty
`AGX_STATE_DIR`, then `XDG_STATE_HOME/agx`, then `~/.local/state/agx`. Preserve
the same state location across an upgrade. Retired `AGX_NEXT_STATE_DIR` and an
unmigrated layout can cause startup refusal; follow the explicit migration
instructions only after draining and backing up.

The worker's [event schemas and readers](../tools/agx-worker/src/next/store.ts)
accept extra fields on known event kinds using `z.looseObject`; optional fields
allow some older records to remain readable. They still validate event kinds
and required field types. This is not a promise that every future record is
readable by every older release. The [records contract](../tools/agx-worker/docs/next-records.md)
also describes incomplete trailing lines and snapshot behavior. Each release
must name affected contract schemas, migration needs, mixed-version support,
and whether the old release can read records written by the new release.

Do not run a migration while old writers are active. Do not restore a backup
over live writers. If rollback cannot read newly written state, drain first
and follow the release's reverse migration or restore a quiescent backup;
restoring loses events written after that backup. Preserve the newer state copy
for recovery. Without an explicit rollback guarantee, stop and seek a supported
migration rather than attempting old commands against new state.

## Upgrade steps

Run these commands in each consumer checkout whose `mise.toml` owns the pin.
Use the version numbers from the chosen release; `1.4.0` and `1.4.1` below are
examples, not an assertion that either pair supports live upgrade.

1. Read the target release's **Upgrade safety** notes and record the current pin:

   ```sh
   old=1.4.0
   new=1.4.1
   mise exec "github:fuyutarow/agx@$old" -- agx worker ls --running --json
   mise where "github:fuyutarow/agx@$old"
   ```

   If live upgrade is not explicitly approved, stop dispatching new work and
   repeat the listing until empty. Check any known active units too; unavailable
   inspection is not evidence that they ended.

2. After draining, back up the complete resolved state directory to a separate
   path, with no concurrent writers. For the usual default location:

   ```sh
   state_dir="${AGX_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agx}"
   backup_dir="$state_dir.before-$new"
   cp -a "$state_dir" "$backup_dir"
   ```

   Choose an unused backup path. If the state directory does not yet exist,
   there is no prior state to copy. For an approved live upgrade, use only a
   release-supported consistent snapshot method, or retain an earlier quiescent
   backup; a plain copy during appends is not a consistent backup.

3. For an approved live upgrade, retain a separate mise config selecting the
   old exact version until every old run ends. Do this before changing the main
   pin, and keep pruning disabled. For example:

   ```sh
   mkdir -p .agx-upgrade-retain
   mise use --path .agx-upgrade-retain/mise.toml --pin "github:fuyutarow/agx@$old"
   ```

   Keep this local retention config present through the overlap and rollback
   window. Then install and select the target:

   ```sh
   mise install "github:fuyutarow/agx@$new"
   mise use --path mise.toml --pin "github:fuyutarow/agx@$new"
   mise exec -- agx --version
   mise exec -- agx worker ls --running --json
   ```

   Confirm the suite version equals the target and the expected runs remain
   visible. Apply any release-prescribed migration at its specified point.
   Commit the consumer pin through its normal workflow. Repeat the pin command
   for other owning configs instead of editing installed executables or clones
   of agx source. Future dispatches use the selected suite; existing units keep
   their original absolute executable path and dispatcher PATH.

4. Remove old-version retention only after its runs end and the rollback window
   closes. Review `mise prune --dry-run` before any cleanup. Keep state backups
   according to your recovery needs.

## Rollback steps

1. Stop new dispatches. Unless the release explicitly supports concurrent
   rollback, wait for all runs to end using the currently selected version's
   listing. Preserve the current state before any reverse migration or restore.
2. Check the release's backward-read and migration notes. If compatible, keep
   the current records. Otherwise follow the documented reverse migration or
   restore the complete quiescent backup after draining, accepting the loss of
   post-backup events. Do not merge JSONL files by hand.
3. Restore the old pin and verify it explicitly:

   ```sh
   mise install "github:fuyutarow/agx@$old"
   mise use --path mise.toml --pin "github:fuyutarow/agx@$old"
   mise exec -- agx --version
   mise exec -- agx worker ls --json --all
   ```

   Reinstalling is necessary if cleanup removed the old install. It cannot undo
   an already failed run. Review its record before continuing it. Changing the
   pin back also does not replace a unit already running the newer executable;
   retain that newer installation until those runs end.

## Expected install time

The DevX consumer report observed about **25 seconds per install**. Budget that
as an observed planning estimate, not a benchmark or an upper bound: network,
platform, asset size, and caches change the duration. The
[release build](../tools/release/build.ts) produces a precompiled suite archive;
a release consumer downloads and extracts it rather than building agx from
source. Measure your own installation with
`time mise install "github:fuyutarow/agx@$new"`. No production install was timed
for this guide. An already installed exact version can be reused for rollback.
