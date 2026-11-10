/**
 * Shipped values for every optional user-policy key. They equal policy.example.toml, except
 * `route.allow` (omitted means both routes) and `pick_temperature` (0, argmax).
 * `route.no_egress` is retired: accepted for old files, preserved, never enforced.
 */
export const POLICY_DEFAULTS = {
  route: {
    on_window_exhausted: { codex: "continue", claude: "stop" },
    exclude: [],
    max_task_chars: 6000,
    timeout_ms: 20000,
    no_egress: [],
    pick_temperature: 0,
    jev: {
      api: "typesafe",
      url: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
    },
  },
  claude_run: {
    max_budget_usd: 2,
    max_turns: 60,
    reason:
      "A worker task here cost 0.05-0.20 USD on luna; 20x is 1-4 USD, so 2 USD caps a run near the median at claude prices and turns an endless loop into a bounded failure.",
  },
} as const;

export type PolicyKeySource = "file" | "default";

/** Every policy key whose origin `roster --json` reports. */
export const POLICY_KEYS = [
  "route.allow",
  "route.on_window_exhausted",
  "route.exclude",
  "route.max_task_chars",
  "route.timeout_ms",
  "route.no_egress",
  "route.pick_temperature",
  "route.jev",
  "claude_run.max_budget_usd",
  "claude_run.max_turns",
  "claude_run.reason",
] as const;
