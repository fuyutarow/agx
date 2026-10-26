import type { Choice, Roster } from "./load.ts";
export { loadRoster } from "./load.ts";
export type { Choice, Roster, RosterLoad, LoadRosterOptions } from "./load.ts";
export type AutoPolicy = Roster["auto"];
export type JevEndpoint = AutoPolicy["jev"];
export type RouteName = Choice["route"];
export type WindowExhaustion = "continue" | "stop";

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

/** How many times the cheapest row's blended price (input + output per 1M tokens) this row costs. */
export function costMultiple(r: Roster, c: Choice): number | undefined {
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
  "Purpose: maximize productive throughput per cost: accepted results per unit of the owner's spend (list price × tokens) and per minute of waiting. For this ticket choose the cheapest option whose published scores indicate it can produce an accepted result; pay for a more expensive option only when the ticket's requirements exceed what the cheaper option's scores support. Evidence: judge each option by its published scores and price against what the ticket requires; agx does not feed its own run outcomes back into this choice. Return the ticket instead of choosing a model only when it cannot be done as written. Subscription health: weigh 7-day windows most; 5-hour windows are secondary; keep the intended bias toward the codex route; stale or unknown usage is neutral.";

/** What Jev reads about one row: its route, measured capability, and relative price. */
export function criterionFor(r: Roster, c: Choice): string {
  const source = (key: string): string => {
    const url = r.sources[key];
    return url !== undefined && url.includes("artificialanalysis.ai")
      ? "Artificial Analysis"
      : (url ?? "unknown source");
  };
  const measured = [
    c.aa_index === undefined
      ? undefined
      : `AA ${c.aa_index} (${source("aa_releases")}, ${r.as_of})`,
    c.tb4 === undefined
      ? undefined
      : `TB4 ${c.tb4}% (${source("aa_releases")}, ${r.as_of})`,
    c.scicode === undefined
      ? undefined
      : `SciCode ${c.scicode}% (${source("aa_releases")}, ${r.as_of})`,
    c.coding_agent === undefined
      ? undefined
      : `CodingAgent ${c.coding_agent} (${source("aa_coding_agents")}, ${r.as_of})`,
  ].filter((x) => x !== undefined);
  const priceText = `Price ${price(c.price_in)}/${price(c.price_cached_in)}/${price(c.price_out)} per 1M tokens in/cache/out`;
  return (
    `Route ${c.route}. ${measured.length === 0 ? "no published scores" : measured.join("; ")}. ` +
    `${priceText}. Multiple ${costMultiple(r, c) ?? "unknown"}x cheapest row.`
  );
}
