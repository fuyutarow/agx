# Changelog

## 1.22.52 — 2026-10-31

- Avoid assembling the mise environment twice per dispatch.

## 1.22.51 — 2026-10-31

- Add atomic validation and batched judgment recording with judge --from.

## 1.22.50 — 2026-10-31

- Bound run ID diagnostics for unknown and ambiguous selectors.

## 1.22.49 — 2026-10-31

- Deliver to idle Codex threads without loading their full turn history and diagnose oversized active turn listings.

## 1.22.48 — 2026-10-31

- Explain the capabilities form and unsupported keys when ticket validation fails.

## 1.22.47 — 2026-10-30

- Bound Claude relay waits and report progress while waiting.

## 1.22.46 — 2026-10-30

- Allow ticket effort floors and show the selected dispatch row.

## 1.22.45 — 2026-10-30

- Speed up the idle land workspace GC contract test.

## 1.22.44 — 2026-10-30

- Keep gc --all dry runs read-only while preserving repository ordering.
- Report malformed workspace list records with their raw text.

## 1.22.43 — 2026-10-30

- Remove foreground lock waiter records on SIGTERM and SIGINT.

## 1.22.42 — 2026-10-30

- Keep GC removal counts aligned with synchronous removal lines.

## 1.22.41 — 2026-10-30

- Isolate subprocess test environments from inherited agent sessions.

## 1.22.40 — 2026-10-30

- Bound workspace GC with cooperative repository and run budgets and rotate repositories by last start.

## 1.22.39 — 2026-10-30

- Accept Claude host inventory entries without status when binding ACK targets.

## 1.22.38 — 2026-10-30

- Forward termination signals to dispatched commands and preserve their exit status.
- Journal workspace removals and summarize interrupted garbage collection.

## 1.22.37 — 2026-10-30

- Name workspace garbage collection reason counts and explain failure exits.

## 1.22.36 — 2026-10-30

- Reduce workspace inventory ignore filtering to one Git listing.

## 1.22.35 — 2026-10-30

- Wait for unit startup before returning dispatch receipts and use a stable Homebrew executable path.

## 1.22.34 — 2026-10-30

- Expose workspace accumulation in doctor output.
- Report workspace gc and doctor accumulation counts.

## 1.22.33 — 2026-10-30

- Defer Claude UUID resolution to the relay when sender inventory is unavailable.

## 1.22.32 — 2026-10-30

- Make workspace removal share GC safety checks and ignore regenerable content.

## 1.22.31 — 2026-10-30

- Preserve relative symlink targets in broken workspace patches.

## 1.22.30 — 2026-10-30

- Keep liveness probes outside the current-runs publication lock.

## 1.22.29 — 2026-10-30

- Document the discard-broken patch location and landed rule in rm help.

## 1.22.28 — 2026-10-30

- Save a patch before discarding broken workspaces and refuse unlanded revisions.

## 1.22.27 — 2026-10-30

- Report opt-in GC step timings on stderr; bound untracked inventory time per repository and report partial coverage when the budget is exhausted.

## 1.22.26 — 2026-10-30

- Report per-repository gc --all progress on stderr.

## 1.22.25 — 2026-10-30

- Require acceptance or a consumed release note before treating copied workspace content as landed

## 1.22.24 — 2026-10-30

- Preserve workspaces on removal refusal and finish missing-directory removals.

## 1.22.23 — 2026-10-29

- Enforce a frozen test timeout ratchet.

## 1.22.22 — 2026-10-29

- Preserve current workspace GC contracts and lock-scope verification

## 1.22.21 — 2026-10-29

- Serialize doctor refreshes and return fresh results to concurrent callers.

## 1.22.20 — 2026-10-29

- Accept --session on durable dispatch and forward its dispatcher identity to run

## 1.22.19 — 2026-10-29

- Allow dispatch to continue when its ACK target cannot be resolved.

## 1.22.18 — 2026-10-29

- Report unknown commands with a help hint.

## 1.22.17 — 2026-10-29

- Accept JSON values in worker check results.

## 1.22.16 — 2026-10-29

- Require jj 0.46.0 before running templates to avoid per-repository failures.

## 1.22.15 — 2026-10-29

- Bound UUID-prefix discovery by the send deadline
- Bound UUID-prefix discovery by the send deadline
- Fix wait fixture to expose native reply turns
- Make discovery deadline test deterministic

## 1.22.14 — 2026-10-29

- Use the repository-pinned TypeScript compiler for library declarations

## 1.22.13 — 2026-10-29

- Restore roster TICKET output to the documented selected-row JSON shape.

## 1.22.12 — 2026-10-29

- Compare tracked symlinks by their targets when checking workspaces.

## 1.22.11 — 2026-10-29

- Refuse Claude-to-Claude messages and direct callers to native SendMessage.

## 1.22.10 — 2026-10-29

- Fix agx TypeScript lint errors in forwarded exit handling

## 1.22.9 — 2026-10-29

- Accept verified read-only no-change runs without an override.

## 1.22.8 — 2026-10-29

- Correct routing statistics for class-then-code selections.

## 1.22.7 — 2026-10-29

- Route unnamed return answers to the fallback instead of refusing dispatch.

## 1.22.6 — 2026-10-29

- Wait for publication locks using the judge bound and report lock errors accurately.

## 1.22.5 — 2026-10-29

- Deliver to idle Codex threads when turn listing is unavailable.

