// agx's on-disk paths and progress state. The shared active-marker contract lives in tools/shared;
// agx validates writes here through its re-export and statusline/hooks use its reader schema.
// Outside the repo by design: briefs and picks may be private. Zero-dep beyond the repo's zod bundle.
import { renameSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { fromPromise } from "neverthrow";

import { fromThrowable, z } from "../../shared/src/zod.ts";
import {
  ACTIVE_MARKER_SCHEMA,
  ActiveMarkerSchema,
} from "../../shared/src/dispatch-state.ts";
import { stateDir as resolveStateDir } from "../../shared/src/state-dir.ts";
export { ActiveMarkerSchema };

export const STATE_SCHEMA = ACTIVE_MARKER_SCHEMA;
// agx owns the selection extension; shared consumers accept new marker fields.
export const ActiveWriterSchema = ActiveMarkerSchema.extend({
  sandbox: z.string().optional(),
  picked_probability: z.number().min(0).max(1).optional(),
  interim_cost_usd: z.number().nonnegative().optional(),
  /** the ticket's proposition id, so ps can show allocation per proposition */
  proposition: z.string().min(1).optional(),
});
export type Active = z.output<typeof ActiveWriterSchema>;

/** $AGX_STATE_DIR (test seam), else $XDG_STATE_HOME/agx, else ~/.local/state/agx. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateDir(env);
}

type LegacyLandStatus = {
  present: boolean | null;
  status: "present" | "absent" | "refused";
  reason: string;
};

const legacyLandRefusal = (cause: unknown): LegacyLandStatus => {
  const error = z.object({ code: z.string() }).safeParse(cause);
  return {
    present: null,
    status: "refused",
    reason: `cannot inspect state directory: ${error.success ? error.data.code : "unknown error"}`,
  };
};

/** Presence only: never read journals, create state, or infer migration completion. */
export async function legacyLandStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyLandStatus> {
  const root = stateDir(env);
  const rootEntry = await fromPromise(lstat(root), (error) => error);
  if (rootEntry.isErr()) {
    const missing = z
      .object({ code: z.literal("ENOENT") })
      .safeParse(rootEntry.error);
    if (!missing.success) return legacyLandRefusal(rootEntry.error);
    return {
      present: false,
      status: "absent",
      reason: "state directory does not exist",
    };
  }
  // Listing distinguishes unreadable state from an absent land entry. A dangling
  // state symlink or a non-directory state path also refuses inspection.
  const entries = await fromPromise(readdir(root), (error) => error);
  if (entries.isErr()) return legacyLandRefusal(entries.error);
  if (entries.value.includes("land"))
    return {
      present: true,
      status: "present",
      reason: "legacy land entry exists; owner migration evidence is required",
    };
  return {
    present: false,
    status: "absent",
    reason: "legacy land entry does not exist",
  };
}

/** Atomically persist a strictly validated active marker and its live statusline fields. */
export function writeActiveMarker(path: string, active: Active): boolean {
  const parsed = ActiveWriterSchema.safeParse(active);
  if (!parsed.success) return false;
  const tmp = `${path}.${process.pid}.tmp`;
  return fromThrowable(() => {
    writeFileSync(tmp, JSON.stringify(parsed.data));
    renameSync(tmp, path);
  })().isOk();
}

// A brief's dispatch declaration (CLAUDE.md: every dispatch declares its resource class) is the
// same few words on every brief, so as a label it told the Run rows nothing (Vast 2026-10-06: three
// rows all read "RESOURCE-CLASS(NONCOMPUTE): read"). The label is the first line after it.
const DECLARATION = /^RESOURCE-(?:CLASS|ENVELOPE)\(/u;
const LABEL_CHARS = 60;

/** A worker's default label: the brief's first line that is not a declaration, heading marks dropped. */
export function briefLabel(brief: string): string {
  return (
    brief
      .split("\n")
      .map((l) => l.trim().replace(/^#+\s*/u, ""))
      .find((l) => l !== "" && !DECLARATION.test(l))
      ?.slice(0, LABEL_CHARS) ?? ""
  );
}

export { type Progress } from "../../shared/src/dispatch-state.ts";
