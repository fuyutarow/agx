import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stateDir } from "../state.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { exitWithError } from "./exit.ts";
import { fromThrowable } from "neverthrow";

import { PickAuditSchema, type PickAudit } from "./store.ts";

const RoutingEvent = z.object({
  schema: z.literal(1),
  at: z.iso.datetime({ offset: true }),
  host: z.string().min(1),
  row: z.string().nullable(),
  route: z.enum(["claude-api", "claude-session", "codex"]).nullable(),
  source: z.string(),
  audit: z.record(z.string(), z.unknown()).optional(),
  outcome: z.string().optional(),
});
const RoutingRefusal = z.object({
  schema: z.literal(1),
  at: z.iso.datetime({ offset: true }),
  host: z.string().min(1),
  ticket: z.string(),
  reason: z.enum(["split", "uncheckable", "contradiction", "missing_input"]),
  reason_detail: z.string().optional(),
  probability: z.number().nullable(),
  pick_audit: z.lazy(() => PickAuditSchema).optional(),
});

/** Private owner journal: capture selections even when no worker is subsequently started. */
export function recordRoutingPick(
  row: { id: string; route: "claude-api" | "claude-session" | "codex" } | null,
  source: string,
  audit?: Record<string, unknown>,
  outcome = "selected",
  root = stateDir(),
): void {
  mkdirSync(root, { recursive: true });
  const event = RoutingEvent.safeParse({
    schema: 1,
    at: Temporal.Now.instant().toString(),
    host: hostname(),
    row: row?.id ?? null,
    route: row?.route ?? null,
    source,
    audit,
    outcome,
  });
  if (!event.success)
    return exitWithError(
      `agx: invalid routing selection: ${event.error.message}\n`,
      2,
    );
  appendFileSync(
    join(root, `routing-${event.data.at.slice(0, 10)}.jsonl`),
    `${JSON.stringify(event.data)}\n`,
    {
      mode: 0o600,
    },
  );
}

/** Record a Jev return before any worker starts. */
export function recordRoutingRefusal(input: {
  ticket: string;
  reason: "split" | "uncheckable" | "contradiction" | "missing_input";
  probability?: number;
  pick_audit?: PickAudit;
}): void {
  const root = stateDir();
  mkdirSync(root, { recursive: true });
  const event = RoutingRefusal.safeParse({
    schema: 1,
    at: Temporal.Now.instant().toString(),
    host: hostname(),
    ticket: input.ticket,
    reason: input.reason,
    probability: input.probability ?? null,
    pick_audit: input.pick_audit,
  });
  if (!event.success)
    return exitWithError(
      `agx: invalid routing refusal: ${event.error.message}\n`,
      2,
    );
  appendFileSync(
    join(root, "routing-refusals.jsonl"),
    `${JSON.stringify(event.data)}\n`,
    { mode: 0o600 },
  );
}

function routingFiles(root: string): string[] {
  const entries = fromThrowable(() => readdirSync(root))();
  if (entries.isErr()) {
    if (
      z.object({ code: z.literal("ENOENT") }).safeParse(entries.error).success
    )
      return [];
    return exitWithError(
      `agx: cannot read routing statistics: ${String(entries.error)}\n`,
      2,
    );
  }
  return entries.value
    .filter((name) => /^routing-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
    .toSorted()
    .toReversed();
}

function readRoutingFile(root: string, name: string) {
  const read = fromThrowable(() => readFileSync(join(root, name), "utf8"))();
  if (read.isErr()) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(read.error).success)
      return { events: [], trailingPartial: false, present: false };
    return exitWithError(
      `agx: cannot read routing statistics: ${String(read.error)}\n`,
      2,
    );
  }
  const lines = read.value.split("\n");
  const tail = lines.pop();
  return {
    events: lines
      .filter((line) => line !== "")
      .map((line) => {
        const parsed = jsonOf(RoutingEvent).safeParse(line);
        if (!parsed.success)
          return exitWithError(
            `agx worker stats: cannot collect routing statistics: ${parsed.error.message}\n`,
            2,
          );
        return parsed.data;
      }),
    trailingPartial: tail !== "",
    present: true,
  };
}

/** Read all journals in chronological file order for aggregate statistics. */
export function routingEvents() {
  const root = stateDir();
  const files = ["routing.jsonl", ...routingFiles(root).toReversed()];
  const journals = files.map((file) => readRoutingFile(root, file));
  return {
    events: journals.flatMap((journal) => journal.events),
    trailingPartial: journals.some((journal) => journal.trailingPartial),
    present: journals.some((journal) => journal.present),
  };
}

/** Find the first matching decision, preferring the newest dated journal. */
export function routingDecision(decisionId: string, root = stateDir()) {
  for (const file of [...routingFiles(root), "routing.jsonl"]) {
    const event = readRoutingFile(root, file).events.find(
      (row) => row.audit?.decision_id === decisionId,
    );
    if (event !== undefined) return event;
  }
  return null;
}

export function newRoutingAudit(
  ticket: {
    path: string;
    sha256: string | null;
    launch?: boolean;
  } | null = null,
  capabilities: readonly string[] = [],
  timeoutS = 600,
): Record<string, unknown> {
  const audit: Record<string, unknown> = {
    decision_id: randomUUID(),
    ticket_path: ticket?.path ?? null,
    launch_expected: ticket?.launch ?? false,
    ticket_sha256: ticket?.sha256 ?? null,
    outcome_kind: "held",
    input: null,
    input_sha256: null,
    input_truncated: false,
    filters: [],
    capability_tags: [...capabilities],
    timeout_class: timeoutS > 600 ? "extended" : "standard",
    pick_temperature: null,
    selection_mode: null,
    policy_version: null,
    catalog_version: null,
    jev_model_version: null,
    raw_reply: null,
    usage_id: null,
    sampling_seed: null,
    top_margin: null,
    tb4_removed_all_luna: false,
  };
  if (timeoutS >= 3600) audit.timeout_class = "multi-hour";
  return audit;
}