## 1.22.4 — 2026-10-29

- Stop judge-lock test holders when their parent exits.

## 1.22.3 — 2026-10-29

- Bind dispatch-resolved Claude ACK targets for sandboxed sends
- Pass dispatch-bound ACK targets into sandboxed worker runs

## 1.22.2 — 2026-10-29

- Route continuations away from rows whose published duration exceeds the ticket time box.

## 1.22.1 — 2026-10-29

- Route workers by ticket requirement class and published TB4 score

## 1.22.0 — 2026-10-28

- Classify worker completion and guard incomplete acceptance

## 1.21.8 — 2026-10-28

- Record Jev refusal reasons as dispatch refusals

## 1.21.7 — 2026-10-28

- Make worker stop outcomes match recorded run state

## 1.21.6 — 2026-10-28

- Continue runs when their roster row is retired, preserving the workspace and recording both rows.

## 1.21.5 — 2026-10-28

- Re-land bounded run-end notice with legacy record decoding

## 1.21.4 — 2026-10-28

- Remove benchmark per-task costs from Jev routing while retaining duration eligibility.

## 1.21.3 — 2026-10-28

- Offer the shortest eligible routing rows and audit the relaxed duration budget when no published duration fits.
- Route efforts by published per-task cost and duration; exclude choices exceeding the ticket time box.

## 1.21.2 — 2026-10-28

- Refuse VCS-mutating verification outside sandbox write roots

## 1.21.1 — 2026-10-28

- Refresh Terra roster to GPT-6.1 Terra
- Resolve bare worker ticket names from the declared repository home

## 1.21.0 — 2026-10-28

- Use an untracked default-workspace agx.toml when trunk has none and report its source

## 1.20.8 — 2026-10-28

- Workspace creation reports its policy revision and readiness commands.

## 1.20.7 — 2026-10-28

- Forget missing land workspace registrations without classifying them as broken

## 1.20.6 — 2026-10-28

- Accept declared workspace config keys and make config refusals precise

## 1.20.5 — 2026-10-28

- Add workspace cleanup use-case acceptance tests.

## 1.20.4 — 2026-10-27

- Workspace outcomes compare all files and report changed paths.

## 1.20.3 — 2026-10-27

- Revert the bounded run-end notice; 1.20.2 refused every run record written before it and stopped all dispatch

## 1.20.2 — 2026-10-27

- Record end notice outcomes after the worker run exits
- Support exact backend-qualified sends without discovery

## 1.20.1 — 2026-10-27

- Persist vendor sessions before worker runs end

## 1.20.0 — 2026-10-27

- Collect workspaces whose changes are already present on trunk

## 1.19.1 — 2026-10-27

- Normalize TOML integer values before config validation

## 1.19.0 — 2026-10-27

- Use agx.toml for workspace policy and refuse .ws.toml

## 1.18.3 — 2026-10-27

- Dispatch inspection honors its configured timeout.

## 1.18.2 — 2026-10-27

- Inject judge lock timing for deterministic tests

## 1.18.1 — 2026-10-27

- Revert the isolated worker store; ws add took 307 s in firedancer and left unregistered .jj directories

## 1.18.0 — 2026-10-27

- Create isolated JJ stores for sandboxed workers
- Publish isolated worker commits on acceptance

## 1.17.5 — 2026-10-27

- Add test-only timing seams for agx-ws integration tests

## 1.17.4 — 2026-10-27

- Remove release archives from other versions before building

## 1.17.3 — 2026-10-27

- Keep complete ordered stdout and stderr in verify logs

## 1.17.2 — 2026-10-27

- Refuse unchanged continuations after two lineage timeouts before dispatch effects

## 1.17.1 — 2026-10-27

- Reroute vendor capacity within one worker run

## 1.17.0 — 2026-10-27

- Make workspace cleanup constant cost

## 1.16.2 — 2026-10-27

- Judge waits for the current-runs publication lock before recording judgments

## 1.16.1 — 2026-10-27

- Use alpha@origin as workspace add trunk and warn on divergent local copies

## 1.16.0 — 2026-10-27

- Reserve alpha pushes for agx change land with a pre-push hook

## 1.15.0 — 2026-10-27

- Fetch remote trunk before creating workspaces and report the selected base.
- Notify dispatchers when worker runs end

## 1.14.9 — 2026-10-27

- Preserve unknown check exit statuses in readable worker reports

## 1.14.8 — 2026-10-27

- Refuse unchanged tickets after a timed-out run before continuation effects.

## 1.14.7 — 2026-10-27

- Record dispatch runs before launch and preserve launch failures
- Use one shared compiled binary for suite commands

## 1.14.6 — 2026-10-27

- Make subscription usage tests deterministic across fixed clocks and temporary homes.

## 1.14.5 — 2026-10-27

- Report invalid local workspace metadata with a broken verdict
- Retry registered workspace revision when local @ cannot be resolved
- Safely remove broken workspaces only when trunk files match

## 1.14.4 — 2026-10-27

- Show fixed-workload Artificial Analysis cost in Jev routing criteria.

## 1.14.3 — 2026-10-27

- Include continuation judgment notes and ticket diffs in worker prompts

## 1.14.2 — 2026-10-26

- Deliver Codex messages through the app-server immediately when possible
- Isolate test config and dispatcher environment
- Read roster prices from the canonical model catalog

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
