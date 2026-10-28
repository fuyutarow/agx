import { createHash } from "node:crypto";
import { jevEndpoint, postJev } from "../../../shared/src/jev-client.ts";
import {
  exhaustionPolicy,
  loadRoster,
  routeFilterLabel,
  ROUTING_OBJECTIVE,
  type Choice,
  type LoadRosterOptions,
  REQUIREMENT_BARS,
} from "../roster/index.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { exitWithError } from "./exit.ts";
import { readRouteUsage } from "./usage.ts";
import { setPendingPickAudit } from "./store.ts";
import { recordJevUsage } from "./jev-usage.ts";
import {
  newRoutingAudit,
  recordRoutingPick,
  recordRoutingRefusal,
} from "./routing-events.ts";

// AA publishes mean decode times: luna-max averages 597s in a 600s box,
// and the owner's incident had all 101 timeouts on luna-max. Reserve margin
// for task variation and overhead instead of admitting a mean near the deadline.
const PUBLISHED_TASK_DURATION_BUDGET_RATIO = 0.6;

const comparePriceThenDuration = (a: Choice, b: Choice): number => {
  const aPrice = (a.price_in ?? Infinity) + (a.price_out ?? Infinity);
  const bPrice = (b.price_in ?? Infinity) + (b.price_out ?? Infinity);
  const priceDifference = aPrice - bPrice;
  if (priceDifference !== 0) return priceDifference;
  return (a.aa_time_per_task_s ?? Infinity) - (b.aa_time_per_task_s ?? Infinity);
};

const compareTb4Descending = (a: Choice, b: Choice): number =>
  (b.tb4 ?? Number.NEGATIVE_INFINITY) - (a.tb4 ?? Number.NEGATIVE_INFINITY);

