import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { foldedRuns, listingHistory } from "./store.ts";
import { resolveRunId } from "./run-id.ts";
import type { Flags } from "./run.ts";
const value = (flags: Flags, key: string): string | undefined =>
  typeof flags[key] === "string" ? flags[key] : undefined;
const selectedRuns = (
  rows: Awaited<ReturnType<typeof foldedRuns>>,
  selector: string | undefined,
  startedAt: Map<string, string>,
): { rows: Awaited<ReturnType<typeof foldedRuns>>; error?: string } => {
  const newestFirst = rows.toSorted((a, b) =>
    (startedAt.get(b.id) ?? "").localeCompare(startedAt.get(a.id) ?? ""),
  );
  if (selector === undefined) return { rows: newestFirst };
  const exactId = rows.find((entry) => entry.id === selector);
  if (exactId !== undefined) return { rows: [exactId] };
  const ticketRuns = rows.filter((entry) => entry.ticket === selector);
  if (ticketRuns.length > 0)
    return {
      rows: ticketRuns.toSorted((a, b) =>
        (startedAt.get(a.id) ?? "").localeCompare(startedAt.get(b.id) ?? ""),
      ),
    };
  const resolution = resolveRunId(rows, selector);
  if (resolution.kind === "resolved") return { rows: [resolution.row] };
  if (resolution.error.includes("ambiguous"))
    return {
      rows: [],
      error: `selector '${selector}' is ambiguous; ${resolution.error.split("; ")[1]}`,
    };
  return {
    rows: [],
    error: `no run id or exact ticket matches '${selector}'; ticket candidates: ${[
      ...new Set(rows.map((entry) => `tkt_${entry.ticket}`)),
    ]
      .toSorted()
      .slice(0, 10)
      .join(", ")}`,
  };
};

import { runningSummary, listingRows } from "./listing.ts";
import { listingProgress } from "./listing-progress.ts";

export async function list(flags: Flags): Promise<number> {
  const includeLegacy = flags.includeLegacy === true;
  const visibleHistory = async (workspace?: string) => {
    const history = await listingHistory(workspace);
    const malformed = history.malformed.filter(
      (row) => workspace === undefined || row.workspace === workspace,
    );
    const hidden = includeLegacy ? 0 : malformed.length;
    if (hidden > 0)
      process.stderr.write(
        `agx: hidden_legacy=${hidden} malformed imported runs; use --include-legacy to inspect\n`,
      );
    return {
      runs: history.runs,
      malformed: includeLegacy ? malformed : [],
      hidden,
    };
  };
  const workspacePath = value(flags, "workspace");
  const workspace =
    workspacePath === undefined
      ? undefined
      : await realpath(resolve(workspacePath)).catch(() => null);
  if (workspace === null) {
    process.stderr.write(
      "agx: workspace path does not exist or cannot be resolved\n",
    );
    return 2;
  }
  const latest = flags.latest === true || value(flags, "latest") === "true";
  const ticket = value(flags, "ticket");
  if (latest || ticket !== undefined) {
    const selector = value(flags, "selector");
    if (latest && ticket === undefined) {
      process.stderr.write("agx: --latest requires --ticket <name>\n");
      return 2;
    }
    if (!latest) {
      process.stderr.write("agx: --ticket requires --latest\n");
      return 2;
    }
    if (
      selector !== undefined ||
      flags.all === true ||
      flags.running === true ||
      flags.wait === true ||
      flags.summary === true ||
      workspace !== undefined
    ) {
      process.stderr.write(
        "agx: --latest accepts only --ticket <name> and optional --json\n",
      );
      return 2;
    }
    const { runs: allRuns } = await visibleHistory();
    const ticketRuns = allRuns.filter((entry) => entry.ticket === ticket);
    const latestRun = ticketRuns.at(-1);
    if (latestRun === undefined) {
      const candidates = [
        ...new Set(allRuns.map((entry) => `tkt_${entry.ticket}`)),
      ]
        .toSorted()
        .slice(0, 10);
      process.stderr.write(
        `agx: no run for exact ticket '${ticket}'${candidates.length === 0 ? "" : `; ticket candidates: ${candidates.join(", ")}`}\n`,
      );
      return 2;
    }
    const verifyExits = latestRun.verify.map((result) => result.exit);
    if (flags.json === true || value(flags, "json") === "true") {
      process.stdout.write(
        `${JSON.stringify({
          id: latestRun.id,
          state: latestRun.state,
          outcome: latestRun.outcome,
          verify_exits: verifyExits,
          report_path: latestRun.report_path,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${latestRun.id} state=${latestRun.state} outcome=${latestRun.outcome ?? "-"} verify_exits=${verifyExits.length === 0 ? "-" : verifyExits.join(",")} report_path=${latestRun.report_path ?? "-"}\n`,
      );
    }
    return 0;
  }
  const running = flags.running === true || value(flags, "running") === "true";
  const history = await visibleHistory(workspace);
  const rows = history.runs.filter(
    (entry) => !running || entry.state === "running",
  );
  const asJson = value(flags, "json") === "true" || flags.json === true;
  const all = flags.all === true || value(flags, "all") === "true";
  const selector = value(flags, "selector");
  const startedAt = new Map(rows.map((entry) => [entry.id, entry.started_at]));
  const selection = selectedRuns(rows, selector, startedAt);
  if (
    selection.error !== undefined &&
    !history.malformed.some(
      (row) => row.id === selector || row.ticket === selector,
    )
  ) {
    process.stderr.write(`agx: ${selection.error}\n`);
    return 2;
  }
  let visible = selection.rows;
  if (selector === undefined && !all && !asJson) visible = visible.slice(0, 30);
  let output = visible
    .map(
      (entry) =>
        `${entry.id} ${entry.state} tkt_${entry.ticket} row=${entry.row} exit=${entry.exit ?? "-"} outcome=${entry.outcome ?? "-"}`,
    )
    .join("\n");
  if (asJson) {
    const selected = selector === undefined ? rows : visible;
    const projected = await listingProgress(selected);
    const malformed = history.malformed.filter(
      (row) =>
        !running &&
        (selector === undefined ||
          row.id === selector ||
          row.ticket === selector),
    );
    let payload: unknown = [...listingRows(projected), ...malformed];
    if (flags.summary === true) {
      payload = {
        runs: payload,
        summary: { ...runningSummary(selected), hidden_legacy: history.hidden },
      };
    }
    output = JSON.stringify(payload) + "\n";
  } else if (selector === undefined && visible.length > 0) {
    output += "\n";
    const older = rows.length - visible.length;
    if (older > 0) output += `… ${older} older (agx worker ls --all)\n`;
  }
  if (!asJson && !running) {
    output += history.malformed
      .filter(
        (row) =>
          selector === undefined ||
          row.id === selector ||
          row.ticket === selector,
      )
      .map((row) => `${JSON.stringify(row)}\n`)
      .join("");
  }
  process.stdout.write(output);
  return 0;
}
