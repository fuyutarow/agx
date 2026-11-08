import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Direct children owned by the suite, including legacy state retained for readers.
export const stateRootNames = [
  "active",
  "claude-credits-unavailable",
  "current-runs.json",
  // Legacy doctor output: agx 1.4.0 replaced its writer with the aggregate.
  "doctor.json",
  "doctor-aggregate.json",
  "doctor-refresh.sqlite",
  "doctor-refresh.sqlite.lock",
  "doctor-refresh.sqlite-journal",
  "doctor-refresh.sqlite-wal",
  "doctor-refresh.sqlite-shm",
  "jev-usage.jsonl",
  "land",
  "land.lock",
  "land.lock.waiters",
  "legacy-v1",
  "lifecycle.jsonl",
  "locks",
  "records.jsonl",
  // Legacy fold publication: agx-worker 5.0.0 made ls folds read-only.
  "records.fold.json",
  "records.fold.json.tmp",
  "records.snapshot.json",
  "routing.jsonl",
  "routing-refusals.jsonl",
  "runs",
  "runs.jsonl",
  "workspace-index.jsonl",
  "workspace-verdicts.json",
  "workspace-verdicts.json.lock",
  "workspaces",
  "ws-gc-classified",
  "ws-gc-starts",
  "ws-rm",
] as const;

// Atomic publication names and old dated ledgers are bounded to their writers' formats.
export function isStateRootName(name: string): boolean {
  return (
    stateRootNames.some((entry) => entry === name) ||
    /^(?:runs|lifecycle|routing)-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name) ||
    /^(?:current-runs\.json|records\.snapshot\.json|workspace-verdicts\.json)\.[0-9a-f-]{36}\.tmp$/u.test(
      name,
    ) ||
    /^doctor-aggregate\.json\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(name)
  );
}

const nonEmpty = (value: string | undefined) =>
  value === "" ? undefined : value;

/** XDG state home, ignoring relative and empty XDG_STATE_HOME values. */
export function xdgStateHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = nonEmpty(env.XDG_STATE_HOME);
  return xdg !== undefined && isAbsolute(xdg)
    ? xdg
    : join(nonEmpty(env.HOME) ?? homedir(), ".local", "state");
}

/** The sole live state directory; legacy-v1 beneath it is read-only. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(env.AGX_STATE_DIR);
  if (explicit !== undefined) return resolve(explicit);
  return join(xdgStateHome(env), "agx");
}

/** Retained for existing suite callers; retired state checks no longer apply. */
export async function stateRefusal(
  _env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  await Promise.resolve();
  return undefined;
}

export function checkState(): Promise<void> {
  return Promise.resolve();
}