const Reply = z.looseObject({
  answers: z.record(
    z.string(),
    z.looseObject({
      choice: z.string(),
      reason_code: z.string().optional(),
      confidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  ),
});

const ReturnReason = z.enum([
  "split",
  "uncheckable",
  "contradiction",
  "missing_input",
]);
const RequirementClassSchema = z.enum(["mechanical", "localized", "cross_module"]);
const returns = {
  split: {
    criterion:
      "The ticket states independent outcomes that require separate workers or disjoint write scopes. Do not use for dependent steps toward one outcome.",
    fix: "Split the ticket into one independently verifiable outcome per ticket.",
  },
  uncheckable: {
    criterion:
      "The ticket supplies no observable acceptance or refutation condition for its outcome. Do not use merely because verification is difficult.",
    fix: "Supply an observable acceptance or refutation condition.",
  },
  contradiction: {
    criterion:
      "Two explicit requirements cannot both be satisfied. Do not use for ambiguity or a difficult trade-off.",
    fix: "Resolve the conflicting requirements in the ticket.",
  },
  missing_input: {
    criterion:
      "A required input, access, or decision is absent and cannot be obtained within the authorized scope. Do not use when the worker can retrieve it within scope.",
    fix: "Provide the missing input, access, or decision, or authorize its retrieval.",
  },
};

const escape = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const neutralSettings: Record<string, string> = {
  low: "lowest",
  medium: "moderate",
  high: "intensive",
  xhigh: "very intensive",
  max: "maximum",
};

/** Blind identities with neutral prose; measured numbers and prices remain intact. */
export function blindCriterion(text: string, rows: readonly Choice[]): string {
  let result = text;
  // Handle grammatical compounds before replacing individual identity words.
  result = result
    .replaceAll(/\blow-cost\b/giu, "inexpensive")
    .replaceAll(
      /\bhigh-capability low-effort work\b/giu,
      "capable work at a modest setting",
    )
    .replaceAll(
      /\bhigh-capability low-effort reasoning\b/giu,
      "capable reasoning at a modest setting",
    )
    .replaceAll(
      /\bstrong low-effort coding or reasoning\b/giu,
      "strong coding or reasoning at a modest setting",
    )
    .replaceAll(
      /\bdeepest (?:luna|terra|sol|astra) reasoning\b/giu,
      "deepest reasoning from another model",
    )
    .replaceAll(
      /\bstrongest (?:luna|terra|sol|astra) effort\b/giu,
      "strongest setting of another model",
    )
    .replaceAll(
      /\blow-effort (reasoning|design judgment)\b/giu,
      "$1 at a modest setting",
    )
    .replaceAll(
      /\bat high reasoning effort\b/giu,
      "at an intensive reasoning setting",
    )
    .replaceAll(/\blower-effort\b/giu, "less intensive");
  for (const row of rows) {
    result = result.replaceAll(
      new RegExp(escape(row.id), "giu"),
      "another model",
    );
    result = result.replaceAll(
      new RegExp(escape(row.model), "giu"),
      "another model",
    );
  }
  const families = [
    ...new Set(
      rows.flatMap((row) => {
        const family = row.id.split("-")[0];
        return family === undefined ? [] : [family];
      }),
    ),
  ];
  for (const family of families) {
    const name = `\\b${escape(family)}(?:\\s+\\d+(?:[.-]\\d+)*)?\\b`;
    result = result
      .replaceAll(
        new RegExp(`${name} (low|medium|high|xhigh|max)\\b`, "giu"),
        (_match, setting: string) =>
          `another model at its ${neutralSettings[setting.toLowerCase()] ?? "different"} setting`,
      )
      .replaceAll(
        new RegExp(`\\b(deepest|maximum|strongest) ${name}`, "giu"),
        "$1 model",
      )
      .replaceAll(
        new RegExp(`\\bdeep ${name} reasoning`, "giu"),
        "deep model reasoning",
      )
      .replaceAll(
        new RegExp(`\\bmost demanding ${name} tasks`, "giu"),
        "most demanding tasks for another model",
      )
      .replaceAll(new RegExp(name, "giu"), "another model");
  }
  return result
    .replaceAll(
      "less intensive another model",
      "another model at a less intensive setting",
    )
    .replaceAll(/\blow-effort\b/giu, "modest-setting")
    .replaceAll(/\bhigh-difficulty\b/giu, "difficult")
    .replaceAll(/\blow\b/giu, "modest")
    .replaceAll(/\bmedium\b/giu, "moderate")
    .replaceAll(/\bhigh\b/giu, "intensive")
    .replaceAll(/\bxhigh\b/giu, "very intensive")
    .replaceAll(/\bmax\b/giu, "maximum")
    .replaceAll(/\beffort\b/giu, "setting")
    .replaceAll(
      /(?:^|\s)-cost\b/giu,
      (match) => `${match.startsWith(" ") ? " " : ""}inexpensive`,
    )
    .replaceAll(/\s-\s/gu, " ")
    .replaceAll(/\b(when|where|than|for)\s+'s\b/giu, "$1 another model's")
    .replace(
      /^(Route [^.]+\. )([a-z])/u,
      (_match, prefix: string, first: string) =>
        `${prefix}${first.toUpperCase()}`,
    );
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type RouteTicket = { path: string; sha256: string; launch?: boolean } | null;
export type CapacityRetryRouteResult =
  | { kind: "selected"; row: Choice }
  | { kind: "exhausted" }
  | { kind: "refused"; message: string; exitCode: number };
type CapacityRetryRouteOptions = {
  capacityRetry: true;
  timeoutMs: number;
};

export function route(
  brief: string,
  capabilities?: readonly string[],
  timeoutS?: number,
  maskedRows?: readonly string[],
  rosterOptions?: LoadRosterOptions,
  ticket?: RouteTicket,
): Promise<Choice>;
export function route(
  brief: string,
  capabilities: readonly string[],
  timeoutS: number,
  maskedRows: readonly string[],
  rosterOptions: LoadRosterOptions,
  ticket: RouteTicket,
  options: CapacityRetryRouteOptions,
): Promise<CapacityRetryRouteResult>;
export async function route(
  brief: string,
  capabilities: readonly string[] = [],
  timeoutS = 600,
  maskedRows: readonly string[] = [],
  rosterOptions: LoadRosterOptions = {},
  ticket: RouteTicket = null,
  options?: CapacityRetryRouteOptions,
): Promise<Choice | CapacityRetryRouteResult> {
  const audit = newRoutingAudit(ticket, capabilities, timeoutS);
  const refuse = (
    message: string,
    code: number,
  ): CapacityRetryRouteResult | never => {
    audit.reason = message;
    audit.outcome_kind = "held";
    recordRoutingPick(null, "refusal", audit, "refusal");
    if (options?.capacityRetry === true)
      return { kind: "refused", message, exitCode: code };
    return exitWithError(message, code);
  };
  const loaded = await loadRoster(rosterOptions);
  if (!loaded.ok)
    return refuse(`agx: cannot read dispatch roster: ${loaded.error}\n`, 1);
  const roster = loaded.value;
  audit.policy_version = loaded.provenance.policy_version;
  audit.catalog_version = loaded.provenance.catalog_version;
  audit.pick_temperature = roster.auto.pick_temperature;
  const endpoint = jevEndpoint(roster.auto.jev.url);
  if (!endpoint.ok) return refuse(`agx: ${endpoint.error}\n`, 2);
  let timeoutClass = "standard";
  if (timeoutS > 600) timeoutClass = "extended";
  if (timeoutS >= 3600) timeoutClass = "multi-hour";
  audit.timeout_class = timeoutClass;
  const filters: {
    reason: string;
    before: string[];
    after: string[];
    removed: unknown[];
  }[] = [];
  const filter = (
    rows: Choice[],
    reason: string,
    keep: (row: Choice) => boolean,
    detail: (row: Choice) => unknown = () => null,
  ) => {
    const after = rows.filter((row) => keep(row));
    filters.push({
      reason,
      before: rows.map((row) => row.id),
      after: after.map((row) => row.id),
      removed: rows
        .filter((row) => !after.includes(row))
        .map((row) => ({ row: row.id, detail: detail(row) })),
    });
    return after;
  };
  filters.push({
    reason: "policy excluded",
    before: loaded.provenance.before,
    after: roster.choice.map((row) => row.id),
    removed: loaded.provenance.excluded.map((row) => ({
      row,
      detail: "policy.route.exclude",
    })),
  });
  audit.filters = filters;
  let eligible = filter(
    roster.choice,
    "route not allowed",
    (row) =>
      roster.auto.routes === undefined ||
      roster.auto.routes.includes(row.route),
  );
  eligible = filter(eligible, "masked", (row) => !maskedRows.includes(row.id));
  const beforeSort = eligible.map((row) => row.id);
  eligible = eligible.toSorted(
    (a, b) =>
      ["low", "medium", "high", "xhigh", "max"].indexOf(a.effort) -
      ["low", "medium", "high", "xhigh", "max"].indexOf(b.effort),
  );
  filters.push({
    reason: "effort order",
    before: beforeSort,
    after: eligible.map((row) => row.id),
    removed: [],
  });
  const usage = await readRouteUsage(undefined, exhaustionPolicy(roster.auto));
  const availableCandidates = filter(
    eligible,
    "route unavailable",
    (row) => usage[row.route].available,
    (row) => usage[row.route],
  );
  const durationBudgetS = timeoutS * PUBLISHED_TASK_DURATION_BUDGET_RATIO;
  let candidates = filter(
    availableCandidates,
    "published duration exceeds time box",
    (row) => row.aa_time_per_task_s !== undefined && row.aa_time_per_task_s <= durationBudgetS,
    (row) => ({
      aa_time_per_task_s: row.aa_time_per_task_s,
      timeout_s: timeoutS,
    }),
  );
  audit.filters = filters;
  audit.usage_snapshot = usage;
  if (candidates.length === 0 && eligible.length === 0 && options !== undefined)
    return { kind: "exhausted" };
  if (availableCandidates.length === 0)
    return refuse(`agx: no roster row satisfies required capabilities (${routeFilterLabel(roster.auto)})\n`, 2);
  const anonymizationMap: Record<string, string> = {};
  const measuredEvidence: Record<string, {
    judged_runs: number;
    accepted_runs: number;
    accepted_percent: number | null;
    ended_runs: number;
    median_wall_minutes: number | null;
    text: string;
  }> = {};
  const criteria: Record<string, string> = {};
  for (const requirementClass of RequirementClassSchema.options)
    criteria[requirementClass] = `Ticket class: ${requirementClass}. Classify only the ticket. mechanical: an edit whose check is already stated. localized: a behavior fix inside one module. cross_module: an invariant, a public API, or behavior across modules must change.`;
  for (const [reason, value] of Object.entries(returns))
    criteria[reason] = value.criterion;
  const request: Record<string, unknown> = {
    state: {
      task: brief.slice(0, Math.min(roster.auto.max_task_chars, 2400)),
      published_task_metrics: {},
      routes: Object.fromEntries(
        Object.entries(usage).map(([name, value]) => [
          name,
          {
            available: value.available,
            windows: Object.fromEntries(
              Object.entries(value.windows).map(([windowName, window]) => [
                windowName,
                {
                  used_percent: window.used_percent,
                  elapsed_fraction: window.elapsed_fraction,
                  pace: window.pace,
                  status: window.status,
                },
              ]),
            ),
          },
        ]),
      ),
      task_size: {
        timeout_s: timeoutS,
        class: timeoutClass,
      },
      ...(capabilities.length === 0
        ? {}
        : {
            required_capabilities: capabilities.map((tag) =>
              blindCriterion(tag, loaded.catalogRows),
            ),
          }),
    },
    questions: {
      worker: {
        type: "choice",
        instructions: ROUTING_OBJECTIVE,
        criteria,
      },
    },
  };
  if (roster.auto.jev.api === "typesafe") request.model = roster.auto.jev.model;
  audit.input = request;
  audit.input_sha256 = hash(request);
  audit.input_truncated =
    brief.length > Math.min(roster.auto.max_task_chars, 2400);
  const post = await postJev(
    endpoint.value,
    request,
    options === undefined
      ? roster.auto.timeout_ms
      : Math.min(roster.auto.timeout_ms, Math.max(1, options.timeoutMs)),
  );
  const usageId = recordJevUsage(post, roster);
  audit.usage_id = usageId;
  audit.raw_reply = post.ok ? post.text : null;
  audit.jev_model_version = post.ok ? (post.model ?? null) : null;
  audit.request_failure = post.ok ? null : post.reason;
  audit.http_status = post.ok ? post.status : null;
  const fallback = availableCandidates.find((row) => row.id === roster.default) ?? availableCandidates[0];
  if (fallback === undefined) return refuse("no routing candidates", 2);
  let rawAnswer: unknown = null;
  const pickAudit = (
    source: string,
    probabilities: Record<string, number> | undefined,
  ) => ({
    audit,
    source,
    probabilities: probabilities ?? null,
    answer: rawAnswer,
    anonymization_map: anonymizationMap,
    usage_snapshot: usage,
    usage_id: usageId,
    measured_evidence: measuredEvidence,
  });
  let selectionMode = "fallback";
  const recordPick = (
    row: Choice,
    source: string,
    probabilities: Record<string, number> | undefined,
  ): Choice => {
    audit.selected_row = row.id;
    audit.anonymization_map = anonymizationMap;
    audit.measured_evidence = measuredEvidence;
    audit.answer = rawAnswer;
    audit.selection_mode = selectionMode;
    audit.choice_probabilities = probabilities ?? null;
    const ranked = Object.values(probabilities ?? {}).toSorted((a, b) => b - a);
    audit.top_margin =
      ranked.length >= 2 &&
      Object.values(probabilities ?? {}).every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )
        ? (ranked[0] ?? 0) - (ranked[1] ?? 0)
        : null;
    audit.outcome_kind = "selected";
    if (selectionMode === "fallback") audit.outcome_kind = "fallback";
    if (
      source.includes("invalid") ||
      source.includes("ineligible") ||
      source.includes("missing-answer")
    )
      audit.outcome_kind = "invalid reply";
    recordRoutingPick(
      row,
      source,
      audit,
      selectionMode === "fallback" ? "fallback" : "selected",
    );
    setPendingPickAudit({
      ...pickAudit(source, probabilities),
      audit,
      chosen_row: row.id,
    });
    return row;
  };
  const routeChoice = (row: Choice): Choice | CapacityRetryRouteResult =>
    options?.capacityRetry === true ? { kind: "selected", row } : row;
  if (!post.ok)
    return routeChoice(
      recordPick(fallback, "fallback-request-failed", undefined),
    );
  const decoded = jsonOf(Reply).safeParse(post.text);
  if (post.status !== 200)
    return routeChoice(
      recordPick(fallback, `fallback-http-${post.status}`, undefined),
    );
  if (!decoded.success)
    return routeChoice(
      recordPick(fallback, "fallback-invalid-response", undefined),
    );
  const answer = decoded.data.answers.worker;
  rawAnswer = answer ?? null;
  const selected = answer?.choice;
  const probabilities = answer?.probabilities;
  const reason = ReturnReason.safeParse(selected);
  if (reason.success) {
    audit.outcome_kind = "held";
    audit.selection_mode = "return";
    audit.anonymization_map = anonymizationMap;
    audit.measured_evidence = measuredEvidence;
    audit.answer = rawAnswer;
    audit.choice_probabilities = probabilities ?? null;
    recordRoutingPick(null, "jev-return", audit, "refusal");
    recordRoutingRefusal({
      ticket: brief,
      reason: reason.data,
      ...(answer?.reason_code === undefined
        ? {}
        : { reason_detail: answer.reason_code }),
      ...(probabilities?.[reason.data] === undefined
        ? {}
        : { probability: probabilities[reason.data] }),
      pick_audit: pickAudit("jev-return", probabilities),
    });
    const detail = answer?.reason_code;
    return refuse(
      detail === undefined
        ? `agx: ticket returned: ${reason.data}: ${returns[reason.data].criterion} Fix: ${returns[reason.data].fix}\n`
        : `agx: ticket returned: ${reason.data}: ${detail}\n`,
      2,
    );
  }
  if (answer === undefined)
    return routeChoice(recordPick(fallback, "fallback-missing-answer", probabilities));
  const parsedRequirementClass = RequirementClassSchema.safeParse(selected);
  if (!parsedRequirementClass.success)
    return routeChoice(recordPick(fallback, "fallback-invalid-class", probabilities));
  const requirementClass = parsedRequirementClass.data;
  const bar = REQUIREMENT_BARS[requirementClass];
  const inTimeBox = availableCandidates.filter((row) => row.aa_time_per_task_s !== undefined && row.aa_time_per_task_s <= durationBudgetS);
  if (inTimeBox.length === 0)
    return routeChoice(recordPick(fallback, "fallback-no-row-in-time-box", probabilities));
  const qualifying = inTimeBox.filter((row) => (row.tb4 ?? (bar === 0 ? 0 : Number.NEGATIVE_INFINITY)) >= bar);
  const pool = qualifying.length > 0 ? qualifying : inTimeBox;
  const ordered = qualifying.length > 0
    ? pool.toSorted(comparePriceThenDuration)
    : pool.toSorted(compareTb4Descending);
  const chosen = ordered[0] ?? fallback;
  audit.requirement_class = requirementClass;
  audit.tb4_bar = bar;
  audit.qualifying_rows = qualifying.map((row) => row.id);
  audit.bar_unmet = qualifying.length === 0;
  audit.choice_probabilities = probabilities ?? null;
  selectionMode = "class";
  return routeChoice(recordPick(chosen, "jev-classified", probabilities));
}
