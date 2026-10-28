import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exhaustionPolicy, loadRoster, type Choice } from "../roster/index.ts";
import { exitWithError } from "./exit.ts";
import { foldedRuns, stateDir } from "./store.ts";
import { readRouteUsage } from "./usage.ts";
import { fitsPublishedTimeBox, route } from "./route.ts";
import { parseNextTicket } from "./ticket.ts";
import { resolveRunId } from "./run-id.ts";

export type PinnedContinuation = Readonly<{
  previousId: string;
  previousRow: string;
  workspace: string;
  row: Choice;
  resumeSession?: string | undefined;
  supersedes?: string;
  judgment: Readonly<{ decision: string; note: string }> | null;
  ticketOrigPath: string;
}>;

/** Inspect the saved start checksum before any continuation reservation or refusal record. */
export async function timeBoxUnchangedRefusal(
  continuationId: string | undefined,
  bytes: Uint8Array | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (continuationId === undefined || bytes === null) return undefined;
  const root = stateDir(env);
  const selected = resolveRunId(await foldedRuns(root), continuationId);
  if (selected.kind === "error") return undefined;
  const previous = selected.row;
  if (previous.state !== "ended" || previous.outcome !== "timeout")
    return undefined;
  const original =
    previous.ticket_orig_path ??
    join(root, "runs", previous.id, "ticket.orig.md");
  const checksum = await Bun.file(`${original}.sha256`)
    .text()
    .catch(() => null);
  const saved = /^([a-f0-9]{64})(?:\s|$)/u.exec(checksum ?? "")?.[1];
  const current = createHash("sha256").update(bytes).digest("hex");
  if (saved !== current) return undefined;
  return `cannot continue run ${previous.id}: time-box-unchanged: previous run ended by timeout and ticket sha256 is unchanged; repair: edit the ticket before continuing`;
}

/**
 * Ordinary continuations pin their row. Capacity continuations route away from its model.
 * Row and session refusals happen before a run directory, a started event or a worker exists.
 * A lost run with no reported session is the exception: continue it as a fresh vendor session.
 */
