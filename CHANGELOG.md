# Changelog

## 1.14.1 — 2026-10-26

- Revert the release machine step rewrite; it unlinked agx and failed, leaving no agx on PATH

## 1.14.0 — 2026-10-26

- Classify remote-reachable workspace changes as pushed and allow their removal

## 1.13.14 — 2026-10-26

- Keep Homebrew agx commands available during upgrades
- Make Jev maximize accepted results per cost
- Preserve vendor sessions when stopping and continuing runs

## 1.13.13 — 2026-10-26

- Handle missing workspace roots during gc

## 1.13.12 — 2026-10-26

- Print a receipt after recording a worker judgment
- Wait for active runs before continuing and refuse duplicate continuations

## 1.13.11 — 2026-10-26

- Revert the machine-wide worker cap; it counted every coordinator's runs and refused all dispatches

## 1.13.10 — 2026-10-26

- Send quantitative-only Jev roster criteria

## 1.13.9 — 2026-10-26

- Enforce a machine-wide live worker limit with bounded --wait-slot dispatch

## 1.13.8 — 2026-10-26

- Remove workspace-specific mise tracked and trusted entries

## 1.13.7 — 2026-10-26

- Keep agx run outcomes out of Jev routing requests

## 1.13.6 — 2026-10-26

- Report bounded GC inventory timeouts and allow a per-invocation limit

## 1.13.5 — 2026-10-26

- Revert Jev acceptance intervals, cost per accepted result and the cheaper-option rule; Jev requests no longer depend on local run history

## 1.13.4 — 2026-10-26

- Include Wilson acceptance intervals and expected cost per accepted result in Jev routing evidence

## 1.13.3 — 2026-10-26

- Add ancestor ticket premises and document all premise kinds in check help

## 1.13.2 — 2026-10-26

- Attribute Codex callers from their nearest vendor process when proven.

## 1.13.1 — 2026-10-26

- Keep workspace GC read-only and preserve unsnapshotted edits

## 1.13.0 — 2026-10-26

- Add ws harvest to preserve ended runs' workspace results once and allow gc to reclaim rejected workspaces.
- Complete suite releases through Homebrew
- Explain workspace keep declarations in gc help and docs
- Move agx command guidance into installed help and keep driving skill version independent
- Protect newly created workspaces from gc for a configurable grace period
- Report broken workspace paths without aborting gc
- Skip malformed Claude inventory rows and retry transient reads
- Skip mise install when workspace tools are already installed

## 1.12.1 — 2026-10-25

- Resolve suite child commands beside the running binary

## 1.12.0 — 2026-10-25

- Install and upgrade the suite through Homebrew

## 1.11.3 — 2026-10-25

- Pass run-scoped environment to ticket verification

## 1.11.2 — 2026-10-25

- Give suite installation its own deadline and minute progress, and finish when mise exits even if descendants retain output pipes

## 1.11.1 — 2026-10-25

- Replace Jev routing objective with the ticket purpose statement

## 1.11.0 — 2026-10-25

- Resolve root-only default trunk from a unique local integration bookmark and explain GC trunk sources

## 1.10.1 — 2026-10-25

- Keep workspace gc dry-runs read-only with unwritable repository parents and state directories

## 1.10.0 — 2026-10-25

- Refuse tickets without declared write scope or acceptance basis before model routing and record ticket hashes

## 1.9.1 — 2026-10-25

- Bound release asset probes by the CI wait deadline and identify timed out commands

## 1.9.0 — 2026-10-25

- Export writable AGX_RUN_DIR for worker results and promptly collect fully rejected workspaces with preserved results.

## 1.8.1 — 2026-10-25

- Preserve complete preflight diagnostics and cover immediate ticket edits before repeated continuation dispatch.

## 1.8.0 — 2026-10-25

- Discover gc --all repositories from workspace creation history and all run records alongside optional L2 policy; report sources, counts and unreachable roots.
- Retain replayable routing decision audits and report per-row picks, probability margins, and TB4 exclusions

## 1.7.3 — 2026-10-25

- Continue recorded workspaces without resolving deleted sibling workspaces.

## 1.7.2 — 2026-10-25

- Resolve worker message senders from recorded run state even when the sandbox cannot see the owner process.

## 1.7.1 — 2026-10-25

- Export the worker run ID so messages can resolve the recorded vendor session.
- Fix CI release creation to verify existing tags without an explicit target
- Resolve undeclared message senders from the exact worker run record while preserving explicit sender precedence.

## 1.7.0 — 2026-10-25

- Build and upload release archives in GitHub Actions; local publication only pushes alpha and release tags
- Complete releases by waiting for all platform assets, installing globally, and verifying every machine consumer
- Fix worker stop ownership checks for dispatched and continued systemd unit children; report ended runs as not running.

## 1.6.4 — 2026-10-25

- Make blinded Jev option prose readable
- Show local acceptance and median wall time in blinded Jev routing options and pick audits.

