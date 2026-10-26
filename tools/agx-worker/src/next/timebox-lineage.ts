import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNextTicket, type NextTicket } from "./ticket.ts";
import { resolveRunId } from "./run-id.ts";

type LineageRun = Readonly<{
  id: string;
  continues?: string | null | undefined;
  outcome?: string | null | undefined;
}>;

/** Inspect only the selected run and its ancestors; sibling runs do not count. */
export async function timeboxLineageRefusal(
  runs: readonly LineageRun[],
  continuation: string,
  ticket: NextTicket,
  prose: string,
  stateRoot: string,
): Promise<string | undefined> {
  const selected = resolveRunId(runs, continuation);
  if (selected.kind === "error") return undefined;
  const byId = new Map(runs.map((run) => [run.id, run]));
  const seen = new Set<string>();
  const timeouts: string[] = [];
  let current: LineageRun | undefined = selected.row;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.outcome === "timeout") timeouts.push(current.id);
    if (timeouts.length === 2) break;
    current = byId.get(current.continues ?? "");
  }
  const latest = timeouts[0];
  if (timeouts.length < 2 || latest === undefined) return undefined;
  if (/^Split into:[\t ]*\S[^\r\n]*$/mu.test(prose)) return undefined;
  if (/^Time box raised:[\t ]*\S[^\r\n]*$/mu.test(prose)) {
    // Compare with the immutable input, never the edited ticket_path in a run row.
    const source = await readFile(
      join(stateRoot, "runs", latest, "ticket.orig.md"),
      "utf8",
    ).catch(() => null);
    const previous =
      source === null ? undefined : parseNextTicket(source, true);
    if (
      previous?.success === true &&
      (ticket.timeout_s ?? 600) > (previous.ticket.timeout_s ?? 600)
    )
      return undefined;
  }
  return `time-box-lineage: runs ${timeouts.join(", ")} timed out in one continuation lineage; repair: raise timeout_s above the last timed-out run and add a 'Time box raised:' line, or list split-off tickets on a 'Split into:' line`;
}
