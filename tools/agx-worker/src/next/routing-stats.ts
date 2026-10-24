import { hostname } from "node:os";
import { fromPromise } from "neverthrow";
import { loadRoster, exhaustionPolicy } from "../roster/index.ts";
import { readRouteUsage, type RouteUsageState } from "./usage.ts";
import { routingEvents } from "./routing-events.ts";
import { exitWithError } from "./exit.ts";
import { statsWindow } from "./stats-window.ts";

function capability(
  local: boolean,
  enabled: boolean | null,
  executable: string,
  usage?: RouteUsageState,
) {
  const binary = local ? Bun.which(executable) !== null : null;
  const blocked =
    enabled === false || binary === false || usage?.available === false;
  let executableState = "unknown";
  if (binary !== null) executableState = binary ? "present" : "absent";
  return {
    state: blocked ? "unavailable" : "unknown",
    configured: enabled,
    executable: executableState,
    sandbox: "unknown",
    reason: local
      ? "executable presence is not an execution or sandbox probe"
      : "host is not local; no remote capability probe",
    subscription: usage ?? null,
  };
}

export async function routingStats(
  window: string,
  host = hostname(),
): Promise<number> {
  const endMs = Temporal.Now.instant().epochMilliseconds;
  const bounds = statsWindow(window, endMs);
  if (bounds === null || host.trim() === "") {
    process.stderr.write(
      "agx worker stats: --window requires a positive integer followed by m, h or d; --host must be nonblank\n",
    );
    return 2;
  }
  const result = await fromPromise(
    (async () => {
      const journal = routingEvents();
      const selected = journal.events.filter((event) => {
        const at = Temporal.Instant.from(event.at).epochMilliseconds;
        return event.host === host && at >= bounds.startMs && at < bounds.endMs;
      });
      const picks = selected.filter((event) => event.source === "jev");
      const codex = picks.filter((event) => event.route === "codex").length;
      const local = host === hostname();
      const loaded = local ? await loadRoster() : undefined;
      if (loaded !== undefined && !loaded.ok)
        return exitWithError(`agx worker stats: ${loaded.error}\n`, 2);
      const roster = loaded?.ok === true ? loaded.value : undefined;
      const policy =
        roster === undefined ? undefined : exhaustionPolicy(roster.auto);
      const usage = local ? await readRouteUsage(endMs, policy) : undefined;
      const enabled = (route: "codex" | "claude") =>
        roster === undefined
          ? null
          : roster.choice.some((row) => row.route === route) &&
            (roster.auto.routes === undefined ||
              roster.auto.routes.includes(route));
      return {
        schema: 1,
        observation: {
          start: Temporal.Instant.fromEpochMilliseconds(
            bounds.startMs,
          ).toString(),
          end: Temporal.Instant.fromEpochMilliseconds(bounds.endMs).toString(),
          window,
          duration_ms: bounds.durationMs,
          interval: "[start,end)",
        },
        host,
        jev: {
          pick_count: picks.length,
          denominator: picks.length,
          codex_pick_count: codex,
          codex_share: picks.length === 0 ? null : codex / picks.length,
        },
        fallback_count: selected.length - picks.length,
        routes: {
          codex: capability(local, enabled("codex"), "codex", usage?.codex),
          claude: capability(local, enabled("claude"), "claude", usage?.claude),
        },
        coverage: {
          status: "partial",
          journal_present: journal.present,
          trailing_partial_record: journal.trailingPartial,
          first_recorded_at:
            journal.events
              .map((event) => event.at)
              .toSorted((a, b) => Temporal.Instant.compare(a, b))[0] ?? null,
          history_complete: false,
          legacy: "unknown",
          unknown: [
            "pre-journal selections and legacy host attribution",
            "journal retention or deletion",
            "execution and sandbox capability",
          ],
          subscription_max_age_ms: 900_000,
        },
      };
    })(),
    String,
  );
  if (result.isErr()) {
    process.stderr.write(
      `agx worker stats: cannot collect routing statistics: ${result.error}\n`,
    );
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
  return 0;
}
