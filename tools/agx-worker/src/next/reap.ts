import { readdirSync, readFileSync, statSync } from "node:fs";
import { fromThrowable } from "neverthrow";
import { z } from "../../../shared/src/zod.ts";

export const ReapProcess = z.object({ pid: z.number(), argv0: z.string() });
export const ReapResult = z.object({
  reaped: z.object({ count: z.number(), processes: z.array(ReapProcess) }),
  survivors: z.array(ReapProcess),
  reap_status: z.string(),
});
export type ReapResult = z.output<typeof ReapResult>;
type Candidate = { pid: number; argv0: string; start: string };

function inspect(pid: number, runDir: string): Candidate | undefined {
  const path = `/proc/${pid}`;
  if (pid === process.pid || statSync(path).uid !== process.getuid?.())
    return undefined;
  if (
    !readFileSync(`${path}/environ`, "utf8")
      .split("\0")
      .includes(`AGX_RUN_DIR=${runDir}`)
  )
    return undefined;
  const stat = readFileSync(`${path}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = fields[19];
  if (fields[0] === "Z" || start === undefined) return undefined;
  const argv0 = readFileSync(`${path}/cmdline`, "utf8").split("\0")[0] ?? "";
  return { pid, argv0, start };
}

function scan(runDir: string, deadline: number, errors: string[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entry of readdirSync("/proc")) {
    if (performance.now() >= deadline) {
      errors.push("scan deadline exceeded");
      break;
    }
    if (!/^\d+$/u.test(entry)) continue;
    const candidate = fromThrowable(() => inspect(Number(entry), runDir))();
    if (candidate.isOk() && candidate.value !== undefined)
      found.push(candidate.value);
  }
  return found;
}

function signal(
  items: Candidate[],
  kind: NodeJS.Signals,
  runDir: string,
  deadline: number,
  errors: string[],
): void {
  for (const item of items) {
    if (performance.now() >= deadline) {
      errors.push("signal deadline exceeded");
      break;
    }
    const current = fromThrowable(() => inspect(item.pid, runDir))();
    if (current.isErr() || current.value?.start !== item.start) continue;
    const sent = fromThrowable(() => process.kill(item.pid, kind))();
    if (sent.isOk()) continue;
    const parsed = z
      .object({ code: z.string().optional() })
      .safeParse(sent.error);
    if (parsed.success && parsed.data.code === "ESRCH") continue;
    errors.push(`pid ${item.pid}: ${String(sent.error)}`);
  }
}

/** Only processes with this exact inherited mark and uid are eligible for a signal. */
async function performReap(runDir: string): Promise<ReapResult> {
  const result: ReapResult = {
    reaped: { count: 0, processes: [] },
    survivors: [],
    reap_status: "complete",
  };
  if (process.platform !== "linux")
    return { ...result, reap_status: "not performed: non-Linux" };
  const deadline = performance.now() + 8000;
  const errors: string[] = [];
  const scanning = fromThrowable(() => scan(runDir, deadline, errors), String);
  const first = scanning();
  if (first.isErr())
    return { ...result, reap_status: `failed: ${first.error}` };
  const initial = first.value;
  signal(initial, "SIGTERM", runDir, deadline, errors);
  const termDeadline = Math.min(deadline, performance.now() + 5000);
  let alive = initial;
  while (alive.length > 0 && performance.now() < termDeadline) {
    await Bun.sleep(50);
    const current = scanning();
    if (current.isErr()) {
      errors.push(current.error);
      break;
    }
    alive = initial.filter((p) =>
      current.value.some((c) => c.pid === p.pid && c.start === p.start),
    );
  }
  signal(alive, "SIGKILL", runDir, deadline, errors);
  if (alive.length > 0) await Bun.sleep(50);
  const final = scanning();
  if (final.isErr()) {
    errors.push(final.error);
    result.survivors = alive;
  } else {
    result.survivors = final.value.map(({ pid, argv0 }) => ({ pid, argv0 }));
    result.reaped.processes = initial
      .filter(
        (p) => !final.value.some((c) => c.pid === p.pid && c.start === p.start),
      )
      .map(({ pid, argv0 }) => ({ pid, argv0 }));
    result.reaped.count = result.reaped.processes.length;
  }
  if (errors.length > 0) result.reap_status = `failed: ${errors.join("; ")}`;
  return result;
}

/** Failures are reported without changing the run outcome. */
export function reapRun(runDir: string): Promise<ReapResult> {
  return performReap(runDir).catch((error: unknown) => ({
    reaped: { count: 0, processes: [] },
    survivors: [],
    reap_status: `failed: ${String(error)}`,
  }));
}
