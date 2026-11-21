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
  REQUIREMENT_CLASSES,
} from "../roster/index.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { exitWithError } from "./exit.ts";
import {
  claudeCredentialDetails,
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

const apiCovered = (row: Choice) => row.route === "claude-api";

const compareNumber = (a: number, b: number): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * Below this gap between the two most probable answers, routing says the class was a close call.
 * One measurement set it: docs/class-criteria-rejudge-2026-11.md.
 */
const CLOSE_CLASS_MARGIN = 0.15;

/** The two most probable answers and the gap between them, when Jev returned at least two. */
function classMargin(
  probabilities: Record<string, number> | undefined,
): { first: string; second: string; margin: number } | undefined {
  const [first, second] = Object.entries(probabilities ?? {}).toSorted(
    (a, b) => b[1] - a[1],
  );
  return first === undefined || second === undefined
    ? undefined
    : { first: first[0], second: second[0], margin: first[1] - second[1] };
}

/** The probabilities of the three work classes only, without the returns. */
function classProbabilities(
  probabilities: Record<string, number> | undefined,
): Record<string, number> {
  return Object.fromEntries(
    REQUIREMENT_CLASSES.flatMap((name) => {
      const probability = probabilities?.[name];
      return probability === undefined ? [] : [[name, probability]];
    }),
  );
}

/** A row without a published TB4 score passes only the zero bar. */
const meetsBar = (row: Choice, bar: number): boolean =>
  (row.tb4 ?? (bar === 0 ? 0 : Number.NEGATIVE_INFINITY)) >= bar;

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
const RequirementClassSchema = z.enum(REQUIREMENT_CLASSES);
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
  /** The ticket's floor on the requirement class; Jev's class is raised to it, never lowered. */
  min_class?: string | undefined;
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

/** Each class states only its own condition; the three are mutually exclusive. */
const CLASS_CRITERIA: Readonly<Record<RequirementClass, string>> = {
  mechanical:
    "Classify only the ticket: choose mechanical only when the edit and the check that proves it are both already stated in the ticket.",
  localized:
    "Choose localized only when a behavior change is needed, its writes stay inside one module, and the edit and its check are not both already stated.",
  cross_module:
    "Choose cross_module only when an invariant, a public API, or behavior spanning modules must change.",
};

/**
 * The only builder of the task text Jev reads, for every route call (check, dispatch,
 * continuation, capacity reroute, public roster). Proposition and prose come first, then the
 * ticket's outcome, writes, verify and proposition refuted_by under plain labels.
 */
export function routingBrief(
  ticket: Readonly<{
    outcome: string;
    writes: readonly string[];
    verify: readonly string[];
    proposition: Readonly<{ id: string; claim: string; refuted_by: string }>;
  }>,
  prose: string,
): string {
  return [
    `Proposition ${ticket.proposition.id}: ${ticket.proposition.claim}`,
    prose.trimEnd(),
    `outcome: ${ticket.outcome}`,
    `writes: ${JSON.stringify(ticket.writes)}`,
    `verify: ${JSON.stringify(ticket.verify)}`,
    `refuted_by: ${ticket.proposition.refuted_by}`,
  ].join("\n");
}

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
  const classFloor =
    ticket?.min_class === undefined
      ? undefined
      : RequirementClassSchema.safeParse(ticket.min_class);
  if (classFloor !== undefined && !classFloor.success)
    return refuse(
      `agx: min_class must be one of ${REQUIREMENT_CLASSES.join(", ")}\n`,
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
  eligible = filter(
    eligible,
    "masked",
    (row) =>
      !maskedRows.includes(row.id) &&
      !maskedRows.includes(`${row.route}:${row.id}`),
  );
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
  const creditsMarker = creditsMarkerStatus();
  const apiAllowed = roster.auto.routes.includes("claude-api");
  const apiKey =
    apiAllowed &&
    !creditsMarker.fresh &&
    claudeCredentialDetails(workerEnvironment(process.env)).credential ===
      "api_key";
  const creditsEligible = filter(
    eligible,
    "claude-api credits unavailable",
    (row) => row.route !== "claude-api" || !creditsMarker.fresh,
    () => ({ marker: creditsMarker.path, expires_at: creditsMarker.expiresAt }),
  );
  const keyEligible = filter(
    creditsEligible,
    "claude-api key unavailable",
    (row) => row.route !== "claude-api" || apiKey,
  );
  const availableCandidates = filter(
    keyEligible,
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
    criteria[requirementClass] = CLASS_CRITERIA[requirementClass];
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
    // A missing credential ends the one-line refusal with the command that stores it.
    const recover =
      post.ok || post.recover === undefined ? "" : `; recover: ${post.recover}`;
    return refuse(
      `${message.trimEnd()}; Jev reply: ${JSON.stringify(bounded)}${replyTruncated}${recover}\n`,
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
  // A return stops the worker, so it needs a clear lead. One that leads the runner-up by less
  // than the close-call margin is set aside, and the most probable work class is used instead.
  const lead = classMargin(probabilities);
  const likeliestClass = Object.entries(classProbabilities(probabilities))
    .toSorted((a, b) => b[1] - a[1])
    .at(0)?.[0];
  const setAside =
    reason.success &&
    lead?.first === reason.data &&
    lead.margin < CLOSE_CLASS_MARGIN &&
    likeliestClass !== undefined
      ? { reason: reason.data, margin: lead.margin, class: likeliestClass }
      : undefined;
  audit.set_aside_return = setAside?.reason ?? null;
  audit.set_aside_margin = setAside?.margin ?? null;
  if (setAside !== undefined)
    process.stderr.write(
      `agx: return ${setAside.reason} set aside: it leads by ${setAside.margin.toFixed(2)} (below ${CLOSE_CLASS_MARGIN}); routing as ${setAside.class}. Review the ticket: ${returns[setAside.reason].fix}\n`,
    );
  if (reason.success && setAside === undefined) {
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
      `agx: ticket returned: ${reason.data}: ${returns[reason.data].criterion} ${returns[reason.data].fix} Probability: ${probabilities?.[reason.data] ?? "unavailable"}; ticket fields sent: task (proposition id and claim, prose, outcome, writes, verify, refuted_by)${capabilities.length === 0 ? "" : ", required_capabilities"}; no row is substituted\n`,
      "jev-return",
      probabilities,
    );
  }
  if (answer === undefined)
    return refuseReply(
      'route refused: Jev reply has no answer for question "worker"; no row is substituted\n',
      "refused-missing-answer",
    );
  const parsedRequirementClass = RequirementClassSchema.safeParse(
    setAside?.class ?? selected,
  );
  if (!parsedRequirementClass.success)
    return refuseReply(
      `route refused: Jev choice ${JSON.stringify(selected)} is neither a requirement class (${RequirementClassSchema.options.join(", ")}) nor a return reason; no row is substituted\n`,
      "refused-invalid-class",
      probabilities,
    );
  const jevClass = parsedRequirementClass.data;
  const minClass = classFloor?.data;
  // The declared floor only raises: a class Jev judged higher stands.
  const requirementClass =
    minClass !== undefined &&
    REQUIREMENT_BARS[minClass] > REQUIREMENT_BARS[jevClass]
      ? minClass
      : jevClass;
  audit.jev_requirement_class = jevClass;
  audit.min_class = minClass ?? null;
  audit.requirement_class = requirementClass;
  // After a return is set aside, the close call is measured among the work classes alone.
  const close = classMargin(
    setAside === undefined ? probabilities : classProbabilities(probabilities),
  );
  audit.class_margin = close?.margin ?? null;
  // A close call changes no row: the writer is told how to declare a floor, and decides.
  if (
    minClass === undefined &&
    close !== undefined &&
    close.margin < CLOSE_CLASS_MARGIN
  )
    process.stderr.write(
      `agx: requirement class is a close call: ${close.first} over ${close.second} by ${close.margin.toFixed(2)} (below ${CLOSE_CLASS_MARGIN}); if the work needs a floor, set min_class in the ticket (${REQUIREMENT_CLASSES.join(" | ")})\n`,
    );
  const bar = REQUIREMENT_BARS[requirementClass];
  audit.tb4_bar = bar;
  const qualifying = candidates.filter((row) => meetsBar(row, bar));
  if (minClass !== undefined) {
    process.stderr.write(
      `agx: requirement class jev=${jevClass} min_class=${minClass} adopted=${requirementClass}\n`,
    );
    // The fallback below ranks every row by TB4; under a declared floor that could start a row
    // the ticket ruled out, so the run is refused instead.
    const floorBar = REQUIREMENT_BARS[minClass];
    if (!candidates.some((row) => meetsBar(row, floorBar))) {
      audit.qualifying_rows = [];
      audit.bar_unmet = true;
      return refuseReply(
        `route refused: no roster row meets ticket min_class ${minClass} (TB4 bar ${floorBar}); candidates: ${listOrNone(candidates.map((row) => `${row.id} tb4=${row.tb4 ?? "none"}`))}; no lower row is substituted\n`,
        "refused-min-class-unmet",
        probabilities,
      );
    }
  }

  const ordered = orderCandidates(candidates, requirementClass, apiCovered);
  audit.credit_covered = ordered.some((row) => apiCovered(row));
  audit.ordered_candidate_ids = ordered.map((row) => row.id);
  const chosen = ordered[0];
  if (chosen === undefined)
    return refuseReply(
      "route refused: no candidate remained after the requirement bar; no row is substituted\n",
      "refused-no-candidate",
    );
  audit.qualifying_rows = qualifying.map((row) => row.id);
  audit.bar_unmet = qualifying.length === 0;
  audit.choice_probabilities = probabilities ?? null;
  return routeChoice(recordPick(chosen, "jev-classified", probabilities));
}
