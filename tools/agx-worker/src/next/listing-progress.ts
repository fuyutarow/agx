import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fromPromise, fromThrowable } from "neverthrow";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import {
  ActiveMarkerReaderSchema,
  ProgressReaderSchema,
} from "../../../shared/src/dispatch-state.ts";
import { stateDir } from "../state.ts";
import type { ListedRun } from "./run-state.ts";

async function readProgress(path: string) {
  const read = await fromPromise(readFile(path, "utf8"), (error) => error);
  if (read.isErr()) {
    const error = z.object({ code: z.literal("ENOENT") }).safeParse(read.error);
    const missing = error.success;
    return {
      status: missing ? "missing" : "unreadable",
      progress: null,
    } as const;
  }
  const parsed = jsonOf(ProgressReaderSchema).safeParse(read.value);
  if (
    !parsed.success ||
    fromThrowable(() => Temporal.Instant.from(parsed.data.at))().isErr()
  )
    return { status: "invalid", progress: null } as const;
  const value = parsed.data;
  const usage =
    value.usage !== undefined &&
    Object.values(value.usage).some((field) => field !== undefined)
      ? value.usage
      : null;
  return {
    status: "available",
    progress: {
      last: value.last,
      at: value.at,
      commands: value.commands,
      files: value.files,
      turns: value.turns ?? null,
      usage,
      usage_reason: usage === null ? "vendor has not reported usage yet" : null,
      cost_usd: value.cost_usd ?? null,
      cost_reason:
        value.cost_usd !== undefined
          ? null
          : "vendor has not reported cost and no usage-based estimate is available",
      session: value.session ?? null,
    },
  } as const;
}

/** CLI projection only: private progress paths are not a consumer file API. */
export async function listingProgress(rows: ListedRun[], root = stateDir()) {
  const [runs, active] = await Promise.all([
    entries(join(root, "runs")),
    entries(join(root, "active")),
  ]);
  const missing = { status: "missing", progress: null } as const;
  return Promise.all(
    rows.map(async (row) => {
      const current =
        runs?.has(row.id) === false
          ? missing
          : await readProgress(
              join(root, "runs", row.id, "worker-progress.jsonl"),
            );
      const source = current.status === "missing" ? "active" : "run";
      let observation = current;
      if (current.status === "missing") {
        observation =
          active?.has(`${row.id}.progress.json`) === false
            ? missing
            : await readProgress(
                join(root, "active", `${row.id}.progress.json`),
              );
      }
      let vendorSession = row.vendor_session;
      if (row.state === "running" && active?.has(`${row.id}.json`) !== false) {
        const marker = jsonOf(ActiveMarkerReaderSchema).safeParse(
          await readFile(join(root, "active", `${row.id}.json`), "utf8").catch(
            () => "",
          ),
        );
        if (
          marker.success &&
          marker.data.run_id === row.id &&
          marker.data.pid === row.lease.pid &&
          marker.data.cwd === row.cwd
        )
          vendorSession = marker.data.worker_session ?? vendorSession;
      }
      if (row.state === "running")
        vendorSession = observation.progress?.session ?? vendorSession;
      return {
        ...row,
        vendor_session: vendorSession,
        progress: observation.progress,
        progress_source: observation.status === "missing" ? null : source,
        progress_status: observation.status,
        progress_reason:
          observation.status === "available"
            ? null
            : {
                missing:
                  "progress sink missing; producer may predate progress sink or no event has arrived",
                invalid: "progress record has invalid JSON, shape or timestamp",
                unreadable: "progress record could not be read",
              }[observation.status],
        progress_fresh_at: observation.progress?.at ?? null,
      };
    }),
  );
}

// A missing directory proves its children absent without one failed open per run.
// Other errors fall back to the ordinary read so unreadable remains observable.
async function entries(path: string) {
  const result = await fromPromise(readdir(path), (error) => error);
  if (result.isOk()) return new Set(result.value);
  return z.object({ code: z.literal("ENOENT") }).safeParse(result.error).success
    ? new Set<string>()
    : undefined;
}
