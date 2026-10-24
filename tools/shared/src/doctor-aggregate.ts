import { join } from "node:path";
import { DoctorRecord } from "./doctor-record.ts";
import { stateDir } from "./state-dir.ts";
import { z } from "./zod.ts";

export const doctorTools = ["agx-worker", "agx-ws", "agx-ticket"] as const;
const count = z.number().int().nonnegative();
export const DoctorAggregate = z.object({
  schema: z.literal(1),
  findings: z.array(DoctorRecord),
  kinds: z.record(z.string(), count),
  total: count,
  lost: count,
  complete: z.boolean(),
  captured_at: count,
  members: z
    .array(
      z.object({
        tool: z.enum(doctorTools),
        exit: z.number().int().nullable(),
        complete: z.boolean(),
      }),
    )
    .length(3),
});
export type DoctorAggregate = z.output<typeof DoctorAggregate>;

/** Private owner snapshot; consumers use agx doctor/status --json. */
export function doctorAggregatePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(stateDir(env), "doctor-aggregate.json");
}
