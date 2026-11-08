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

function inside(dir: string, path: string): boolean {
  const rest = relative(dir, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function inspectRun(dir: string, id: string) {
  return fromThrowable(() => {
      const names = lstatSync(dir).isDirectory() ? readdirSync(dir) : [];
      const paths = names.filter((name) => {
        const info = lstatSync(join(dir, name));
        return info.isDirectory() || !record(name, id);
      }).map((name) => join(dir, name));
      const entries: { key: string; size: number; links: number; file: boolean }[] = [];
      const walk = (path: string): void => {
        const info = lstatSync(path);
        entries.push({ key: `${info.dev}:${info.ino}`, size: info.size, links: info.nlink, file: info.isFile() });
        if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
      };
      for (const path of paths) walk(path);
      return { paths, entries };
  })();
}

export async function reclaimRuns(days: number, apply: boolean, root = stateDir(), pinFiles: string[] = [], noPins = false): Promise<number> {
  if (!Number.isFinite(days) || days < 0) {
    process.stderr.write("agx worker reclaim-runs: --older-than must be a nonnegative number of days\n");
    return 2;
  }
  if (apply && pinFiles.length === 0 && !noPins) {
    process.stderr.write("agx worker reclaim-runs: --apply needs --pin <file> or --no-pins; research records may reference run-directory paths\n");
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
  let skipped = 0;
  let moved = 0;
  const candidates: { id: string; paths: string[]; bytes: number }[] = [];
  const inodes = new Map<string, { size: number; links: number; count: number }>();
  for (const run of runs) {
    if (run.state !== "ended" || run.ended_at === null || run.judgment === null || !(fromThrowable(() => Temporal.Instant.from(run.ended_at ?? "").epochMilliseconds)().unwrapOr(Infinity) < cutoff)) continue;
    if (!/^[a-zA-Z0-9_-]+$/u.test(run.id)) continue;
    const dir = join(root, "runs", run.id);
    const canonicalDir = canonical(dir);
    if (pinPaths.some((pin) => inside(resolve(dir), pin) || inside(canonicalDir, pin))) {
      process.stdout.write(`${run.id}: pinned\n`);
      continue;
    }
    const inspected = inspectRun(dir, run.id);
    if (inspected.isErr()) {
      skipped++;
      process.stderr.write(`${run.id}: skipped: ${String(inspected.error)}\n`);
      continue;
    }
    let bytes = 0;
    for (const entry of inspected.value.entries) {
      const previous = inodes.get(entry.key);
      inodes.set(entry.key, { size: entry.file ? entry.size : 0, links: entry.links, count: (previous?.count ?? 0) + 1 });
      bytes += previous === undefined ? entry.size : 0;
    }
    candidates.push({ id: run.id, paths: inspected.value.paths, bytes });
  }
  for (const [index, candidate] of candidates.entries()) {
    if (apply && candidate.paths.length > 0 && removePaths(candidate.id, candidate.paths) !== 0) {
      process.stderr.write(`stopped at ${candidate.id}: ${moved} runs moved, ${candidates.length - index - 1} runs not attempted; rerun the same command to continue\n`);
      process.stderr.write(skipped > 0 ? `skipped: ${skipped} runs\n` : "");
      return 1;
    }
    if (apply && candidate.paths.length > 0) moved++;
    total += candidate.bytes;
    process.stdout.write(`${candidate.id}: ${candidate.bytes} bytes ${apply ? "moved" : "would move"} to the graveyard\n`);
  }
  process.stdout.write(`total: ${total} bytes ${apply ? "moved" : "would move"} to the graveyard\n`);
  const shared = [...inodes.values()].reduce((sum, inode) => sum + (inode.links > inode.count ? inode.size : 0), 0);
  if (shared > 0) process.stdout.write(`shared: ${shared} bytes are in files with hard links outside the moved set; moving them frees no space\n`);
  if (skipped > 0) process.stderr.write(`skipped: ${skipped} runs\n`);
  process.stderr.write("rip keeps moved files in the graveyard; disk space returns only when the graveyard is purged\n");
  return 0;
}
