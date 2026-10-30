import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { attempt, errorMessage } from "../../../shared/src/attempt.ts";
import { readFile } from "node:fs/promises";
import { parseNextTicket } from "./ticket.ts";
import { route } from "./route.ts";
import { loadRoster, ROUTING_OBJECTIVE } from "../roster/index.ts";
import { printPreflightFailures, recordRefusal } from "./preflight.ts";
import { resolveTicketReference } from "./ticket-home.ts";

const oneLine = (reason: string): string => reason.replaceAll(/[\r\n]+/gu, " ");

export async function roster(ticketPath?: string): Promise<number> {
  if (ticketPath !== undefined) {
    const reference = await resolveTicketReference(ticketPath, process.cwd());
    if (reference.contextError !== undefined) {
      process.stderr.write(`agx-worker roster: ${reference.contextError}\n`);
      return reference.contextExitCode ?? 2;
    }
    const source = await attempt(() => readFile(reference.path));
    if (!source.ok) {
      const searched =
        reference.searchedPaths.length === 0
          ? errorMessage(source.error)
          : `no such ticket: ${reference.input}; searched: ${reference.searchedPaths.map((path) => JSON.stringify(path)).join(", ")}`;
      process.stderr.write(`agx-worker roster: ${searched}\n`);
      return 1;
    }
    const parsed = parseNextTicket(source.value.toString("utf8"));
    if ((parsed.intake?.length ?? 0) > 0) {
      const failures = parsed.intake ?? [];
      recordRefusal(reference.path, process.cwd(), source.value, failures);
      return printPreflightFailures(failures);
    }
    if (!parsed.success) {
      process.stderr.write(`agx-worker roster: ${parsed.reason}\n`);
      return 2;
    }
    const row = await route(
      source.value.toString("utf8"),
      parsed.ticket.capabilities,
      parsed.ticket.timeout_s ?? 600,
      [],
      {},
      {
        min_effort: parsed.ticket.min_effort,
        path: resolve(reference.path),
        sha256: createHash("sha256").update(source.value).digest("hex"),
      },
    );
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return 0;
  }
  const loaded = await loadRoster();
  if (!loaded.ok) {
    process.stderr.write(`agx worker roster: ${oneLine(loaded.error)}\n`);
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({ ...loaded.value, objective: ROUTING_OBJECTIVE })}\n`,
  );
  return 0;
}
