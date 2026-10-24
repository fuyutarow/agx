import { foldedRuns } from "./store.ts";
import { listingProgress } from "./listing-progress.ts";

/** Resolve only the named run through the same read-only projection as worker ls. */
export async function runMessageSender(
  id: string,
): Promise<string | undefined> {
  const run = (await foldedRuns()).find((candidate) => candidate.id === id);
  if (run === undefined) return undefined;
  const [current] = await listingProgress([run]);
  if (
    typeof current?.vendor_session !== "string" ||
    (current.route !== "codex" && current.route !== "claude")
  )
    return undefined;
  return `${current.route}:${current.vendor_session}`;
}
