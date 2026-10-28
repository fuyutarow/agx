import type { Choice, Roster } from "./load.ts";
export { loadRoster } from "./load.ts";
export type { Choice, Roster, RosterLoad, LoadRosterOptions } from "./load.ts";
export type AutoPolicy = Roster["auto"];
export type JevEndpoint = AutoPolicy["jev"];
export type RouteName = Choice["route"];
export type WindowExhaustion = "continue" | "stop";
export type RequirementClass = "mechanical" | "localized" | "cross_module";
export const REQUIREMENT_BARS: Readonly<Record<RequirementClass, number>> = {
  mechanical: 0,
  localized: 15,
  cross_module: 40,
};

/** The exhausted-window action per route; an omitted route declaration means "continue". */
export const exhaustionPolicy = (
  auto: AutoPolicy,
): Readonly<Record<RouteName, WindowExhaustion>> => ({
  codex: auto.on_window_exhausted?.codex ?? "continue",
  claude: auto.on_window_exhausted?.claude ?? "continue",
});

/** The active eligibility filter; omission preserves eligibility for every route. */
export const routeFilterLabel = (auto: AutoPolicy): string =>
  `routes=${auto.routes === undefined ? "all (codex, claude)" : JSON.stringify(auto.routes)}`;

function price(v: number | undefined): string {
  if (v === undefined) return "—";
  return `$${v.toFixed(v < 1 ? 2 : 0)}`;
}

const blended = (x: Choice): number | undefined =>
  x.price_in === undefined || x.price_out === undefined
    ? undefined
    : x.price_in + x.price_out;

const hasTaskCostData = (r: Roster): boolean =>
  r.as_of_cost !== undefined ||
  r.choice.some(
    (row) =>
      row.aa_cost_per_task_usd !== undefined ||
      row.aa_cost_to_run_usd !== undefined ||
      row.aa_tokens_to_run_m !== undefined,
  );

/** Uses published per-task cost; older catalogs retain their original cost basis. */
export function costMultiple(r: Roster, c: Choice): number | undefined {
  const perTaskCosts = r.choice.flatMap((row) =>
    row.aa_cost_per_task_usd === undefined ? [] : [row.aa_cost_per_task_usd],
  );
  if (perTaskCosts.length > 0) {
    if (c.aa_cost_per_task_usd === undefined) return undefined;
    return (
      Math.round((c.aa_cost_per_task_usd / Math.min(...perTaskCosts)) * 10) / 10
    );
  }
  const taskCosts = r.choice.flatMap((row) =>
    row.aa_cost_to_run_usd === undefined ? [] : [row.aa_cost_to_run_usd],
  );
  if (hasTaskCostData(r)) {
    if (c.aa_cost_to_run_usd === undefined || taskCosts.length === 0)
      return undefined;
    const cheapest = Math.min(...taskCosts);
    return Math.round((c.aa_cost_to_run_usd / cheapest) * 10) / 10;
  }

  const own = blended(c);
  const prices = r.choice.flatMap((row) => blended(row) ?? []);
  if (own === undefined || prices.length === 0) return undefined;
  const cheapest = Math.min(...prices);
  return Math.round((own / cheapest) * 10) / 10;
}

/** Judgment counts remain an audit/history representation; routing does not consume them. */
export type GradeCounts = Readonly<{
  accepted: number;
  partial: number;
  rejected: number;
}>;
export type Graded = Readonly<{
  here: GradeCounts;
  recent: GradeCounts;
  comparable?: GradeCounts;
}>;

export const ROUTING_OBJECTIVE =
  "Purpose: classify this ticket by the requirement it imposes. Use mechanical for an edit whose check is already stated, localized for a behavior fix inside one module, and cross_module when an invariant, public API, or behavior across modules must change. Return the ticket only when it cannot be done as written. Do not choose a worker. Subscription health: weigh 7-day windows most; 5-hour windows are secondary; stale or unknown usage is neutral.";

/** What Jev reads about one row: its route, measured capability, and relative price. */
export function criterionFor(r: Roster, c: Choice): string {
  const scoreAsOf = c.score_as_of ?? r.as_of;
  const source = (key: string): string => {
    const url = r.sources[key];
    return url !== undefined && url.includes("artificialanalysis.ai")
      ? "Artificial Analysis"
      : (url ?? "unknown source");
  };
  const measured = [
    c.aa_index === undefined
      ? undefined
      : `AA ${c.aa_index} (${source("aa_releases")}, ${scoreAsOf})`,
    c.tb4 === undefined
      ? undefined
      : `TB4 ${c.tb4}% (${source("aa_releases")}, ${scoreAsOf})`,
    c.scicode === undefined
      ? undefined
      : `SciCode ${c.scicode}% (${source("aa_releases")}, ${scoreAsOf})`,
    c.coding_agent === undefined
      ? undefined
      : `CodingAgent ${c.coding_agent} (${source("aa_coding_agents")}, ${scoreAsOf})`,
  ].filter((x) => x !== undefined);
  const taskCostData = hasTaskCostData(r);
  const taskCostParts = [
    c.aa_tokens_to_run_m === undefined
      ? undefined
      : `${c.aa_tokens_to_run_m.toFixed(1)}M tokens`,
    r.as_of_cost === undefined ? undefined : `AA ${r.as_of_cost}`,
  ].filter((x) => x !== undefined);
  let taskCostText: string | undefined;
  if (c.aa_cost_to_run_usd !== undefined) {
    taskCostText = `Cost to run AA index: $${c.aa_cost_to_run_usd.toFixed(2)}`;
    if (taskCostParts.length > 0)
      taskCostText += ` (${taskCostParts.join(", ")})`;
  }
  const priceText =
    `Price ${price(c.price_in)}/${price(c.price_cached_in)}/${price(c.price_out)} per 1M tokens in/cache/out` +
    (taskCostData && c.aa_cost_to_run_usd === undefined
      ? " (per-token price only)"
      : "");
  const multipleBasis = taskCostData ? "cheapest costed row" : "cheapest row";
  return (
    `Route ${c.route}. ${measured.length === 0 ? "no published scores" : measured.join("; ")}. ` +
    `${priceText}.${taskCostText === undefined ? "" : ` ${taskCostText}.`} ` +
    `Multiple ${costMultiple(r, c) ?? "unknown"}x ${multipleBasis}.`
  );
}
