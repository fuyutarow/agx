import { z } from "../../../shared/src/zod.ts";
import { Outcome } from "./outcome.ts";
import { Lease, Evidence, StopSignal } from "./lease.ts";
import { VerifyResult } from "./verify.ts";
import { Sandbox, SandboxSource } from "./sandbox.ts";

export const LegacyIdentity = z.object({
  run_id: z.string(),
  source: z.literal("legacy-v1"),
});

export const RunSchema = z.object({
  id: z.string(),
  legacy: LegacyIdentity.optional(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  ticket: z.string(),
  state: z.enum(["running", "ended"]),
  lease: Lease.optional(),
  signal: StopSignal.optional(),
  stopped_by: z.string().optional(),
  evidence: Evidence.optional(),
  exit: z.number().nullable(),
  outcome: Outcome.nullable(),
  launch_stderr: z.string().optional(),
  row: z.string(),
  route: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  sandbox: Sandbox.optional(),
  sandbox_source: SandboxSource.optional(),
  sandbox_effective: z.string().optional(),
  sandbox_effective_source: z.string().optional(),
  worker_name: z.string().optional(),
  unit: z.string().optional(),
  workspace_name: z.string().optional(),
  dispatcher_session: z.string().nullable(),
  cwd: z.string(),
  workspace: z.string(),
  writes: z.array(z.string()),
  judgment: z
    .object({
      decision: z.string(),
      note: z.string(),
      at: z.string(),
      legacy_key: z.string().optional(),
    })
    .nullable(),
  report_path: z.string().nullable(),
  verify: z.array(VerifyResult),
  last_progress_path: z.string().nullable(),
  continues: z.string().nullable(),
  supersedes: z.string().nullable().optional(),
  base_rev: z.string().optional(),
  premise_commits: z
    .array(z.object({ premise: z.string(), commit: z.string() }))
    .optional(),
  ticket_path: z.string().optional(),
  ticket_orig_path: z.string().optional(),
  ticket_sha256: z.string().optional(),
  vendor_session: z.string().nullable(),
  pid: z.number(),
  failed_early_quit: z.boolean(),
  returned: z.boolean().optional(),
  changed_files: z.number().optional(),
});
export type FoldedRun = z.output<typeof RunSchema>;
export type ListedRun = {
  health?: string | null;
  phase?: string | undefined;
} & Omit<FoldedRun, "pid" | "state" | "outcome" | "lease"> &
  (
    | { state: "running"; outcome: null; lease: z.output<typeof Lease> }
    | { state: "ended"; outcome: Outcome; lease?: z.output<typeof Lease> }
  );