export async function pinContinuation(
  continuationId: string,
  ticketPath: string,
  routing?: {
    brief: string;
    capabilities: readonly string[];
    timeoutS: number;
    maskedRows: readonly string[];
  },
  onFailure?: (reason: string) => void,
): Promise<PinnedContinuation | null> {
  const refuse = (reason: string): null => {
    if (onFailure !== undefined) {
      onFailure(`cannot continue run ${continuationId}: ${reason}`);
      return null;
    }
    return exitWithError(
      `agx: cannot continue run ${continuationId}: ${reason}; start a fresh run with: agx worker run ${ticketPath}\n`,
      2,
    );
  };
  const selected = resolveRunId(await foldedRuns(), continuationId);
  if (selected.kind === "error")
    return refuse(selected.error.replace(/^unknown run id /u, "unknown run "));
  const previous = selected.row;
  const workspace = await stat(previous.workspace).catch(() => null);
  if (workspace === null || !workspace.isDirectory())
    return refuse(`its workspace ${previous.workspace} no longer exists`);
  if (previous.vendor_session === null && previous.outcome !== "capacity") {
    if (previous.outcome !== "lost")
      return refuse(
        previous.outcome === "stopped"
          ? "it ended stopped and has no vendor session to continue"
          : "it has no vendor session to continue",
      );
    if (onFailure === undefined)
      process.stderr.write(
        `agx: run ${previous.id} was lost before the vendor reported a session; continuing with a fresh session\n`,
      );
  }
  const loaded = await loadRoster();
  if (!loaded.ok) return refuse(`cannot read dispatch roster: ${loaded.error}`);
  const row = loaded.value.choice.find((entry) => entry.id === previous.row);
  if (previous.outcome === "capacity") {
    // Inspection validates the reference without selecting or launching a worker.
    if (routing === undefined) return null;
    const masked = loaded.value.choice
      .filter(
        (entry) =>
          entry.id === previous.row ||
          (row !== undefined &&
            entry.route === row.route &&
            entry.model === row.model),
      )
      .map((entry) => entry.id);
    const next = await route(
      routing.brief,
      routing.capabilities,
      routing.timeoutS,
      [...routing.maskedRows, previous.row, ...masked],
      {},
      {
        path: resolve(ticketPath),
        launch: true,
        sha256: createHash("sha256")
          .update(new Uint8Array(await Bun.file(ticketPath).arrayBuffer()))
          .digest("hex"),
      },
    );
    // Verified with `codex exec resume --help`: -m/--model overrides the resumed model.
    if (
      row?.route === "codex" &&
      next.route === "codex" &&
      previous.vendor_session !== null
    ) {
      process.stderr.write(
        `agx: capacity on ${previous.row}; resuming ${previous.id} on ${next.id} (${next.model})\n`,
      );
      return {
        previousId: previous.id,
        previousRow: previous.row,
        workspace: previous.workspace,
        row: next,
        resumeSession: previous.vendor_session,
        judgment:
          previous.judgment === null
            ? null
            : {
                decision: previous.judgment.decision,
                note: previous.judgment.note,
              },
        ticketOrigPath:
          previous.ticket_orig_path ??
          resolve(stateDir(), "runs", previous.id, "ticket.orig.md"),
      };
    }
    process.stderr.write(
      `agx: capacity on ${previous.row}; fresh dispatch on ${next.id} supersedes ${previous.id} (vendor session cannot be resumed on this route)\n`,
    );
    return {
      previousId: previous.id,
      previousRow: previous.row,
      workspace: previous.workspace,
      row: next,
      judgment:
        previous.judgment === null
          ? null
          : {
              decision: previous.judgment.decision,
              note: previous.judgment.note,
            },
      ticketOrigPath:
        previous.ticket_orig_path ??
        resolve(stateDir(), "runs", previous.id, "ticket.orig.md"),
    };
  }
  const parsedTicket =
    routing === undefined
      ? parseNextTicket(
          await Bun.file(ticketPath)
            .text()
            .catch(() => ""),
        )
      : undefined;
  const timeoutS =
    routing?.timeoutS ??
    (parsedTicket?.success === true
      ? (parsedTicket.ticket.timeout_s ?? 600)
      : undefined);
  const outsideBox =
    row !== undefined &&
    timeoutS !== undefined &&
    !fitsPublishedTimeBox(row, timeoutS);
  if (row === undefined || outsideBox) {
    if (routing === undefined && parsedTicket?.success !== true) return null;
    const inspected = parsedTicket?.success === true ? parsedTicket : undefined;
    const brief =
      routing?.brief ??
      `Proposition ${inspected?.ticket.proposition.id}: ${inspected?.ticket.proposition.claim}\n${inspected?.prose}`;
    const result = await route(
      brief,
      routing?.capabilities ?? inspected?.ticket.capabilities ?? [],
      timeoutS ?? 600,
      routing?.maskedRows ?? [],
      {},
      null,
      {
        capacityRetry: true,
        timeoutMs: loaded.value.auto.timeout_ms,
        inspect: routing === undefined,
      },
    );
    if (result.kind !== "selected")
      return refuse(
        result.kind === "refused"
          ? result.message.trim()
          : "no eligible roster row can replace the prior row",
      );
    const next = result.row;
    if (!fitsPublishedTimeBox(next, timeoutS ?? 600))
      return refuse(
        `fresh routing selected row ${next.id} outside the ${timeoutS ?? 600} s time box`,
      );
    const sessionDescription =
      previous.route === next.route
        ? "resuming the vendor session"
        : "with a fresh vendor session";
    if (routing !== undefined)
      process.stderr.write(
        outsideBox
          ? `agx: row ${previous.row} is outside the ${timeoutS} s time box; continuing ${previous.id} on ${next.id}\n`
          : `agx: retired row ${previous.row}; continuing ${previous.id} on ${next.id} (${next.model}) ${sessionDescription}\n`,
      );
    return {
      previousId: previous.id,
      previousRow: previous.row,
      workspace: previous.workspace,
      row: next,
      resumeSession:
        previous.route === next.route
          ? (previous.vendor_session ?? undefined)
          : undefined,
      judgment:
        previous.judgment === null
          ? null
          : {
              decision: previous.judgment.decision,
              note: previous.judgment.note,
            },
      ticketOrigPath:
        previous.ticket_orig_path ??
        resolve(stateDir(), "runs", previous.id, "ticket.orig.md"),
    };
  }
  const usage = await readRouteUsage(
    undefined,
    exhaustionPolicy(loaded.value.auto),
  );
  if (!usage[row.route].available)
    return refuse(`its ${row.route} route is at its subscription limit`);
  return {
    previousId: previous.id,
    previousRow: previous.row,
    workspace: previous.workspace,
    row,
    resumeSession: previous.vendor_session ?? undefined,
    judgment:
      previous.judgment === null
        ? null
        : {
            decision: previous.judgment.decision,
            note: previous.judgment.note,
          },
    ticketOrigPath:
      previous.ticket_orig_path ??
      resolve(stateDir(), "runs", previous.id, "ticket.orig.md"),
  };
}
