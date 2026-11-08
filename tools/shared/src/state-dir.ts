import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lstat } from "node:fs/promises";

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

/** The sole live state directory; legacy-v1 beneath it is read-only. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    nonEmpty(env.AGX_STATE_DIR) ??
    join(
      nonEmpty(env.XDG_STATE_HOME) ??
        join(env.HOME ?? homedir(), ".local", "state"),
      "agx",
    )
  );
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Refuse retired configuration before any command can read or write state. */
export async function stateRefusal(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (env.AGX_NEXT_STATE_DIR !== undefined)
    return "agx: AGX_NEXT_STATE_DIR is retired; use AGX_STATE_DIR";
  const dir = stateDir(env);
  const base = dirname(dir);
  if (!(await exists(dir)) && (await exists(join(base, "agx-next"))))
    return `agx: state migration required; run: mv ${join(base, "agx")} ${join(base, "agx.legacy-v1.tmp")} && mv ${join(base, "agx-next")} ${join(base, "agx")} && mv ${join(base, "agx.legacy-v1.tmp")} ${join(base, "agx/legacy-v1")}`;
  return undefined;
}

export async function checkState(): Promise<void> {
  const refusal = await stateRefusal();
  if (refusal !== undefined) {
    process.stderr.write(refusal + "\n");
    process.exit(2);
  }
}
