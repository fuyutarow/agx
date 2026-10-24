import { fromThrowable } from "neverthrow";
import { randomUUID } from "node:crypto";
import { jevEndpoint, postJev } from "../../../shared/src/jev-client.ts";
import { sampleRow } from "../selection.ts";
import {
  exhaustionPolicy,
  loadRoster,
  routeFilterLabel,
  ROUTING_OBJECTIVE,
  type Choice,
  criterionFor,
  type LoadRosterOptions,
} from "../roster/index.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { exitWithError } from "./exit.ts";
import { readRouteUsage } from "./usage.ts";
import { foldedRuns, setPendingPickAudit } from "./store.ts";
import { CAPACITY_COOLDOWN_MS, capacityRows } from "./capacity.ts";
import { recordJevUsage } from "./jev-usage.ts";
import { recordRoutingPick, recordRoutingRefusal } from "./routing-events.ts";

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
  const families = [...new Set(rows.map((row) => row.id.split("-")[0]!))];
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

export async function route(
  brief: string,
  capabilities: readonly string[] = [],
  timeoutS = 600,
  maskedRows: readonly string[] = [],
  rosterOptions: LoadRosterOptions = {},
): Promise<Choice> {
  const loaded = await loadRoster(rosterOptions);
  if (!loaded.ok)
    return exitWithError(
      `agx: cannot read dispatch roster: ${loaded.error}\n`,
      1,
    );
  const roster = loaded.value;
  const runs = await foldedRuns();
  const cooling = capacityRows(runs, roster.choice);
  const coolingNote =
    cooling.size === 0
      ? ""
      : `; capacity rows cooling down for up to ${CAPACITY_COOLDOWN_MS / 1000} s`;
  const endpoint = jevEndpoint(roster.auto.jev.url);
  if (!endpoint.ok) return exitWithError(`agx: ${endpoint.error}\n`, 2);
  let timeoutClass = "standard";
  if (timeoutS > 600) timeoutClass = "extended";
  if (timeoutS >= 3600) timeoutClass = "multi-hour";
  const minimumTb4 = capabilities.some((tag) =>
    ["terminal-agentic", "long-tool-loop"].includes(tag),
  )
    ? 30
    : undefined;
  const eligible = roster.choice
    .filter(
      (row) =>
        (roster.auto.routes === undefined ||
          roster.auto.routes.includes(row.route)) &&
        !maskedRows.includes(row.id) &&
        !cooling.has(row.id) &&
        (minimumTb4 === undefined || (row.tb4 ?? 0) >= minimumTb4),
    )
    .toSorted(
      (a, b) =>
        ["low", "medium", "high", "xhigh", "max"].indexOf(a.effort) -
        ["low", "medium", "high", "xhigh", "max"].indexOf(b.effort),
    );
  const usage = await readRouteUsage(undefined, exhaustionPolicy(roster.auto));
  const candidates = eligible.filter((row) => usage[row.route].available);
  if (candidates.length === 0)
    return exitWithError(
      eligible.length === 0
        ? `agx: no roster row satisfies required capabilities (${routeFilterLabel(roster.auto)})${coolingNote}\n`
        : "agx: all capability-eligible routes are at their subscription limit\n",
      2,
    );
  const anonymizationMap = Object.fromEntries(
    candidates.map((row, index) => [`model_${index}`, row.id]),
  );
  const measuredEvidence = Object.fromEntries(
    candidates.map((row, index) => {
      const history = runs.filter((run) => run.row === row.id);
      const judged = history.filter((run) => run.judgment !== null);
      const accepted = judged.filter(
        (run) => run.judgment?.decision === "accept",
      ).length;
      const minutes = history
        .flatMap((run) => {
          if (run.ended_at === null) return [];
          const duration = fromThrowable(() =>
            Temporal.Instant.from(run.ended_at!)
              .since(Temporal.Instant.from(run.started_at))
              .total({ unit: "minutes" }),
          )();
          if (duration.isErr()) return [];
          const elapsed = duration.value;
          return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 1440
            ? [elapsed]
            : [];
        })
        .toSorted((a, b) => a - b);
      const middle = Math.floor(minutes.length / 2);
      const median =
        minutes.length === 0
          ? null
          : (minutes[middle]! +
              minutes[Math.floor((minutes.length - 1) / 2)]!) /
            2;
      const share =
        judged.length < 5 ? null : Math.round((100 * accepted) / judged.length);
      const medianMinutes = median === null ? null : Number(median.toFixed(1));
      const medianText =
        medianMinutes === null ? "unknown" : medianMinutes.toFixed(1);
      const text =
        share === null
          ? "agx measured: too few judged runs"
          : `agx measured: ${share}% of ${judged.length} judged runs accepted, median ${medianText} min.`;
      return [
        `model_${index}`,
        {
          judged_runs: judged.length,
          accepted_runs: accepted,
          accepted_percent: share,
          ended_runs: minutes.length,
          median_wall_minutes: medianMinutes,
          text,
        },
      ];
    }),
  );
  const criteria: Record<string, string> = Object.fromEntries([
    ...candidates.map((row, index): [string, string] => [
      `model_${index}`,
      `${blindCriterion(criterionFor(roster, row), loaded.catalogRows)} ${measuredEvidence[`model_${index}`]!.text}`,
    ]),
    ...Object.entries(returns).map(([reason, value]): [string, string] => [
      reason,
      value.criterion,
    ]),
  ]);
  const request: Record<string, unknown> = {
    state: {
      task: brief.slice(0, Math.min(roster.auto.max_task_chars, 2400)),
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
        instructions: `${ROUTING_OBJECTIVE} Pick a roster row for this ticket.`,
        criteria,
      },
    },
  };
  if (roster.auto.jev.api === "typesafe") request.model = roster.auto.jev.model;
  const post = await postJev(endpoint.value, request, roster.auto.timeout_ms);
  const usageId = recordJevUsage(post, roster);
  const fallback =
    candidates.find((row) => row.id === roster.default) ?? candidates[0]!;
  let rawAnswer: unknown = null;
  const audit = (
    source: string,
    probabilities: Record<string, number> | undefined,
  ) => ({
    source,
    probabilities: probabilities ?? null,
    answer: rawAnswer,
    anonymization_map: anonymizationMap,
    usage_snapshot: usage,
    usage_id: usageId,
    measured_evidence: measuredEvidence,
  });
  const recordPick = (
    row: Choice,
    source: string,
    probabilities: Record<string, number> | undefined,
  ): Choice => {
    recordRoutingPick(row, source);
    setPendingPickAudit({
      ...audit(source, probabilities),
      chosen_row: row.id,
    });
    return row;
  };
  if (!post.ok)
    return recordPick(fallback, "fallback-request-failed", undefined);
  const decoded = jsonOf(Reply).safeParse(post.text);
  if (post.status !== 200)
    return recordPick(fallback, `fallback-http-${post.status}`, undefined);
  if (!decoded.success)
    return recordPick(fallback, "fallback-invalid-response", undefined);
  const answer = decoded.data.answers.worker;
  rawAnswer = answer ?? null;
  const selected = answer?.choice;
  const probabilities = answer?.probabilities;
  const reason = ReturnReason.safeParse(selected);
  if (reason.success) {
    recordRoutingRefusal({
      ticket: brief,
      reason: reason.data,
      ...(probabilities?.[reason.data] === undefined
        ? {}
        : { probability: probabilities[reason.data] }),
      pick_audit: audit("jev-return", probabilities),
    });
    return exitWithError(
      `agx: ticket returned: ${reason.data}: ${returns[reason.data].criterion} Fix: ${returns[reason.data].fix}\n`,
      2,
    );
  }
  const selectedRow = candidates.find(
    (row) => row.id === anonymizationMap[selected ?? ""],
  );
  if (selectedRow === undefined)
    return recordPick(
      fallback,
      answer === undefined
        ? "fallback-missing-answer"
        : "fallback-ineligible-choice",
      probabilities,
    );
  const modelProbabilities =
    probabilities === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(probabilities).filter(([id]) =>
            Object.hasOwn(anonymizationMap, id),
          ),
        );
  const sampled =
    modelProbabilities === undefined
      ? undefined
      : sampleRow(
          modelProbabilities,
          roster.auto.pick_temperature,
          randomUUID(),
        );
  const sampledRow = candidates.find(
    (row) => row.id === anonymizationMap[sampled?.row ?? ""],
  );
  return recordPick(sampledRow ?? selectedRow, "jev", probabilities);
}
