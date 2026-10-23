import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { stateDir } from "../state.ts";
import { attempt, type Attempt } from "../../../shared/src/attempt.ts";

export const Sandbox = z.enum(["none", "read-only", "workspace-write"]);
export const SandboxSource = z.enum([
  "flag",
  "ticket",
  "continued run",
  "built-in default",
]);

/** Old started events omitted sandbox; the native worker receipt retained it. */
export async function recordedSandbox(
  previous: { id: string; sandbox?: string | undefined } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Attempt<string | undefined>> {
  if (previous === undefined) return { ok: true, value: undefined };
  if (previous.sandbox !== undefined) {
    const parsed = Sandbox.safeParse(previous.sandbox);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: parsed.error };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(previous.id))
    return { ok: false, error: new Error("invalid continued run id") };
  const path = join(stateDir(env), "runs", previous.id, `${previous.id}.json`);
  const text = await attempt(() => readFile(path, "utf8"));
  if (!text.ok)
    return z.object({ code: z.literal("ENOENT") }).safeParse(text.error).success
      ? { ok: true, value: undefined }
      : text;
  const parsed = jsonOf(
    z.looseObject({ sandbox: Sandbox.optional() }),
  ).safeParse(text.value);
  if (!parsed.success)
    return {
      ok: false,
      error: new Error(
        `invalid sandbox receipt ${path}: ${parsed.error.message}`,
      ),
    };
  return { ok: true, value: parsed.data.sandbox };
}

export function resolveSandbox(
  flag: string | undefined,
  ticket: string | undefined,
  continued: string | undefined,
) {
  if (flag !== undefined)
    return { sandbox: flag, sandbox_source: SandboxSource.enum.flag };
  if (ticket !== undefined)
    return { sandbox: ticket, sandbox_source: SandboxSource.enum.ticket };
  if (continued !== undefined)
    return {
      sandbox: continued,
      sandbox_source: SandboxSource.enum["continued run"],
    };
  return {
    sandbox: "workspace-write",
    sandbox_source: SandboxSource.enum["built-in default"],
  };
}
