# What the test gate claims

`mise run test` runs `tools/test-run.ts`: one process per test file, half the cores at a time.
The gate fails when a test file fails, and on nothing else.

## Nothing hangs

One test may run for 30 seconds (`HANG_DETECTION_MS` in `tools/shared/src/test-tmp.ts`, and the
same number in `bunfig.toml`). The limit stops a stuck test. It claims nothing about speed.

## Speed is not checked in the gate

No measurement of speed that is free of false alarms exists yet, so the gate has none.

- Wall time measures the machine's load on a shared machine (see below).
- CPU time also rose with load. In one of 12 runs, while the load average rose from 10 to 19,
  the suite used 1262 seconds against about 1100, and a file recorded at 3.2 seconds used 9.5.
  A limit of twice the recorded time per file failed that run with no change in the code.

The planned measure is a count of operations (CLI launches, `jj` calls): the same input gives
the same count. It is not built. Until it is, a test may get slower without the gate noticing.

## What a run leaves behind

Under `.agent-state/test-run/`, for the last run only:

- `failed/<test file>.txt`: the whole output of each failing file.
- `cpu.json`: each file's CPU time in milliseconds, covering the test process and the children
  it waited for. Read it to find the costly files, and compare two runs only when the machine's
  load was similar. The next run uses it to start the costliest files first.

## The change of 2026-11-22

The previous gate ran `bun test --parallel=6` with 5 seconds of wall time per test. One such
run of all 1498 tests took 293 seconds; about 65 tests used more than half of their limit and
about 18 more than three quarters (approximate counts). Earlier gates had lost three tests to
that limit: the route-refusal test, an end-notice test and a public `ls` test. The machine's
wall clock also moved back about 1.06 seconds every 31.4 seconds.

The limit became 30 seconds, and the 117 per-test limits of 30 seconds or less were removed.

Measured with a load average between 6 and 21:

| Gate                                        | Runs with a failing test | Wall time    |
| ------------------------------------------- | ------------------------ | ------------ |
| Before (`bun test --parallel=6`, 5 s limit) | 2 of 5                   | 281 to 301 s |
| After (`tools/test-run.ts`, 30 s limit)     | 1 of 5                   | 270 to 291 s |
| After, with the two causes below fixed      | 0 of 7                   | 268 to 322 s |

The measurements do not show the change of the limit removing a failure: none of the three
failures was a timeout.

- `config-view`, "the command writes nothing": the fixture's Git repository ran background
  maintenance. Fixed in the fixture.
- `routing-stats`, "real roster CLI selections are persisted before any worker starts": the
  statistics dropped a record stamped after the clock moved back. `agx worker stats --routing`
  now counts such records under `ahead_of_clock_events`.
- `release`, "library tarball installs offline, imports and supplies checked public
  declarations": failed once after 10.6 seconds. Its output was not kept, so the cause is
  unknown. The runner now keeps the output of every failing file.

## Limits above 30 seconds

`tools/agx-worker/tests/timing-contract.json` lists every test with a longer limit, and a test
checks the list against the sources. It holds 61 limits in 43 files. None has a written reason
in that list; some have a comment at the test. They are, in seconds:

| File                                                              | Limits              |
| ----------------------------------------------------------------- | ------------------- |
| `tools/agx-status/tests/published-equality.test.ts`               | 120                 |
| `tools/agx-ticket/tests/gc-grammar.test.ts`                       | 60                  |
| `tools/agx-ticket/tests/lifecycle.test.ts`                        | 46, 60              |
| `tools/agx-usehooks/tests/consumers.test.ts`                      | 120, 120            |
| `tools/agx-worker/tests/dispatch-exits.test.ts`                   | 210                 |
| `tools/agx-worker/tests/dispatch-ticket-repo.test.ts`             | 60, 60, 60, 60      |
| `tools/agx-worker/tests/dispatch.test.ts`                         | 40, 120, 40, 45, 60 |
| `tools/agx-worker/tests/ls-lock-busy.test.ts`                     | 60                  |
| `tools/agx-worker/tests/next/check-readonly-needs-verify.test.ts` | 60                  |
| `tools/agx-worker/tests/next/check-repo-commands.test.ts`         | 60                  |
| `tools/agx-worker/tests/next/continue.test.ts`                    | 60                  |
| `tools/agx-worker/tests/next/credits-unavailable.test.ts`         | 60                  |
| `tools/agx-worker/tests/next/intake-floor.test.ts`                | 60                  |
| `tools/agx-worker/tests/next/judge-lock.test.ts`                  | 40                  |
| `tools/agx-worker/tests/next/ls-selector.test.ts`                 | 60                  |
| `tools/agx-worker/tests/next/no-orphan.test.ts`                   | 120                 |
| `tools/agx-worker/tests/next/outcome.test.ts`                     | 180, 180, 180       |
| `tools/agx-worker/tests/next/route.test.ts`                       | 60                  |
| `tools/agx-worker/tests/next/routing-brief.test.ts`               | 60                  |
| `tools/agx-worker/tests/next/run-dir-bytes.test.ts`               | 60                  |
| `tools/agx-worker/tests/next/run-path-own-version.test.ts`        | 60                  |
| `tools/agx-worker/tests/next/run.test.ts`                         | 60                  |
| `tools/agx-worker/tests/next/ticket-home.test.ts`                 | 60                  |
| `tools/agx-worker/tests/next/workspace-lock.test.ts`              | 60, 60              |
| `tools/agx-worker/tests/run-exits-after-end.test.ts`              | 90                  |
| `tools/agx-worker/tests/run-lock-hold.test.ts`                    | 60                  |
| `tools/agx-worker/tests/timeout-report.test.ts`                   | 120, 100            |
| `tools/agx-worker/tests/verify-feedback.test.ts`                  | 60                  |
| `tools/agx-worker/tests/verify-round-visible.test.ts`             | 60                  |
| `tools/agx-ws/tests/add-failed-checkout.test.ts`                  | 60, 60              |
| `tools/agx-ws/tests/add-hang.test.ts`                             | 90                  |
| `tools/agx-ws/tests/agx-workspace-of.test.ts`                     | 60                  |
| `tools/agx-ws/tests/gc-contract.test.ts`                          | 120                 |
| `tools/agx-ws/tests/gc-grammar.test.ts`                           | 120                 |
| `tools/agx-ws/tests/gc-progress.test.ts`                          | 60                  |
| `tools/agx-ws/tests/gc-usecases.test.ts`                          | 90                  |
| `tools/agx-ws/tests/landed-record.test.ts`                        | 90                  |
| `tools/agx-ws/tests/lock-scope.test.ts`                           | 60, 64              |
| `tools/agx-ws/tests/trunk-state.test.ts`                          | 60                  |
| `tools/agx-ws/tests/workspace.test.ts`                            | 60                  |
| `tools/agx/tests/doctor.test.ts`                                  | 45                  |
| `tools/code-size.test.ts`                                         | 70                  |
| `tools/release/release.test.ts`                                   | 120, 550, 200, 600  |

## Claims that still use wall time

About 20 assertions compare a measured duration with a number of milliseconds. The eight read
so far state that a command returns without waiting for a 30-second holder. They are not yet
converted to a signal, such as the holder still being alive when the command returns.
