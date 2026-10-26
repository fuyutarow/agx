import { acquireWorkspaceLock, foldedRuns, stateDir } from "./store.ts";

export const DEFAULT_MAX_RUNNING = 4;
export const CAPACITY_WAIT_MS = 60_000;
const CAPACITY_POLL_MS = 250;

export type RunningWorker = { id: string; ticket: string };

export async function runningWorkers(): Promise<RunningWorker[]> {
  return (await foldedRuns())
    .filter((run) => run.state === "running")
    .map(({ id, ticket }) => ({ id, ticket }));
}

export const capacityMessage = (
  running: RunningWorker[],
  limit: number,
): string =>
  `agx worker: running worker limit reached (${running.length}/${limit}); running=${running.map((run) => `${run.id}(${run.ticket})`).join(", ")}; use --wait-slot to wait`;

export async function acquireWorkerSlot(
  limit: number,
  waitSlot: boolean,
  write: (message: string) => void = (message) =>
    process.stderr.write(`${message}\n`),
): Promise<
  | { ok: true; release: () => Promise<void> }
  | { ok: false; running: RunningWorker[]; reason: string }
> {
  const deadline = Temporal.Now.instant().epochMilliseconds + CAPACITY_WAIT_MS;
  const capacityLockKey = `${stateDir()}/worker-capacity`;
  let announced = false;
  while (true) {
    const lock = await acquireWorkspaceLock(capacityLockKey);
    if (!lock.ok)
      return {
        ok: false,
        running: [],
        reason: `capacity lock unavailable: ${lock.error}`,
      };
    const running = await runningWorkers();
    if (running.length < limit) return lock;
    await lock.release();
    if (!waitSlot)
      return { ok: false, running, reason: capacityMessage(running, limit) };
    if (!announced) {
      write(
        `agx worker: waiting for a worker slot; limit=${limit}; running=${running.map((run) => `${run.id}(${run.ticket})`).join(", ")}`,
      );
      announced = true;
    }
    if (Temporal.Now.instant().epochMilliseconds >= deadline)
      return {
        ok: false,
        running,
        reason: `agx worker: timed out waiting for a worker slot after ${CAPACITY_WAIT_MS}ms; ${capacityMessage(running, limit)}`,
      };
    await Bun.sleep(CAPACITY_POLL_MS);
  }
}
