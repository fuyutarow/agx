// report — the typed final report every worker is asked to end with, in ONE place: the zod schema, its
// JSON-schema rendering for the two CLIs (claude --json-schema, codex exec --output-schema), the
// instruction the router appends to every worker prompt, the validator and the readable rendering.
// Owner 2026-10-06: coordinators dug final reports out of stream-json by hand, many workers ended with
// none, and prose reports vary in shape so a coordinator could not check them mechanically. Nothing
// here calls a model or fails a run: an invalid or missing report is recorded, never fatal.
import { jsonText, z } from "../../shared/src/zod.ts";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const WorkerReport = z.object({
  summary: z.string(),
  changes: z.array(z.object({ path: z.string(), what: z.string() })),
  checks: z.array(
    z.object({
      cmd: z.string(),
      exit: z.union([z.number(), z.literal("unknown")]),
      exit_text: z.string().optional(),
      result: z.string(),
    }),
  ),
  /** commands the coordinator should run, or decisions it must make */
  for_coordinator: z.array(z.string()),
  open: z.array(z.string()),
});
export type WorkerReport = z.output<typeof WorkerReport>;

/** The single structured record workers return when the dispatcher needs to choose what happens next. */
export const ReturnSchema = z.strictObject({
  interim: z.boolean().optional(),
  findings: z.array(
    z.strictObject({ text: z.string(), fleet: z.boolean().optional() }),
  ),
  evidence: z.array(z.string()),
  impact_on_brief: z.string(),
  proposed_next: z.string(),
  artifacts: z.array(z.string()),
});
export type ReturnRecord = z.output<typeof ReturnSchema>;

/** The schema as JSON-schema text (strict: every key required, no extra keys), for the CLIs' flags. */
export const reportJsonSchema = (): string =>
  // Claude's validator rejects the 2020-12 meta-schema, so emit draft-07 for both CLIs.
  `${JSON.stringify(z.toJSONSchema(WorkerReport, { target: "draft-7" }), null, 2)}\n`;

const SHAPE = `{ "summary": string,
  "changes": [{ "path": string, "what": string }],
  "checks": [{ "cmd": string, "exit": number | "unknown", "exit_text"?: string, "result": string }],
  "for_coordinator": [string],
  "open": [string] }`;

const RETURN_SHAPE = `{ "interim"?: boolean, "findings": [{ "text": string, "fleet"?: boolean }],
  "evidence": [string],
  "impact_on_brief": string,
  "proposed_next": string,
  "artifacts": [string] }`;

const RETURN_FENCE = /```agx-return\s*\n([\s\S]*?)\n```/gu;
const RETURN_OPEN = /```agx-return\s*\n/u;

/** Appended to every worker prompt, after the ticket's verify line. */
export const REPORT_INSTRUCTION = `## Final report (required)
Housekeeping decisions are yours. Choose the obvious version number, CHANGELOG placement,
adjacent files needed for the change, fixture names, and meaning of a count; note the choice
in your report and continue. RETURN only for a decision that changes the outcome or contradicts
the brief.
Your final message must start with ONE JSON object and nothing else before it, of this shape:
${SHAPE}
- summary: what you did and the outcome, in a few sentences.
- changes: one entry per file you changed or created (path, what changed); [] if none.
- checks: every command you ran to check your work (cmd, numeric exit code when available, otherwise set exit to "unknown" and preserve the original status in exit_text, plus one line on the result); [] if none.
- for_coordinator: commands the coordinator should run, or decisions it must make; [] if none.
- open: what is unfinished, uncertain or skipped; [] if nothing.

## RETURN triggers and format
Stop and RETURN immediately when:
- you find something that contradicts the brief's premise, scope or method;
- you reach a decision whose options lead to diverging outcomes the dispatcher should choose between;
- you are told the time box is ending.
Returning early with findings is success. Include the final report JSON above, then append a fenced block tagged \`agx-return\` containing JSON of this shape:
${RETURN_SHAPE}
Do not wait to finish the planned work before returning.
For a first_return_s progress checkpoint, set "interim": true in the agx-return block.
An interim RETURN records progress and continues the same vendor session with:
"continue; send the final report when done". Keep running jobs. Omit interim (or set false)
for a final RETURN that needs the coordinator and ends the run.`;

/** The prompt with the report instruction appended. */
export const withReportInstruction = (text: string): string =>
  `${text.trimEnd()}\n\n${REPORT_INSTRUCTION}\n`;

export type ParsedReport =
  | { ok: true; report: WorkerReport; warnings?: string[] }
  | { ok: false; error: string };

/** Complete top-level JSON object spans, including objects embedded in surrounding prose. */
const jsonObjectSpans = (text: string): { start: number; end: number }[] => {
  const spans: { start: number; end: number }[] = [];
  let start: number | undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (quoted && char === '"') quoted = false;
    else if (quoted) continue;
    else if (char === '"' && depth > 0) quoted = true;
    else if (char === "{") {
      start ??= index;
      depth += 1;
    } else if (char === "}" && depth > 0) depth -= 1;
    if (!quoted && char === "}" && depth === 0 && start !== undefined) {
      spans.push({ start, end: index + 1 });
      start = undefined;
    }
  }
  return spans;
};