## 1.6.3 — 2026-10-25

- Blind model and effort identities in the single routing Choice; audit anonymous picks and refuse returned tickets before worker startup.

## 1.6.2 — 2026-10-24

- Keep workspaces containing non-regenerable untracked or ignored files and fail closed when inventory is unavailable.

## 1.6.1 — 2026-10-24

- Judge workspace GC by current unlanded content instead of accepted run commit reachability.

## 1.6.0 — 2026-10-24

- Keep decodable imported legacy runs visible in ls; hide and count only undecodable imported started records.
- Publish four suite platform archives and isolate the usehooks library release
- Quote jj fileset paths literally when judging workspace integration and orphan files.
- Add lease-checked worker stop with explicit stopped outcome and stopper attribution
- Explain unknown live progress and usage, preserve unreported token counts, and document vendor usage timing.
- Expose dispatch execution receipts in human and JSON output, classify own deadlines as timeout, and document all run outcomes with stats counts.
- Speed up worker listings, hide and count malformed legacy runs with --include-legacy, normalize moved report paths, and document selectors.
- Warn before worker startup when the requested sandbox conflicts with shared VCS stores or declared user-systemd commands; preserve the requested sandbox.
- Document active-run upgrade and rollback safety, old-install retention, state compatibility and mandatory release safety notes
- Add bounded native Codex reply observation with agx msg wait, test Codex-to-Claude replies, and expose send timing.

## 1.5.0 — 2026-10-24

- Unify every command and release under the suite version with one changeset and changelog path
- Publish a 60-second polling cadence and retained doctor refresh errors in status JSON
- Limit doctor to the registered L2 repository set
- Allow on-demand consumer verification with --all and document Bun-only TypeScript execution
- Add bounded worker probe JSON diagnostics with explicit sandbox and timeout outcomes
- Add public host and window routing statistics with explicit unknown coverage and nullable Codex share.
- Add public Jev usage window statistics with explicit historical gaps and pricing provenance
- Import legacy lifecycle judgments with timestamp ordering, stable identity, and idempotent CLI projections.
- Allow 60-second doctor members by default and report deadline kills with tool, budget and signal
- Bound doctor refreshes across pollers and retain last-good findings with stale and error fields

## 1.4.0 — 2026-10-24

- Update suite member agx-status to 1.1.0.
- Add bounded aggregate doctor JSON with atomic owner snapshots
- Move suite package metadata to the @agx scope.
- Update suite member xmsg to 0.4.3.
- Update suite member agx-ws to 1.0.3.
- Update suite member jex to 0.3.2.
- Update suite member agx-worker to 10.1.0.
- Update suite member agx-ticket to 2.0.4.
- Update suite member agx-usehooks to 1.0.5.

## 1.3.2 — 2026-10-24

- Update suite member agx-ticket to 2.0.3.
- Resolve suite tools beside compiled agx before falling back to PATH

## 1.3.1 — 2026-10-23

- Update suite member agx-worker to 10.0.5.
- Update suite member xmsg to 0.4.2.

## 1.3.0 — 2026-10-23

- Distribute every agx suite executable and the usehooks library in one versioned GitHub release
- Update suite member agx-worker to 10.0.4.
- Update suite member agx-usehooks to 1.0.4.

## 1.2.1 — 2026-10-23

- Rename the retired suite rejection fixture

## 1.2.0 — 2026-10-23

- Add msg as an agx suite tool

## 1.1.0 — 2026-10-23

- Route agx status through the PATH agx-status bin and declare its installation surfaces.

## 1.0.0 — 2026-10-19

- Remove the legacy top-level Jev alias; use jex

## 0.6.3 — 2026-10-19

- Remove temporary agx jev forwarding

## 0.6.2 — 2026-10-19

- Restore temporary agx jev forwarding for dx 0.1.4

## 0.6.1 — 2026-10-19

- Keep suite help conformance after the split

## 0.6.0 — 2026-10-19

- Accept only worker, ticket and ws as suite tools

## 0.5.0 — 2026-10-19

- Route the suite through PATH tools and keep legacy worker verbs as deprecated forwards

## 0.4.2 — 2026-10-17

- Remove temporary doctor snapshot files when atomic publication fails.

## 0.4.1 — 2026-10-17

- Standardize -V/--version, plain deterministic help, and typed unknown-flag diagnostics.

## 0.4.0 — 2026-10-17

- Expose authoritative doctor finding counts and completeness as JSON.
- Persist complete doctor findings with their observation timestamp for read-only consumers

## 0.3.1 — 2026-10-17

- Resolve dispatch repositories from tickets and consume machine-readable workspace output

## 0.3.0 — 2026-10-17

- Add agx dispatch to create matching durable workspaces and units

## 0.2.0 — 2026-10-16

- Expose Jev requests and the validated dispatch roster through agx

## 0.1.1 — 2026-10-16

- Add the read-only fleet doctor command

## 0.1.0 — 2026-10-16

- Add the process-only agx suite router
