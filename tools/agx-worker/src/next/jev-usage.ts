import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fromPromise, fromThrowable } from "neverthrow";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import type { JevPost } from "../../../shared/src/jev-client.ts";
import { loadRoster, type Roster } from "../roster/index.ts";
import { stateDir } from "../state.ts";
import { exitWithError } from "./exit.ts";
import { statsWindow } from "./stats-window.ts";

const Tokens = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
const ResponseUsage = z.object({ usage: Tokens });
const Price = z.object({
  input_per_mtok: z.number().nonnegative().nullable(),
  output_per_mtok: z.number().nonnegative().nullable(),
  currency: z.literal("USD"),
  source: z.string(),
  as_of: z.string(),
  basis: z.literal("effective configuration; not a billing quote"),
});
const Capture = z.object({
  schema: z.literal(1),
  id: z.string(),
  at: z.iso.datetime({ offset: true }),
  tokens: Tokens.nullable(),
  pricing: Price,
});

const pricing = (roster: Roster) => ({
  input_per_mtok: roster.auto.jev.price_per_mtok_input ?? null,
  output_per_mtok: roster.auto.jev.price_per_mtok_output ?? null,
  currency: "USD" as const,
  source: "agx shipped roster catalog [jev] (overrides policy prices)",
  as_of: roster.as_of,
  basis: "effective configuration; not a billing quote" as const,
});

/** Retain metering even if the answer cannot select a worker or dispatch never starts. */
export function recordJevUsage(post: JevPost, roster: Roster): string {
  const at = Temporal.Now.instant().toString();
  const decoded = post.ok
    ? jsonOf(ResponseUsage).safeParse(post.text)
    : undefined;
  const parsed = Capture.safeParse({
    schema: 1,
    id: crypto.randomUUID(),
    at,
    tokens: decoded?.success === true ? decoded.data.usage : null,
    pricing: pricing(roster),
  });
  if (!parsed.success)
    return exitWithError(
      `agx: cannot capture Jev usage: ${parsed.error.message}\n`,
      2,
    );
  const capture = parsed.data;
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(
    join(stateDir(), "jev-usage.jsonl"),
    `${JSON.stringify(capture)}\n`,
    { mode: 0o600 },
  );
  return capture.id;
}

function journal(path: string) {
  const read = fromThrowable(() => readFileSync(path, "utf8"))();
  if (read.isErr()) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(read.error).success)
      return { rows: [], present: false, trailing: false };
    return exitWithError(
      `agx worker stats: cannot read ${path}: ${String(read.error)}\n`,
      2,
    );
  }
  const lines = read.value.split("\n");
  const tail = lines.pop();
  const rows = lines
    .filter((line) => line !== "")
    .map((line) => {
      const parsed = jsonOf(z.record(z.string(), z.unknown())).safeParse(line);
      if (!parsed.success)
        return exitWithError(
          `agx worker stats: malformed usage source ${path}: ${parsed.error.message}\n`,
          2,
        );
      return parsed.data;
    });
  return { rows, present: true, trailing: tail !== "" };
}

function legacyJournals(root: string) {
  return [root, join(root, "legacy-v1")].flatMap((dir) => {
    const read = fromThrowable(() => readdirSync(dir))();
    if (read.isErr()) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(read.error).success)
        return [];
      return exitWithError(
        `agx worker stats: cannot inspect legacy usage: ${String(read.error)}\n`,
        2,
      );
    }
    return read.value
      .filter((name) => /^runs(?:-\d{4}-\d{2}-\d{2})?\.jsonl$/u.test(name))
      .toSorted()
      .map((name) => journal(join(dir, name)));
  });
}

const Started = z.object({
  kind: z.literal("started"),
  id: z.string(),
  at: z.iso.datetime({ offset: true }),
  pick_audit: z.object({ usage_id: z.string().optional() }).optional(),
  legacy_key: z.string().optional(),
});
const Legacy = z.object({
  run_id: z.string(),
  started_at: z.iso.datetime({ offset: true }),
  pick: z
    .object({ jev: z.object({ response: z.unknown().optional() }).optional() })
    .optional(),
});

