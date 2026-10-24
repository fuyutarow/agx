import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { attempt, errorMessage } from "../../../shared/src/attempt.ts";
import { readFile } from "node:fs/promises";
import { parseNextTicket } from "./ticket.ts";
import { route } from "./route.ts";
import { loadRoster, ROUTING_OBJECTIVE } from "../roster/index.ts";
import { printPreflightFailures, recordRefusal } from "./preflight.ts";

const oneLine = (reason: string): string => reason.replaceAll(/[\r\n]+/gu, " ");

export async function roster(ticketPath?: string): Promise<number> {
  if (ticketPath !== undefined) {
    const source = await attempt(() => readFile(ticketPath));
    if (!source.ok) {
      process.stderr.write(
        `agx-worker roster: ${errorMessage(source.error)}\n`,
      );
      return 1;
    }
    const parsed = parseNextTicket(source.value.toString("utf8"));
    if ((parsed.intake?.length ?? 0) > 0) {
      const failures = parsed.intake ?? [];
      recordRefusal(ticketPath, process.cwd(), source.value, failures);
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
        path: resolve(ticketPath),
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
