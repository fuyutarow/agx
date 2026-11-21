#!/usr/bin/env bun
// The gate's test runner. Each test file runs as its own `bun test` process, a few at a time.
//
// It makes two separate claims:
//   - nothing hangs: bunfig.toml's test timeout (HANG_DETECTION_MS in tools/shared/src/test-tmp.ts)
//     stops a stuck test. That limit says nothing about speed.
//   - nothing got more expensive: each file's CPU time (the test process and every child it
//     waited for) stays within its budget in tools/test-cpu-budget.json. CPU time is used because
//     wall time on a shared machine measures the machine's load, and its clock, not the test.
//
// `--update-budget` rewrites the budget file from this run instead of judging against it.
import { cpus } from "node:os";
import { join, relative } from "node:path";
import { jsonOf, z } from "./shared/src/zod.ts";

const root = join(import.meta.dir, "..");
const budgetPath = join(import.meta.dir, "test-cpu-budget.json");
/** A file may use this many times its recorded CPU before the gate calls it a regression. */
const BUDGET_FACTOR = 2;
/**
 * A file is not judged below this much CPU. Small files are noisy: in 10 runs on a loaded
 * machine, a file recorded at 3.2 s once used 9.5 s while the whole suite used 15% more.
 */
const BUDGET_FLOOR_MS = 10_000;
/** The whole suite may use this many times its recorded CPU (10 runs spanned 1056 to 1262 s). */
const TOTAL_FACTOR = 1.3;

const Budget = z.record(z.string(), z.number().int().positive());

async function testFiles(): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
  for await (const file of glob.scan({ cwd: root, onlyFiles: true }))
    if (!/(?:^|\/)(?:node_modules|\.jj|\.git)\//u.test(file)) files.push(file);
  return files.toSorted();
}

type Outcome = { file: string; exit: number; cpuMs: number; output: string };

async function runFile(file: string): Promise<Outcome> {
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
    output: out + err,
  };
}

async function runAll(files: string[], width: number): Promise<Outcome[]> {
  const queue = [...files];
  const outcomes: Outcome[] = [];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift())
      outcomes.push(await runFile(file));
  };
  await Promise.all(Array.from({ length: width }, worker));
  return outcomes;
}

const allowance = (recordedMs: number): number =>
  Math.max(BUDGET_FLOOR_MS, recordedMs * BUDGET_FACTOR);

const update = process.argv.includes("--update-budget");
const budgetFile = Bun.file(budgetPath);
const parsedBudget = jsonOf(Budget).safeParse(
  (await budgetFile.exists()) ? await budgetFile.text() : "{}",
);
if (!parsedBudget.success) {
  process.stdout.write(
    `${relative(root, budgetPath)} is not a map of file to CPU milliseconds: ${parsedBudget.error.message}\n`,
  );
  process.exit(1);
}
const budget = parsedBudget.data;
const cost = (file: string): number => budget[file] ?? Number.POSITIVE_INFINITY;
// Costliest first, unknown files before all: the longest file bounds the wall time, so it must
// not start last.
const files = (await testFiles()).toSorted((a, b) =>
  cost(a) === cost(b) ? a.localeCompare(b) : cost(b) - cost(a),
);
const started = performance.now();
const outcomes = await runAll(
  files,
  Math.max(1, Math.floor((cpus().length + 1) / 2)),
);
const failed = outcomes.filter((outcome) => outcome.exit !== 0);
for (const outcome of failed)
  process.stdout.write(
    `\n--- ${outcome.file} (exit ${outcome.exit})\n${outcome.output}`,
  );
const cpuTotalS = Math.round(
  outcomes.reduce((sum, outcome) => sum + outcome.cpuMs, 0) / 1000,
);
process.stdout.write(
  `\n${outcomes.length} test files, ${failed.length} failed, ${Math.round((performance.now() - started) / 1000)} s wall, ${cpuTotalS} s CPU\n`,
);

if (update) {
  if (failed.length > 0) {
    process.stdout.write(
      "budget not updated: a failing file has no trustworthy CPU time\n",
    );
    process.exit(1);
  }
  const measured = Object.fromEntries(
    outcomes
      .toSorted((a, b) => a.file.localeCompare(b.file))
      .map((outcome) => [outcome.file, Math.max(1, outcome.cpuMs)]),
  );
  await Bun.write(budgetPath, `${JSON.stringify(measured, null, 2)}\n`);
  process.stdout.write(`wrote ${relative(root, budgetPath)}\n`);
  process.exit(0);
}

const unregistered = outcomes.filter(
  (outcome) => budget[outcome.file] === undefined,
);
const stale = Object.keys(budget).filter((file) => !files.includes(file));
const over = outcomes.filter(
  (outcome) =>
    budget[outcome.file] !== undefined &&
    outcome.cpuMs > allowance(budget[outcome.file] ?? 0),
);
for (const outcome of unregistered)
  process.stdout.write(
    `no CPU budget for ${outcome.file}: run \`mise run test:budget\`\n`,
  );
for (const file of stale)
  process.stdout.write(
    `CPU budget names a file that no longer exists: ${file}\n`,
  );
for (const outcome of over)
  process.stdout.write(
    `${outcome.file} used ${outcome.cpuMs} ms of CPU; its budget is ${allowance(budget[outcome.file] ?? 0)} ms (${BUDGET_FACTOR} x the recorded ${budget[outcome.file]} ms)\n`,
  );
const usedMs = outcomes.reduce((sum, outcome) => sum + outcome.cpuMs, 0);
const totalAllowanceMs = Math.round(
  Object.values(budget).reduce((sum, ms) => sum + ms, 0) * TOTAL_FACTOR,
);
const totalOver = usedMs > totalAllowanceMs;
if (totalOver)
  process.stdout.write(
    `the suite used ${usedMs} ms of CPU; its budget is ${totalAllowanceMs} ms (${TOTAL_FACTOR} x the recorded total)\n`,
  );
process.exit(
  failed.length + unregistered.length + stale.length + over.length > 0 ||
    totalOver
    ? 1
    : 0,
);
