import { readRouteUsage } from "../../../src/next/usage.ts";

const home = process.env.AGX_SUBSCRIPTION_TEST_HOME;
const nowMs = Number(process.env.AGX_SUBSCRIPTION_TEST_NOW_MS);
if (home === undefined || !Number.isSafeInteger(nowMs)) {
  process.stderr.write("subscription usage fixture inputs are invalid\n");
  process.exitCode = 1;
} else {
  const usage = await readRouteUsage(
    nowMs,
    { claude: "stop", codex: "continue" },
    { HOME: home },
  );
  process.stdout.write(
    `${JSON.stringify({
      status: usage.claude.usage_status,
      exhausted: usage.claude.exhausted,
      available: usage.claude.available,
      codexSource: usage.codex.source_reason,
    })}\n`,
  );
}
