# Workspace lifecycle use cases

This table is the shared cut and acceptance contract for every `agx-ws` change. It maps each behavior reported by a consumer to exactly one lifecycle-stage × property cell, then names one check and one owning source function. The proposition is not currently established: the gaps and overlaps below are part of the contract and must be checked against the evidence before accepting a change.

## Axes and evidence

Stages are **create** (`agx ws add`, including `agx worker dispatch`'s workspace step), **use** (a worker runs in the workspace), **land** (its change reaches trunk), and **collect** (`agx ws gc` or `agx ws rm`). Properties are **correct result/verdict**, **workspace-count-independent cost**, and **safety** (no unlanded change is lost and no live run is disturbed).

I split duplicate source IDs where one test names two behaviors: `U2-trunk` / `U2-remote`, `U5-gc` / `U5-rm`, and `U7-files` / `U7-config`. A `test.todo` is not an active test. Empty rows make all twelve cells visible; they do not claim a consumer reported a behavior there.

Evidence locators:

- **FJ**: `/home/fuyu/.local/state/firedancer-tickets/specs/agx-issue-report-jj-1027.md` (J1 lines 5–11; J2 lines 13–17). Its environment header at line 3 says agx 1.16.1.
- **GC**: `/home/fuyu/Workspace/agx.ws/ws_agx-ws-gc-usecase-contract-1027/tools/agx-ws/tests/gc-usecases.test.ts`; U1–U11 are located by the test-name line numbers in the table.
- **DOT**: `/home/fuyu/.local/state/agx/runs/e9974936-27cd-4aff-a448-ab0372b47bc6/USECASES.md` (collectWorkspaces lines 125–160; createWorkspace lines 162–181; createWorkerRun lines 183–206). Read-only input.
- **ADD-RUN**: `/home/fuyu/.local/state/agx/runs/0acde800-8090-4b4f-944c-cbfc36800921/result.md`, which records 7 `jj` starts at both 5 and 50 existing workspaces. The separately requested 15.6 s Firedancer add measurement at agx 1.17.0 was supplied in the task brief; no separate measurement file was supplied. Read-only input.

| Stage | Property | ID | One-sentence story | Consumer evidence | One test that checks it | Owning source function |
|---|---|---|---|---|---|---|
| create | correct result | ADD-CAP | Admit within the 30-live / 20-GiB repository budget, and queue an over-budget job until safe collection makes room. | DOT lines 164–181 | none | `tools/agx-ws/src/workspace.ts:add` (creation entry; capacity admission is absent) |
| create | cost | ADD-COST | Keep `agx ws add`, including dispatch's workspace step, at seven `jj` starts for both 5 and 50 existing workspaces; add measured 15.6 s on Firedancer with agx 1.17.0. | FJ J1 lines 5–11; ADD-RUN; 15.6 s is brief-supplied, not in FJ's 1.16.1 report | ADD-RUN command for `gc usecase: U12` (5/50 count); current analogue: `tools/agx-ws/tests/add-hang.test.ts` — `WS-ADD-HANG-2: three piped adds have a fixed jj budget as history and workspace counts grow` | `tools/agx-ws/src/workspace.ts:add` (line 985) |
| create | safety | ADD-QUEUE | A queued or refused creation leaves no workspace directory or `jj` record, and one create does not trigger global GC. | DOT lines 168–181 | none | `tools/agx-ws/src/workspace.ts:add` (creation entry; queue/admission guard is absent) |
| use | correct result | — | No consumer-reported behavior in the supplied evidence. | — | none | none |
| use | cost | — | No consumer-reported behavior in the supplied evidence. | — | none | none |
| use | safety | USE-LIVE | A live or continuing worker keeps its workspace protected until the run is terminal. | DOT lines 127–139, 143; GC U6 line 475 | GC U6 — `gc usecase: U6 keeps live workspaces and workspaces younger than the grace period` | `tools/agx-ws/src/workspace.ts:classifyGc` (line 2713) |
| land | correct result | LAND-TRUNK | A non-empty change that becomes reachable from the declared trunk is recognized as landed. | DOT line 145; GC U2 lines 281–325 | GC U2 — `gc usecase: U2 removes a workspace whose non-empty change is reachable from a remote bookmark` (also advances trunk for its landed row) | `tools/agx-ws/src/workspace.ts:unlandedWorkspaceChange` (line 2678) |
| land | cost | — | No consumer-reported behavior in the supplied evidence. | — | none | none |
| land | safety | — | No distinct landing-stage safety behavior is reported; preservation requirements are assigned to collect/safety. | — | none | none |
| collect | correct result | GC-ROWS | A dry run gives every workspace one removable, keep, or broken verdict with a reason, and reports completeness only when all rows are judged. | GC U1 lines 233–257; DOT lines 134–139 | none (GC U1 is `test.todo`; local broken-row test is partial) | `tools/agx-ws/src/workspace.ts:gc` (line 3442) |
| collect | correct result | GC-MISSING | A missing registered directory is reported as a broken row without aborting other rows, and a missing record is forgotten only after reachability and live-use checks. | FJ J2 lines 13–17; GC U4 lines 372–401; DOT lines 149–160 | `tools/agx-ws/tests/workspace.test.ts` — `multiple missing directories stay as broken rows while real gc forgets reachable records` | `tools/agx-ws/src/workspace.ts:gc` (line 3442) |
| collect | correct result | GC-REMOTE | A non-empty workspace change reachable from a remote bookmark is reported as removable, with the retaining bookmark named. | GC U2 lines 259–327 | GC U2 — `gc usecase: U2 removes a workspace whose non-empty change is reachable from a remote bookmark` | `tools/agx-ws/src/workspace.ts:unlandedWorkspaceChange` (line 2678) |
| collect | correct result | GC-AGE | A workspace younger than the grace period is classified keep until its minimum age has passed. | GC U6 line 475; DOT lines 143, 155 | GC U6 — `gc usecase: U6 keeps live workspaces and workspaces younger than the grace period` | `tools/agx-ws/src/workspace.ts:classifyGc` (line 2713) |
| collect | correct result | GC-ORPHAN | GC compares an unregistered sibling directory's trunk-tracked files before deciding whether it can collect it. | GC U5-GC lines 403–433 | none (GC U5-GC is `test.todo`) | none (no GC classifier for this case in the current source) |
| collect | correct result | GC-REGEN-CONFIG | GC reads declared regenerable paths from `agx.toml` `[ws]` before judging workspace contents. | GC U7-config lines 550–578; DOT lines 170, 176 | none (GC U7-config is `test.todo`) | `tools/agx-ws/src/workspace.ts:readConfig` (line 201; current reader is `.ws.toml`, so the requested source is absent) |
| collect | correct result | GC-MISE | Removing a workspace also removes only that workspace's mise tracked-config and trusted-config entries. | GC U10 lines 682–707; DOT line 138 | `tools/agx-ws/tests/workspace.test.ts` — `removes only the removed workspace's tracked and trusted mise entries` | `tools/agx-ws/src/workspace.ts:untrackMiseWorkspace` (line 370) |
| collect | correct result | GC-WORKER-STORE | GC judges and collects a worker store created by `agx ws add --worker-store`. | GC U11 lines 710–739 | none (GC U11 is `test.todo`) | none (no worker-store case owner in the current source) |
| collect | correct result | GC-STALE | An unjudged ended run is durably marked expired at end +7 days, then becomes eligible only with its durable outcome preserved under the end +14-day payload rule. | DOT lines 136–147, 191–201 | none (no test for the 7-day / 14-day transition in the supplied suite) | `tools/agx-ws/src/workspace.ts:classifyGc` (line 2713; current abandoned-run rule is 24 hours) |
| collect | correct result | GC-ABANDONED | A terminal abandoned workspace becomes collectible after its disposition and preservation conditions are satisfied, without a manual `--abandoned` request. | DOT lines 143–147, 153–160 | none | `tools/agx-ws/src/workspace.ts:classifyGc` (line 2713; current implementation requires `--abandoned`) |
| collect | cost | GC-COST | Classification uses the same number of `jj` calls at 5 and 50 workspaces. | GC U8 lines 580–625; DOT lines 135, 155 | `tools/agx-ws/tests/gc-contract.test.ts` — `gc contract: dry-run jj call count is constant from 5 to 50 workspaces` | `tools/agx-ws/src/workspace.ts:gc` (line 3442) |
| collect | safety | GC-UNLANDED | Unpushed or unreachable changes are kept and named; a missing workspace with an unreachable commit retains its `jj` record. | FJ J2 lines 14–17; GC U3 lines 329–371; DOT line 148 | GC U3 — `gc usecase: U3 keeps and names the ten unpushed changes in a workspace` | `tools/agx-ws/src/workspace.ts:unlandedWorkspaceChange` (line 2678) |
| collect | safety | GC-ORPHAN-RM | `agx ws rm` compares an unregistered sibling's trunk-tracked disk files and refuses removal if any differ. | GC U5-RM lines 435–474 | GC U5-RM — `gc usecase: U5 rm compares unregistered sibling files to trunk before removal` | `tools/agx-ws/src/workspace.ts:removeBrokenWorkspace` (line 1292) |
| collect | safety | GC-UNTRACKED | Declared regenerable paths do not block collection, but other untracked files are kept and named. | GC U7-files lines 510–548; DOT lines 134–138, 170 | GC U7-files — `gc usecase: U7 ignores declared regenerable paths but keeps other untracked files by name` | `tools/agx-ws/src/workspace.ts:classifyGc` (line 2713) |
| collect | safety | GC-PRESERVE | Before forget, preserve accepted or unreachable changes and durable run findings/results with a readable recovery receipt; if preservation fails, keep the workspace. | DOT lines 134–139, 153–160 | none (the local rejected-results test is narrower than archive/read-back-before-forget) | `tools/agx-ws/src/workspace.ts:gc` (line 3442) |
| collect | safety | GC-LOCK | Hold the workspace lock for forget plus tombstone rename, not for deleting a large tombstone, so other workspace work can proceed. | GC U9 lines 627–680; DOT lines 135, 155 | `tools/agx-ws/tests/gc-contract.test.ts` — `gc contract: lock is available while a large tombstone is still being deleted` | `tools/agx-ws/src/workspace.ts:gc` (line 3442) |

## Gaps

- Empty evidence cells: use/correct, use/cost, land/cost, and land/safety. The supplied consumers do not define a checkable behavior for these cells.
- `ADD-CAP` and `ADD-QUEUE`: no test covers the 30-live / 20-GiB admission, queuing, no-partial-create, or no-global-GC rules; the current `add` function has no capacity gate.
- `ADD-COST`: the 15.6 s Firedancer timing is a supplied measurement without a separate receipt or timing test. The FJ report itself is the 1.16.1 / 60 s timeout report; it does not contain the 1.17.0 timing.
- `GC-ROWS`: U1 remains `test.todo`; the current broken-row test does not check every mixed row class and completeness together.
- `GC-ORPHAN`, `GC-REGEN-CONFIG`, and `GC-WORKER-STORE`: their source cases are TODO; no active test or implementing source function was found in this checkout.
- `GC-STALE`: no test checks end +7-day expiry against end +14-day payload retention, and the current classifier uses a 24-hour abandoned-run threshold.
- `GC-ABANDONED`: no test checks automatic collection after terminal disposition; current GC still requires `--abandoned` for this class.
- `GC-PRESERVE`: no test checks archive/read-back before forget or the fail-closed keep verdict when archival fails.

## Overlaps

### One source function owns use cases in multiple cells

- `tools/agx-ws/src/workspace.ts:add` owns `ADD-CAP` (create/correct), `ADD-COST` (create/cost), and `ADD-QUEUE` (create/safety); capacity cases are not implemented yet.
- `tools/agx-ws/src/workspace.ts:gc` owns `GC-ROWS` and `GC-MISSING` (collect/correct), `GC-COST` (collect/cost), and `GC-PRESERVE` / `GC-LOCK` (collect/safety).
- `tools/agx-ws/src/workspace.ts:classifyGc` owns `USE-LIVE` (use/safety), `GC-AGE` (collect/correct; the age subcase of U6), `GC-STALE` (collect/correct), and `GC-UNTRACKED` (collect/safety).
- `tools/agx-ws/src/workspace.ts:unlandedWorkspaceChange` owns `LAND-TRUNK` (land/correct), `GC-REMOTE` (collect/correct), and `GC-UNLANDED` (collect/safety).

### One use case is checked by tests in more than one file

- Add's fixed seven-call budget: run `0acde800`'s `gc usecase: U12` test in `tools/agx-ws/tests/gc-contract.test.ts` and current `tools/agx-ws/tests/add-hang.test.ts` (`WS-ADD-HANG-2`).
- Remote-bookmarked work is collectible: GC U2 in `gc-usecases.test.ts`, `tools/agx-ws/tests/gc-contract.test.ts` (`remote-bookmarked work is removable and an unpushed change is named`), and `tools/agx-ws/tests/workspace.test.ts` (`reports the retaining remote bookmark and collects a pushed-only workspace`).
- Unpushed changes stay and are named: GC U3 in `gc-usecases.test.ts`, `tools/agx-ws/tests/gc-contract.test.ts` (`remote-bookmarked work is removable and an unpushed change is named`), and `tools/agx-ws/tests/workspace.test.ts` (`a missing workspace with an unpushed commit keeps its jj record`).
- Live workspace protection: GC U6 in `gc-usecases.test.ts` and `tools/agx-ws/tests/workspace.test.ts` (`collects exactly terminal lineages with nothing unlanded; keeps live, continuing, unlanded`).
- Regenerable paths vs other untracked content: GC U7-files in `gc-usecases.test.ts`, `tools/agx-ws/tests/gc-contract.test.ts` (`declared regenerable path prunes a large node_modules subtree`), and `tools/agx-ws/tests/workspace.test.ts` (untracked-content GC cases).
- Mise untracking on removal: GC U10 in `gc-usecases.test.ts` and `tools/agx-ws/tests/workspace.test.ts` (`removes only the removed workspace's tracked and trusted mise entries`).
