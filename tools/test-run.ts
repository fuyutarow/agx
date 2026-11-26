#!/usr/bin/env bun
// The gate's test runner. Each test file runs as its own `bun test` process; how many run at
// once follows the processor each used last time (see runAll).
//
// The gate fails when a test file fails, and on nothing else. A stuck test is stopped by the
// test timeout (HANG_DETECTION_MS in tools/shared/src/test-tmp.ts), which says nothing about speed.
//
// Under .agent-state/test-run/ the runner leaves, for the last run:
//   - failed/<file>.txt: the full output of each failing file, so a failure can be examined;
//   - cpu.json: each file's CPU time in milliseconds (the test process and every child it
//     waited for). It is a record, not a judgement: CPU time rose with the machine's load, by
//     about 15% for the suite and up to 3 times for a small file.
//   - wall.json: when each file started (milliseconds after the run began) and how long it took
//     by the clock. A record too. With cpu.json it shows what bounds the run: a file whose
//     clock time far exceeds its CPU time was waiting, not computing. The next run reads it
//     only to start the longest files first.
import { mkdir, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, relative } from "node:path";
import { jsonOf, z } from "./shared/src/zod.ts";

const root = join(import.meta.dir, "..");
const recordDir = join(root, ".agent-state/test-run");
const cpuPath = join(recordDir, "cpu.json");
const wallPath = join(recordDir, "wall.json");
const failedDir = join(recordDir, "failed");

const Cpu = jsonOf(z.record(z.string(), z.number()));
const Wall = jsonOf(
  z.record(z.string(), z.object({ start_ms: z.number(), wall_ms: z.number() })),
);

async function testFiles(): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
  for await (const file of glob.scan({ cwd: root, onlyFiles: true }))
    if (!/(?:^|\/)(?:node_modules|\.jj|\.git)\//u.test(file)) files.push(file);
  return files.toSorted();
}

type Outcome = {
  file: string;
  exit: number;
  cpuMs: number;
  startMs: number;
  wallMs: number;
  output: string;
};

async function runFile(file: string, runStarted: number): Promise<Outcome> {
  const fileStarted = performance.now();
  const child = Bun.spawn([process.execPath, "test", `./${file}`], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // Bun 1.4 returns the CPU time as a bigint number of microseconds.
  const cpuMicros = child.resourceUsage()?.cpuTime.total ?? 0;
  return {
    file,
    exit,
    cpuMs: Math.round(Number(BigInt(cpuMicros)) / 1000),
    startMs: Math.round(fileStarted - runStarted),
    wallMs: Math.round(performance.now() - fileStarted),
    output: out + err,
  };
}

/**
 * Runs the files in order, keeping the processors they are expected to use at `width` or fewer.
 * `share(file)` is the fraction of one processor the file used last time (1 when unknown), so
 * a file that mostly waits does not hold a place that a computing file needs. At most
 * `2 * width` files run at once, whatever their shares.
 */
async function runAll(
  files: string[],
  width: number,
  share: (file: string) => number,
): Promise<Outcome[]> {
  const runStarted = performance.now();
  const queue = [...files];
  const running = new Set<string>();
  const outcomes: Outcome[] = [];
  const fits = (file: string): boolean =>
    running.size === 0 ||
    (running.size < 2 * width &&
      [...running].reduce((sum, other) => sum + share(other), share(file)) <=
        width);
  await new Promise<void>((done) => {
    const fill = (): void => {
      for (
        let file = queue[0];
        file !== undefined && fits(file);
        file = queue[0]
      ) {
        const started = file;
        queue.shift();
        running.add(started);
        const settle = (outcome: Outcome): void => {
          outcomes.push(outcome);
          running.delete(started);
          fill();
        };
        runFile(started, runStarted).then(settle, (error: unknown) => {
          settle({
            file: started,
            exit: 1,
            cpuMs: 0,
            startMs: 0,
            wallMs: 0,
            output: `the runner could not run this file: ${String(error)}\n`,
          });
        });
      }
      if (queue.length === 0 && running.size === 0) done();
    };
    fill();
  });
  return outcomes;
}

const recorded = async <T>(
  path: string,
  schema: { safeParse: (text: string) => { success: boolean; data?: T } },
): Promise<T | undefined> => {
  const file = Bun.file(path);
  return (await file.exists())
    ? schema.safeParse(await file.text()).data
    : undefined;
};
const known = (await recorded(wallPath, Wall)) ?? {};
const knownCpu = (await recorded(cpuPath, Cpu)) ?? {};
const cost = (file: string): number =>
  known[file]?.wall_ms ?? Number.POSITIVE_INFINITY;
// The file's CPU time over its clock time in the last run: 1 for a file that only computes,
// near 0 for one that waits. Never below 0.1, so a wrong record cannot start everything at once.
const share = (file: string): number => {
  const wallMs = known[file]?.wall_ms;
  const cpuMs = knownCpu[file];
  if (wallMs === undefined || cpuMs === undefined || wallMs <= 0) return 1;
  return Math.min(1, Math.max(0.1, cpuMs / wallMs));
};
// Longest by the clock first, unknown files before all: a file started at second 280 that waits
// 60 s ends the run at 340 whatever else is done. Ordering by CPU time put exactly such files
// last (three files that wait out a 60 s time box on 2 s of CPU ended the run of 2026-11-26).
const files = (await testFiles()).toSorted((a, b) =>
  cost(a) === cost(b) ? a.localeCompare(b) : cost(b) - cost(a),
);
const started = performance.now();
const outcomes = await runAll(
  files,
  Math.max(1, Math.floor((cpus().length + 1) / 2)),
  share,
);
const failed = outcomes.filter((outcome) => outcome.exit !== 0);

await rm(failedDir, { recursive: true, force: true });
for (const outcome of failed) {
  const path = join(failedDir, `${outcome.file}.txt`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, outcome.output);
  process.stdout.write(
    `\n--- ${outcome.file} (exit ${outcome.exit}); output kept at ${relative(root, path)}\n${outcome.output}`,
  );
}
await mkdir(recordDir, { recursive: true });
await Bun.write(
  cpuPath,
  `${JSON.stringify(
    Object.fromEntries(
      outcomes
        .toSorted((a, b) => a.file.localeCompare(b.file))
        .map((outcome) => [outcome.file, outcome.cpuMs]),
    ),
    null,
    2,
  )}\n`,
);
await Bun.write(
  wallPath,
  `${JSON.stringify(
    Object.fromEntries(
      outcomes
        .toSorted((a, b) => a.file.localeCompare(b.file))
        .map((outcome) => [
          outcome.file,
          { start_ms: outcome.startMs, wall_ms: outcome.wallMs },
        ]),
    ),
    null,
    2,
  )}\n`,
);
const fileWallS = Math.round(
  outcomes.reduce((sum, outcome) => sum + outcome.wallMs, 0) / 1000,
);
const cpuTotalS = Math.round(
  outcomes.reduce((sum, outcome) => sum + outcome.cpuMs, 0) / 1000,
);
process.stdout.write(
  `\n${outcomes.length} test files, ${failed.length} failed, ${Math.round((performance.now() - started) / 1000)} s wall, ${cpuTotalS} s CPU, ${fileWallS} s summed over files by the clock (per file: ${relative(root, cpuPath)}, ${relative(root, wallPath)})\n`,
);
process.exit(failed.length > 0 ? 1 : 0);