export type ParsedReturn =
  | { kind: "missing" }
  | { kind: "valid"; record: ReturnRecord }
  | { kind: "invalid"; error: string };

/** Parse the optional fenced RETURN record from a worker's final message. */
export function parseReturn(lastMessage: string): ParsedReturn {
  const block = [...lastMessage.matchAll(RETURN_FENCE)].at(-1);
  if (block === undefined) {
    return RETURN_OPEN.test(lastMessage)
      ? { kind: "invalid", error: "unterminated agx-return block" }
      : { kind: "missing" };
  }
  const decoded = jsonText.safeParse(block[1]);
  if (!decoded.success)
    return {
      kind: "invalid",
      error: `agx-return block is not valid JSON: ${decoded.error.issues[0]?.message ?? "unreadable"}`,
    };
  const parsed = ReturnSchema.safeParse(decoded.data);
  if (!parsed.success)
    return {
      kind: "invalid",
      error: `agx-return block has the wrong shape: ${parsed.error.issues
        .slice(0, 3)
        .map(
          (i) =>
            `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
        )
        .join("; ")}`,
    };
  return { kind: "valid", record: parsed.data };
}

/** Retain stream checkpoints even when a later message replaces the vendor's last-message file. */
export function interimReturnWriter(path: string | undefined) {
  let previous: string | undefined;
  let pending = Promise.resolve();
  const record = (message: string): Promise<void> => {
    if (path === undefined || message === previous) return pending;
    const parsed = parseReturn(message);
    if (parsed.kind !== "valid" || parsed.record.interim !== true)
      return pending;
    previous = message;
    pending = pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify({ last_message: message })}\n`);
    });
    return pending;
  };
  return Object.assign(record, { flush: (): Promise<void> => pending });
}

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u;

const originalExitText = (exit: unknown): string => {
  if (typeof exit === "string") return exit;
  if (exit === undefined) return "(missing)";
  return JSON.stringify(exit) ?? "(unserializable)";
};

/** Preserve a reported nonnumeric exit as text while keeping the report readable. */
const normalizeReportCheckExits = (value: unknown): unknown => {
  const report = z.record(z.string(), z.unknown()).safeParse(value);
  if (!report.success || !Array.isArray(report.data.checks)) return value;
  const checks = report.data.checks.map((check: unknown) => {
    const parsed = z.record(z.string(), z.unknown()).safeParse(check);
    if (!parsed.success || typeof parsed.data.exit === "number") return check;
    if (
      parsed.data.exit === "unknown" &&
      typeof parsed.data.exit_text === "string"
    )
      return parsed.data;
    return {
      ...parsed.data,
      exit: "unknown",
      exit_text: originalExitText(parsed.data.exit),
    };
  });
  return { ...report.data, checks };
};

/** Preserve string results and serialize other JSON values without accepting a missing result. */
const normalizeReportCheckResults = (value: unknown): unknown => {
  const report = z.record(z.string(), z.unknown()).safeParse(value);
  if (!report.success || !Array.isArray(report.data.checks)) return value;
  const checks = report.data.checks.map((check: unknown) => {
    const parsed = z.record(z.string(), z.unknown()).safeParse(check);
    if (!parsed.success || typeof parsed.data.result === "string") return check;
    const result = z.json().safeParse(parsed.data.result);
    return result.success
      ? { ...parsed.data, result: JSON.stringify(result.data) }
      : check;
  });
  return { ...report.data, checks };
};

/** The report in a worker's final message (a structured value from the vendor, else its text). */
/** The worker's final message and structured report inside a worker receipt.
 * The codex receipt carries `last_message`; the claude receipt carries the
 * worker's final message in `result`. */
export function receiptReportInput(
  receipt: {
    report?: unknown;
    structured_output?: unknown;
    last_message?: string | undefined;
    result?: string | undefined;
  },
  receiptLine: string,
): { structured: unknown; message: string } {
  return {
    structured: receipt.structured_output ?? receipt.report,
    message: receipt.last_message ?? receipt.result ?? receiptLine,
  };
}

export const EMPTY_FINAL_MESSAGE = "the worker's final message is empty";

