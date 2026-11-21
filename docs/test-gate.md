# What the test gate claims

`mise run test` runs `tools/test-run.ts`. It makes two separate claims.

## Nothing hangs

One test may run for 30 seconds (`HANG_DETECTION_MS` in `tools/shared/src/test-tmp.ts`, and the
same number in `bunfig.toml`). The limit stops a stuck test. It claims nothing about speed.

A test with a longer limit is listed in `tools/agx-worker/tests/timing-contract.json`, and a
test checks that the list matches the sources. On 2026-11-22 the list held 61 limits between 40
and 600 seconds. Their reasons are not yet written down one by one.

## Nothing got more expensive

Each test file runs as its own process. The runner records the CPU time of that process and of
every child it waited for, and fails the gate when a file uses more than twice the time recorded
for it in `tools/test-cpu-budget.json`. Files under 5 seconds of CPU are not judged: there,
process start-up dominates. `mise run test:budget` records new budgets after an intended change.

A file that has no budget, or a budget that names a missing file, also fails the gate.

## Why wall time is not used (decided 2026-11-22)

The previous gate gave every test 5 seconds of wall time and ran the files in parallel. The
limit dated from serial runs, where it kept tests fast. On a machine shared with other sessions
it measured the machine's load instead:

- One parallel run of all 1498 tests took 293 seconds. About 65 tests used more than half of
  their 5-second limit and about 18 used more than three quarters. The counts are approximate.
- Three gates in a row each lost one test, a different one each time.
- The wall clock of the machine also moved back about 1.06 seconds every 31.4 seconds, which
  shifts any duration measured across processes.

CPU time was stable where wall time was not: two runs of the whole suite used 1188 and 1169
seconds, and no file of 2 seconds or more differed by a factor of 2 (the largest was 1.75).

The 117 per-test limits of 30 seconds or less were removed, because the default now covers
them.

## Measured before and after

Five runs each, one commit apart (the later commit removed a duplicate audit field), on a machine with a load average between 8 and 21.

|                                                     | Runs with a failure | Wall time    | Failing tests                                                                                                                     |
| --------------------------------------------------- | ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Before (`bun test --parallel=6`, 5 s limit)         | 2 of 5              | 281 to 301 s | `config-view`: "the command writes nothing"; `routing-stats`: "real roster CLI selections are persisted before any worker starts" |
| After (`tools/test-run.ts`, 30 s limit, CPU budget) | 1 of 5              | 270 to 291 s | `release`: "library tarball installs offline, imports and supplies checked public declarations"                                   |

None of the three failures was the hang limit, so this sample does not show the change removing
a failure. The two failures before it have known causes that the change does not address: a
fixture Git repository that still ran background maintenance, and a statistics window that
dropped a record stamped after the clock moved back. Both were fixed in the next commit: the
fixture turns maintenance off, and `agx worker stats --routing` counts such records under
`ahead_of_clock_events`. The failure after it took 10.6 seconds; its output was not kept, so its
cause is not known. No CPU budget was exceeded in the five runs.

## Claims that still use wall time

About 20 assertions compare a measured duration with a number of milliseconds. Those read so
far state that a command returns without waiting for a 30-second holder. They are not yet
converted to a signal, such as the holder still being alive when the command returns.