export async function jevUsageStats(window: string): Promise<number> {
  const endMs = Temporal.Now.instant().epochMilliseconds;
  const bounds = statsWindow(window, endMs);
  if (bounds === null) {
    process.stderr.write(
      "agx worker stats: --window requires a positive integer followed by m, h or d\n",
    );
    return 2;
  }
  const result = await fromPromise(
    (async () => {
      const loaded = await loadRoster();
      if (!loaded.ok)
        return exitWithError(`agx worker stats: ${loaded.error}\n`, 2);
      const root = stateDir();
      const captures = journal(join(root, "jev-usage.jsonl"));
      const records = journal(join(root, "records.jsonl"));
      const old = legacyJournals(root);
      const inWindow = (at: string) => {
        const ms = Temporal.Instant.from(at).epochMilliseconds;
        return ms >= bounds.startMs && ms < bounds.endMs;
      };
      const all = captures.rows.map((row) => {
        const parsed = Capture.safeParse(row);
        if (!parsed.success)
          return exitWithError(
            `agx worker stats: invalid usage capture: ${parsed.error.message}\n`,
            2,
          );
        return parsed.data;
      });
      const selected = all.filter((row) => inWindow(row.at));
      const ids = new Set(all.map((row) => row.id));
      const legacy = new Map<string, z.output<typeof Legacy>>();
      let unknownTime = 0;
      for (const row of old.flatMap((source) => source.rows)) {
        if (row.kind !== undefined && row.kind !== "run") continue;
        const parsed = Legacy.safeParse(row);
        if (!parsed.success) {
          unknownTime += 1;
          continue;
        }
        legacy.set(parsed.data.run_id, parsed.data);
      }
      let historicalMissing = 0;
      let legacyKnown = 0;
      const tokens = selected.flatMap((row) =>
        row.tokens === null ? [] : [row.tokens],
      );
      for (const row of legacy.values()) {
        if (!inWindow(row.started_at)) continue;
        const parsed = ResponseUsage.safeParse(row.pick?.jev?.response);
        if (parsed.success) {
          tokens.push(parsed.data.usage);
          legacyKnown += 1;
        } else historicalMissing += 1;
      }
      // Count imported run evidence only once when its raw legacy source is retained.
      for (const row of records.rows) {
        if (row.kind !== "started") continue;
        const parsed = Started.safeParse(row);
        if (!parsed.success) {
          unknownTime += 1;
          continue;
        }
        const run = parsed.data;
        if (!inWindow(run.at)) continue;
        if (
          run.legacy_key !== undefined &&
          legacy.has(run.legacy_key.slice("run:".length))
        )
          continue;
        if (
          run.pick_audit?.usage_id === undefined ||
          !ids.has(run.pick_audit.usage_id)
        )
          historicalMissing += 1;
      }
      const missing = selected.filter((row) => row.tokens === null).length;
      const unknown = missing + historicalMissing;
      const input = tokens.reduce((sum, row) => sum + row.input_tokens, 0);
      const output = tokens.reduce((sum, row) => sum + row.output_tokens, 0);
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output))
        return exitWithError(
          "agx worker stats: token total exceeds safe integer range\n",
          2,
        );
      const price = pricing(loaded.value);
      const subtotal =
        price.input_per_mtok === null ||
        price.output_per_mtok === null ||
        tokens.length === 0
          ? null
          : (input * price.input_per_mtok + output * price.output_per_mtok) /
            1_000_000;
      const partialTail = [captures, records, ...old].some(
        (source) => source.trailing,
      );
      const observedComplete =
        unknown === 0 && unknownTime === 0 && !partialTail;
      return {
        schema: 1,
        usage: "jev",
        window,
        from: Temporal.Instant.fromEpochMilliseconds(bounds.startMs).toString(),
        to: Temporal.Instant.fromEpochMilliseconds(bounds.endMs).toString(),
        captured_at: Temporal.Now.instant().toString(),
        interval: "[from,to)",
        input_tokens: observedComplete && tokens.length > 0 ? input : null,
        output_tokens: observedComplete && tokens.length > 0 ? output : null,
        known_input_tokens: tokens.length === 0 ? null : input,
        known_output_tokens: tokens.length === 0 ? null : output,
        pricing: {
          ...price,
          observed_at: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
        },
        estimated_cost_usd: observedComplete ? subtotal : null,
        known_tokens_at_effective_price_usd: subtotal,
        completeness: "partial",
        unknown: {
          usage: unknown,
          historical_runs: historicalMissing,
          captured_calls: missing,
          time: unknownTime,
          historical_pricing: legacyKnown,
        },
        coverage: {
          history_complete: false,
          observed_records_complete: observedComplete,
          captured_calls: selected.length,
          known_usage_records: tokens.length,
          legacy_known_usage_records: legacyKnown,
          usage_journal_present: captures.present,
          legacy_journals_present: old.filter((source) => source.present)
            .length,
          trailing_partial_record: partialTail,
          first_capture_at:
            all
              .map((row) => row.at)
              .toSorted((a, b) => Temporal.Instant.compare(a, b))[0] ?? null,
          reason:
            "pre-capture runs without usage are unknown; unretained history and manual versus routed historical runs cannot be established",
        },
      };
    })(),
    String,
  );
  if (result.isErr()) {
    process.stderr.write(
      `agx worker stats: cannot collect Jev usage: ${result.error}\n`,
    );
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
  return 0;
}