export function parseReport(
  structured: unknown,
  lastMessage: string,
): ParsedReport {
  const text = lastMessage.trim();
  if (structured === undefined && text === "")
    return { ok: false, error: EMPTY_FINAL_MESSAGE };
  const candidateText = (FENCE.exec(text)?.[1] ?? text)
    .replace(RETURN_FENCE, "")
    .trim();
  const candidate =
    structured !== undefined
      ? z.unknown().safeParse(structured)
      : jsonText.safeParse(candidateText);
  const parsed = candidate.success
    ? WorkerReport.safeParse(
        normalizeReportCheckResults(normalizeReportCheckExits(candidate.data)),
      )
    : undefined;
  if (parsed?.success === true) return { ok: true, report: parsed.data };
  if (structured === undefined) {
    const valid = jsonObjectSpans(candidateText)
      .flatMap((span) => {
        const decoded = jsonText.safeParse(
          candidateText.slice(span.start, span.end),
        );
        if (!decoded.success) return [];
        const report = WorkerReport.safeParse(
          normalizeReportCheckResults(normalizeReportCheckExits(decoded.data)),
        );
        return report.success ? [{ ...span, report: report.data }] : [];
      })
      .at(-1);
    if (valid !== undefined) {
      const trailing = candidateText.slice(valid.end).trim();
      return {
        ok: true,
        report: valid.report,
        ...(trailing === ""
          ? {}
          : { warnings: [`trailing text after report JSON: ${trailing}`] }),
      };
    }
  }
  if (!candidate.success)
    return {
      ok: false,
      error: (candidate.error.issues[0]?.message ?? "unreadable").replace(
        /^not valid JSON: /u,
        "the final message is not JSON: ",
      ),
    };
  const issues = parsed?.success === false ? parsed.error.issues : [];
  return {
    ok: false,
    error: `the final message is JSON of the wrong shape: ${issues
      .slice(0, 3)
      .map(
        (i) =>
          `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
      )
      .join("; ")}`,
  };
}

const bullets = (items: string[], empty = "(none)"): string =>
  items.length === 0 ? `  ${empty}` : items.map((i) => `  - ${i}`).join("\n");

const renderCheckExit = (check: WorkerReport["checks"][number]): string => {
  if (typeof check.exit === "number") return String(check.exit);
  return check.exit_text === undefined
    ? check.exit
    : `${check.exit} (${check.exit_text})`;
};

/** The worker report as readable sections for callers and run summaries. */
export function renderReport(r: WorkerReport): string {
  return [
    `## Summary\n${r.summary}`,
    `## Changes\n${bullets(r.changes.map((c) => `${c.path}: ${c.what}`))}`,
    `## Checks\n${bullets(r.checks.map((c) => `[exit ${renderCheckExit(c)}] ${c.cmd} — ${c.result}`))}`,
    `## For the coordinator\n${bullets(r.for_coordinator)}`,
    `## Open\n${bullets(r.open)}`,
  ].join("\n\n");
}

/** What the manager observed about a run whose worker left no final message. */
export type ObservedRun = {
  outcome: string;
  timedOut: boolean;
  exit: number;
  changedPaths: string[] | undefined;
  /** the last record of the worker's progress file, parsed (undefined when none was written) */
  progress: Record<string, unknown> | undefined;
  /** the last persisted interim RETURN message, if any */
  interim: string | undefined;
  verify: { cmd: string; exit: number }[];
};

/**
 * A report the manager writes when the worker ended without a final message (timeout, kill, empty
 * output), from what the manager itself observed. `source: "manager"` marks it as not the worker's
 * own report; a worker's own report is never replaced by this. Owner 2026-11-03: coordinators
 * rebuilt timed-out runs by hand from the workspace diff and the progress file.
 */
export function managerReport(
  observed: ObservedRun,
  workerError: string,
): WorkerReport & { source: "manager"; observed: Record<string, unknown> } {
  const paths = observed.changedPaths;
  const progress = observed.progress;
  const last = typeof progress?.last === "string" ? progress.last : undefined;
  const count = (key: string): string =>
    typeof progress?.[key] === "number" ? `${progress[key]} ${key}` : "";
  const countList = ["commands", "turns", "files"]
    .map((key) => count(key))
    .filter((c) => c !== "")
    .join(", ");
  const countSuffix = countList === "" ? "" : ` (${countList})`;
  const how = observed.timedOut
    ? "hit the ticket time box"
    : `ended with exit ${observed.exit}`;
  const stopped =
    progress === undefined
      ? "no progress record was written"
      : `last progress: ${last ?? "(none)"}${countSuffix}`;
  return {
    summary: `[manager-written, not the worker's report] The worker ${how} without a final message (outcome ${observed.outcome}). ${paths === undefined ? "Workspace changes could not be measured" : `${paths.length} changed path(s)`}; ${stopped}.`,
    changes: (paths ?? []).map((path) => ({
      path,
      what: "changed in the workspace (observed by the manager)",
    })),
    checks: observed.verify.map((v) => ({
      cmd: v.cmd,
      exit: v.exit,
      result: "verify result recorded by the manager",
    })),
    for_coordinator: [
      "Review the changed paths and the last progress record before continuing or re-dispatching.",
    ],
    open: [
      "The worker left no final report; everything here is what the manager observed.",
      ...(observed.interim === undefined
        ? []
        : [`Last interim result: ${observed.interim}`]),
    ],
    source: "manager",
    observed: {
      worker_error: workerError,
      timed_out: observed.timedOut,
      exit: observed.exit,
      ...(progress === undefined ? {} : { last_progress: progress }),
      ...(observed.interim === undefined
        ? {}
        : { interim_result: observed.interim }),
    },
  };
}
