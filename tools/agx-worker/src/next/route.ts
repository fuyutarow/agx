import { EffortSchema } from "../ticket.ts";
import { createHash } from "node:crypto";
import { jevEndpoint, postJev } from "../../../shared/src/jev-client.ts";
import {
  exhaustionPolicy,
  loadRoster,
  routeFilterLabel,
  ROUTING_OBJECTIVE,
  type Choice,
  type LoadRosterOptions,
  type RequirementClass,
  REQUIREMENT_BARS,
} from "../roster/index.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { exitWithError } from "./exit.ts";
import {
  claudeCredential,
  creditsMarkerStatus,
} from "../workers/claude-credential.ts";
import { workerEnvironment } from "../workers/environment.ts";
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

export const fitsPublishedTimeBox = (row: Choice, timeoutS: number): boolean =>
  row.aa_time_per_task_s !== undefined &&
  row.aa_time_per_task_s !== null &&
  row.aa_time_per_task_s <= timeoutS * PUBLISHED_TASK_DURATION_BUDGET_RATIO;

const compareNumber = (a: number, b: number): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** Stage 3: filter by requirement, then deterministically rank eligible rows. */
export function orderCandidates(
  rows: readonly Choice[],
  requirement: RequirementClass,
  creditCovered: (row: Choice) => boolean,
): Choice[] {
  const bar = REQUIREMENT_BARS[requirement];
  const qualifying = rows.filter(
    (row) => (row.tb4 ?? (bar === 0 ? 0 : -Infinity)) >= bar,
  );
  const pool = qualifying.length > 0 ? qualifying : rows;
  return pool.toSorted((a, b) => {
    if (qualifying.length === 0) {
      const score = compareNumber(b.tb4 ?? -Infinity, a.tb4 ?? -Infinity);
      if (score !== 0) return score;
    }
    const credit = Number(creditCovered(b)) - Number(creditCovered(a));
    if (credit !== 0) return credit;
    const price = compareNumber(
      (a.price_in ?? Infinity) + (a.price_out ?? Infinity),
      (b.price_in ?? Infinity) + (b.price_out ?? Infinity),
    );
    if (price !== 0) return price;
    const duration = compareNumber(
      a.aa_time_per_task_s ?? Infinity,
      b.aa_time_per_task_s ?? Infinity,
    );
    if (duration !== 0) return duration;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

const Reply = z.looseObject({
  answers: z.record(
    z.string(),
    z.looseObject({
      choice: z.string(),
      confidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  ),
});

const ReturnReason = z.enum(["split", "uncheckable", "contradiction"]);
const RequirementClassSchema = z.enum([
  "mechanical",
  "localized",
  "cross_module",
]);
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
const listOrNone = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");
const oneLine = (text: string): string => text.replaceAll(/[\r\n]+/gu, " ");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type RouteTicket = {
  path: string;
  sha256: string;
  launch?: boolean;
  min_effort?: string | undefined;
} | null;
export type CapacityRetryRouteResult =
  | { kind: "selected"; row: Choice }
  | { kind: "exhausted" }
  | { kind: "refused"; message: string; exitCode: number };
type CapacityRetryRouteOptions = {
  capacityRetry: true;
  timeoutMs: number;
  inspect?: boolean;
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
    source = "refusal",
  ): CapacityRetryRouteResult | never => {
    audit.reason = message;
    audit.outcome_kind = "held";
    if (options?.inspect !== true)
      recordRoutingPick(null, source, audit, "refusal");
    if (options?.capacityRetry === true)
      return { kind: "refused", message, exitCode: code };
    return exitWithError(message, code);
  };
  const floor =
    ticket?.min_effort === undefined
      ? undefined
      : EffortSchema.safeParse(ticket.min_effort);
  if (floor !== undefined && !floor.success)
    return refuse(
      "agx: min_effort must be one of low, medium, high, xhigh, max\n",
      2,
    );
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
  let eligible = filter(roster.choice, "route not allowed", (row) =>
    roster.auto.routes.includes(row.route),
  );
  eligible = filter(eligible, "masked", (row) => !maskedRows.includes(row.id));
  if (floor?.success === true) {
    eligible = filter(
      eligible,
      "ticket min_effort",
      (row) =>
        EffortSchema.options.indexOf(row.effort) >=
        EffortSchema.options.indexOf(floor.data),
      (row) => ({ effort: row.effort, min_effort: floor.data }),
    );
    if (eligible.length === 0)
      return refuse(
        `agx: no roster row satisfies ticket min_effort (${floor.data})\n`,
        2,
      );
  }
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
  // A fresh credits marker means the Claude API credit ran out; under the default policy the
  // Claude subscription (the coordinator's window) is not a substitute, so claude rows leave routing.
  const creditsMarker = creditsMarkerStatus();
  const holdClaude =
    roster.claude_run.on_credits_unavailable === "stop" && creditsMarker.fresh;
  const creditsEligible = filter(
    eligible,
    "claude credits unavailable",
    (row) => !(holdClaude && row.route === "claude"),
    () => ({
      marker: creditsMarker.path,
      expires_at: creditsMarker.expiresAt,
      on_credits_unavailable: roster.claude_run.on_credits_unavailable,
    }),
  );
  const availableCandidates = filter(
    creditsEligible,
    "route unavailable",
    (row) => usage[row.route].available,
    (row) => usage[row.route],
  );
  const candidates = filter(
    availableCandidates,
    "published duration exceeds time box",
    (row) => fitsPublishedTimeBox(row, timeoutS),
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
    return refuse(
      `agx: no roster row satisfies required capabilities (${routeFilterLabel(roster.auto)})${floor?.success === true ? ` and ticket min_effort (${floor.data})` : ""}\n`,
      2,
    );
  if (candidates.length === 0) {
    const allowed = roster.auto.routes;
    const unpublished = availableCandidates
      .filter(
        (row) =>
          row.aa_time_per_task_s === undefined ||
          row.aa_time_per_task_s === null,
      )
      .map((row) => row.id);
    const tooSlow = availableCandidates.flatMap((row) =>
      row.aa_time_per_task_s === undefined || row.aa_time_per_task_s === null
        ? []
        : [`${row.id} (${row.aa_time_per_task_s} s)`],
    );
    return refuse(
      `route refused: no candidate in the ${timeoutS} s time box among allowed routes [${allowed.join(", ")}]; rows without a published duration: ${listOrNone(unpublished)}; rows whose published duration exceeds ${PUBLISHED_TASK_DURATION_BUDGET_RATIO * 100}% of the box: ${listOrNone(tooSlow)}\n`,
      2,
      "refused-no-row-in-time-box",
    );
  }
  const criteria: Record<string, string> = {};
  for (const requirementClass of RequirementClassSchema.options)
    criteria[requirementClass] =
      `Ticket class: ${requirementClass}. Classify only the ticket. mechanical: an edit whose check is already stated. localized: a behavior fix inside one module. cross_module: an invariant, a public API, or behavior across modules must change.`;
  for (const [reason, value] of Object.entries(returns))
    criteria[reason] = value.criterion;
  const truncated = brief.length > roster.auto.max_task_chars;
  const end = truncated
    ? brief.lastIndexOf("\n", roster.auto.max_task_chars - 1) + 1
    : brief.length;
  const task = brief.slice(0, end);
  const request: Record<string, unknown> = {
    state: {
      task,
      task_truncated: truncated,
      task_omitted_chars: brief.length - task.length,
      ...(truncated
        ? {
            task_truncation_notice:
              "The task is truncated; omitted text is not evidence of missing input.",
          }
        : {}),
      published_task_metrics: {},
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
  audit.input_truncated = truncated;
  const post = await postJev(
    endpoint.value,
    request,
    options === undefined
      ? roster.auto.timeout_ms
      : Math.min(roster.auto.timeout_ms, Math.max(1, options.timeoutMs)),
  );
  const usageId =
    options?.inspect === true ? undefined : recordJevUsage(post, roster);
  audit.usage_id = usageId;
  audit.raw_reply = post.ok ? post.text : null;
  audit.jev_model_version = post.ok ? (post.model ?? null) : null;
  audit.request_failure = post.ok ? null : post.reason;
  audit.http_status = post.ok ? post.status : null;
  let rawAnswer: unknown = null;
  const pickAudit = (
    source: string,
    probabilities: Record<string, number> | undefined,
  ) => ({
    audit,
    source,
    probabilities: probabilities ?? null,
    answer: rawAnswer,
    usage_snapshot: usage,
    usage_id: usageId,
  });
  const recordPick = (
    row: Choice,
    source: string,
    probabilities: Record<string, number> | undefined,
  ): Choice => {
    audit.selected_row = row.id;
    audit.answer = rawAnswer;
    audit.selection_mode = "class";
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
    if (options?.inspect !== true)
      recordRoutingPick(row, source, audit, "selected");
    if (options?.inspect !== true)
      setPendingPickAudit({
        ...pickAudit(source, probabilities),
        audit,
        chosen_row: row.id,
      });
    return row;
  };
  const routeChoice = (row: Choice): Choice | CapacityRetryRouteResult =>
    options?.capacityRetry === true ? { kind: "selected", row } : row;
  const refuseReply = (
    message: string,
    source: string,
    probabilities?: Record<string, number>,
  ) => {
    audit.selection_mode = "refusal";
    audit.answer = rawAnswer;
    audit.choice_probabilities = probabilities ?? null;
    const reply = post.ok ? post.text : null;
    const bounded = reply === null ? "unavailable" : reply.slice(0, 8192);
    const replyTruncated =
      reply !== null && reply.length > 8192 ? " [truncated]" : "";
    return refuse(
      `${message.trimEnd()}; Jev reply: ${JSON.stringify(bounded)}${replyTruncated}\n`,
      2,
      source,
    );
  };
  if (!post.ok)
    return refuseReply(
      `route refused: Jev request failed: ${oneLine(post.reason)}; no row is substituted\n`,
      "refused-request-failed",
    );
  const decoded = jsonOf(Reply).safeParse(post.text);
  if (post.status !== 200)
    return refuseReply(
      `route refused: Jev answered HTTP ${post.status}; no row is substituted\n`,
      `refused-http-${post.status}`,
    );
  if (!decoded.success)
    return refuseReply(
      `route refused: Jev reply is not a valid answer: ${oneLine(decoded.error.message)}; no row is substituted\n`,
      "refused-invalid-response",
    );
  const answer = decoded.data.answers.worker;
  rawAnswer = answer ?? null;
  const selected = answer?.choice;
  const probabilities = answer?.probabilities;
  const reason = ReturnReason.safeParse(selected);
  if (reason.success) {
    audit.outcome_kind = "held";
    audit.selection_mode = "return";
    audit.answer = rawAnswer;
    audit.choice_probabilities = probabilities ?? null;
    if (options?.inspect !== true)
      recordRoutingPick(null, "jev-return", audit, "refusal");
    if (options?.inspect !== true)
      recordRoutingRefusal({
        ticket: brief,
        reason: reason.data,
        ...(probabilities?.[reason.data] === undefined
          ? {}
          : { probability: probabilities[reason.data] }),
        pick_audit: pickAudit("jev-return", probabilities),
      });
    return refuseReply(
      `agx: ticket returned: ${reason.data}: ${returns[reason.data].criterion} ${returns[reason.data].fix} Probability: ${probabilities?.[reason.data] ?? "unavailable"}; ticket fields sent: task${capabilities.length === 0 ? "" : ", required_capabilities"}, task_size; no row is substituted\n`,
      "jev-return",
      probabilities,
    );
  }
  if (answer === undefined)
    return refuseReply(
      'route refused: Jev reply has no answer for question "worker"; no row is substituted\n',
      "refused-missing-answer",
    );
  const parsedRequirementClass = RequirementClassSchema.safeParse(selected);
  if (!parsedRequirementClass.success)
    return refuseReply(
      `route refused: Jev choice ${JSON.stringify(selected)} is neither a requirement class (${RequirementClassSchema.options.join(", ")}) nor a return reason; no row is substituted\n`,
      "refused-invalid-class",
      probabilities,
    );
  const requirementClass = parsedRequirementClass.data;
  const bar = REQUIREMENT_BARS[requirementClass];
  const qualifying = candidates.filter(
    (row) => (row.tb4 ?? (bar === 0 ? 0 : Number.NEGATIVE_INFINITY)) >= bar,
  );
  const creditAvailable =
    claudeCredential(workerEnvironment(process.env)) === "api_key";
  const covered = (row: Choice) => row.route === "claude" && creditAvailable;
  const ordered = orderCandidates(candidates, requirementClass, covered);
  audit.credit_covered = ordered.some((row) => covered(row));
  audit.ordered_candidate_ids = ordered.map((row) => row.id);
  const chosen = ordered[0];
  if (chosen === undefined)
    return refuseReply(
      "route refused: no candidate remained after the requirement bar; no row is substituted\n",
      "refused-no-candidate",
    );
  audit.requirement_class = requirementClass;
  audit.tb4_bar = bar;
  audit.qualifying_rows = qualifying.map((row) => row.id);
  audit.bar_unmet = qualifying.length === 0;
  audit.choice_probabilities = probabilities ?? null;
  return routeChoice(recordPick(chosen, "jev-classified", probabilities));
}
