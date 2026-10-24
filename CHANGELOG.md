# Changelog

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
