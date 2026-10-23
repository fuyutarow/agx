import {
  writeSubscriptionUsageSnapshot,
  type SubscriptionUsageWindow,
} from "../../../shared/src/subscription-usage.ts";

type RateFacts = {
  rl5?: number | undefined;
  rl5Reset?: number | undefined;
  rl7?: number | undefined;
  rl7Reset?: number | undefined;
  codexRate?: {
    windows: { minutes: number; percent: number; reset: number }[];
    mtimeMs: number;
  };
};

function windowUsage(
  percent: number | undefined,
  reset: number | undefined,
  seconds: number,
  measuredAt: number,
): SubscriptionUsageWindow | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return {
    used_percent: percent,
    resets_at: reset !== undefined && Number.isFinite(reset) ? reset : null,
    window_seconds: seconds,
    measured_at: measuredAt,
  };
}

export function writeUsageSnapshot(
  facts: RateFacts,
  nowSeconds: number,
  env: NodeJS.ProcessEnv,
): boolean {
  const week = facts.codexRate?.windows.find(
    (window) => window.minutes === 10080,
  );
  return writeSubscriptionUsageSnapshot(
    {
      version: 1,
      routes: {
        claude: {
          "5h": windowUsage(
            facts.rl5,
            facts.rl5Reset,
            18000,
            nowSeconds * 1000,
          ),
          "7d": windowUsage(
            facts.rl7,
            facts.rl7Reset,
            604800,
            nowSeconds * 1000,
          ),
        },
        codex: {
          "7d":
            week === undefined
              ? undefined
              : windowUsage(
                  week.percent,
                  week.reset,
                  604800,
                  facts.codexRate?.mtimeMs ?? nowSeconds * 1000,
                ),
        },
      },
    },
    env,
  );
}
