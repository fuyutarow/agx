import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
  row: z.string(),
  route: z.enum(["claude", "codex"]),
  source: z.string(),
});
const RoutingRefusal = z.object({
  schema: z.literal(1),
  at: z.iso.datetime({ offset: true }),
  host: z.string().min(1),
  ticket: z.string(),
  reason: z.enum(["split", "uncheckable", "contradiction", "missing_input"]),
  probability: z.number().nullable(),
  pick_audit: PickAuditSchema.optional(),
});

/** Private owner journal: capture selections even when no worker is subsequently started. */
export function recordRoutingPick(
  row: { id: string; route: "claude" | "codex" },
  source: string,
): void {
  const root = stateDir();
  mkdirSync(root, { recursive: true });
  const event = RoutingEvent.safeParse({
    schema: 1,
    at: Temporal.Now.instant().toString(),
    host: hostname(),
    row: row.id,
    route: row.route,
    source,
  });
  if (!event.success)
    return exitWithError(
      `agx: invalid routing selection: ${event.error.message}\n`,
      2,
    );
  appendFileSync(
    join(root, "routing.jsonl"),
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

export function routingEvents() {
  const read = fromThrowable(() =>
    readFileSync(join(stateDir(), "routing.jsonl"), "utf8"),
  )();
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
