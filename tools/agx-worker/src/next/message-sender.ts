import { recordedRun } from "./store.ts";
import { listingProgress } from "./listing-progress.ts";

/** Resolve the named run's identity without projecting sandbox-visible liveness. */
export async function runMessageSender(
  id: string,
): Promise<string | undefined> {
  const run = recordedRun(id);
  if (run === undefined) return undefined;
  const [current] = await listingProgress([
    { ...run, lease: run.lease ?? { pid: run.pid, start: null, unit: null } },
  ]);
  if (
    typeof current?.vendor_session !== "string" ||
    (current.route !== "codex" && current.route !== "claude")
  )
    return undefined;
  return `${current.route}:${current.vendor_session}`;
}
