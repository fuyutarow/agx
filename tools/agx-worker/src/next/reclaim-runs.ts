import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute, relative, resolve, sep } from "node:path";
import { fromThrowable } from "neverthrow";
import { foldedRuns, stateDir } from "./store.ts";
export { measureRunDir } from "./run-state.ts";

const record = (name: string, id: string) =>
  ["brief.md", "ticket.orig.md", "ticket.orig.md.sha256", "report.json", "result.md", "last-progress.json", "worker-progress.jsonl", "verify-progress.json", "interim.jsonl", `${id}.json`, `${id}.last.txt`].includes(name) || /^(?:spawn|attempt)-\d+\.json$/u.test(name) || /^verify.*\.(?:log|json|jsonl|txt)$/u.test(name) || /^worker-progress-\d+\.jsonl$/u.test(name) || /^judged-evidence-[a-f0-9]{64}\.txt$/u.test(name);

function reportFailure(id: string, error: string): number {
  process.stderr.write(`agx worker reclaim-runs: ${id}: ${error}\n`);
  return 1;
}

function removePaths(id: string, paths: string[]): number {
  const proc = fromThrowable(() => Bun.spawnSync(["rip", ...paths], { stdout: "pipe", stderr: "pipe" }))();
  if (proc.isErr()) return reportFailure(id, String(proc.error));
  return proc.value.exitCode === 0 ? 0 : reportFailure(id, proc.value.stderr.toString());
}

function canonical(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  for (;;) {
    const current = probe;
    const actual = fromThrowable(() => realpathSync(current))();
    if (actual.isOk()) return resolve(actual.value, relative(probe, absolute));
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
}

function pinsFromFiles(files: string[]): string[] {
  return files.flatMap((file) => readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line !== ""));
}

function reportRemoved(paths: string[]): void {
  for (const path of paths) process.stdout.write(`removed ${path}\n`);
}

function inside(dir: string, path: string): boolean {
  const rest = relative(dir, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

export async function reclaimRuns(days: number, apply: boolean, root = stateDir(), pinFiles: string[] = []): Promise<number> {
  if (!Number.isFinite(days) || days < 0) {
    process.stderr.write("agx worker reclaim-runs: --older-than must be a nonnegative number of days\n");
    return 2;
  }
  const pins = fromThrowable(() => pinsFromFiles(pinFiles))();
  if (pins.isErr()) {
    process.stderr.write(`agx worker reclaim-runs: cannot read pins: ${String(pins.error)}\n`);
    return 2;
  }
  const invalid = pins.value.find((pin) => !isAbsolute(pin));
  if (invalid !== undefined) {
    process.stderr.write(`agx worker reclaim-runs: pin path is not absolute: ${invalid}\n`);
    return 2;
  }
  const pinPaths = pins.value.flatMap((pin) => [resolve(pin), canonical(pin)]);
  const cutoff = Temporal.Now.instant().epochMilliseconds - days * 86_400_000;
  const runs = await foldedRuns(root);
  let total = 0;
  for (const run of runs) {
    if (run.state !== "ended" || run.ended_at === null || run.judgment === null || !(fromThrowable(() => Temporal.Instant.from(run.ended_at ?? "").epochMilliseconds)().unwrapOr(Infinity) < cutoff)) continue;
    if (!/^[a-zA-Z0-9_-]+$/u.test(run.id)) continue;
    const dir = join(root, "runs", run.id);
    const canonicalDir = canonical(dir);
    if (pinPaths.some((pin) => inside(resolve(dir), pin) || inside(canonicalDir, pin))) {
      process.stdout.write(`${run.id}: pinned\n`);
      continue;
    }
    const inspected = fromThrowable(() => lstatSync(dir).isDirectory() ? readdirSync(dir) : [])();
    if (inspected.isErr()) continue;
    const names = inspected.value;
    const paths = names.filter((name) => {
      const info = lstatSync(join(dir, name));
      return info.isDirectory() || !record(name, run.id);
    }).map((name) => join(dir, name));
    // Size each candidate once, including hard links between candidates.
    const seen = new Set<string>();
    const size = (path: string): number => {
      const info = lstatSync(path);
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) return 0;
      seen.add(key);
      return info.size + (info.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0) : 0);
    };
    const bytes = paths.reduce((sum, path) => sum + size(path), 0);
    const removal = apply && paths.length > 0 ? removePaths(run.id, paths) : 0;
    if (removal !== 0) return removal;
    if (apply) reportRemoved(paths);
    total += bytes;
    process.stdout.write(`${run.id}: ${bytes} bytes ${apply ? "removed" : "reclaimable"}\n`);
  }
  process.stdout.write(`total: ${total} bytes ${apply ? "removed" : "reclaimable"}\n`);
  return 0;
}
