import { readFile } from "node:fs/promises";
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
  return {
    status: "available",
    progress: {
      last: value.last,
      at: value.at,
      commands: value.commands,
      files: value.files,
      turns: value.turns ?? null,
      usage: value.usage ?? null,
      cost_usd: value.cost_usd ?? null,
      session: value.session ?? null,
    },
  } as const;
}

/** CLI projection only: private progress paths are not a consumer file API. */
export async function listingProgress(rows: ListedRun[], root = stateDir()) {
  return Promise.all(
    rows.map(async (row) => {
      const current = await readProgress(
        join(root, "runs", row.id, "worker-progress.jsonl"),
      );
      const source = current.status === "missing" ? "active" : "run";
      const observation =
        current.status === "missing"
          ? await readProgress(join(root, "active", `${row.id}.progress.json`))
          : current;
      let vendorSession = row.vendor_session;
      if (row.state === "running") {
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
        vendorSession = observation.progress?.session ?? vendorSession;
      }
      return {
        ...row,
        vendor_session: vendorSession,
        progress: observation.progress,
        progress_source: observation.status === "missing" ? null : source,
        progress_status: observation.status,
        progress_fresh_at: observation.progress?.at ?? null,
      };
    }),
  );
}
