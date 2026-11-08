import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgxConfigWithProvenance } from "../../shared/src/agx-config.ts";
import {
  attempt,
  errorMessage,
  type Attempt,
} from "../../shared/src/attempt.ts";
import { z } from "../../shared/src/zod.ts";

export type Repo = {
  backing: string;
  name: string;
  parent: string;
  wsRoot: string;
};
export type Config = {
  ready: string[];
  trunk: string;
  trunkConfigured: boolean;
  keep: string[];
  regenerable: string[];
  unjudgedWarnHours?: number;
  policyRevision: string | undefined;
  workingCopyPolicyDiffers: boolean | undefined;
};
type ResolvedConfig = Config & { policySource: string };

export const CONFIG_FILE = "agx.toml";
const LEGACY_CONFIG_FILE = ".ws.toml";
export const trunkSettingHint = (bookmark: string): string =>
  `set [ws].trunk in ${CONFIG_FILE}: trunk = ${JSON.stringify(bookmark)}`;
export class LegacyWorkspaceConfigError extends Error {}

const bad = (message: string): Attempt<never> => ({
  ok: false,
  error: message,
});
const good = <T>(value: T): Attempt<T> => ({ ok: true, value });
const msg = (failed: { error: unknown }): string => errorMessage(failed.error);

/** Refuse the retired file, then resolve shared main-checkout L1/L2 policy. */
export async function readConfig(repo: Repo): Promise<Attempt<ResolvedConfig>> {
  const legacyPath = join(repo.backing, LEGACY_CONFIG_FILE);
  const legacyFile = await attempt(() => lstat(legacyPath));
  if (legacyFile.ok) {
    const rendered = await attempt(async () => {
      const parsed = Bun.TOML.parse(await readFile(legacyPath, "utf8"));
      return Bun.TOML.stringify({ schema: 1, ws: parsed });
    });
    const equivalent = legacyMigration(rendered);
    const message = equivalent.ok
      ? `${legacyPath} is retired. Replace ${CONFIG_FILE} with:\n${equivalent.value}\nThen delete ${LEGACY_CONFIG_FILE}.`
      : `${legacyPath} is retired; cannot render a valid [ws] migration (${msg(equivalent)}). Delete ${LEGACY_CONFIG_FILE}.`;
    return {
      ok: false,
      error: new LegacyWorkspaceConfigError(message),
    };
  }
  if (
    !z.object({ code: z.literal("ENOENT") }).safeParse(legacyFile.error).success
  )
    return bad(msg(legacyFile));

  const shared = await resolveAgxConfigWithProvenance(repo.backing, {
    vcs: "jj",
  });
  if (!shared.ok) return bad(msg(shared));
  return good({
    policySource: shared.value.policySource,
    ready: shared.value.ready,
    trunk: shared.value.trunk,
    trunkConfigured: shared.value.trunkConfigured,
    keep: shared.value.keep,
    regenerable: shared.value.regenerable,
    unjudgedWarnHours: shared.value.unjudgedWarnHours,
    policyRevision: shared.value.policyRevision,
    workingCopyPolicyDiffers: shared.value.workingCopyPolicyDiffers,
  });
}

export function reportReadyPlan(config: Config): void {
  const revision = config.policyRevision ?? "unknown revision";
  process.stderr.write(`ws: policy: agx.toml at ${revision}\n`);
  if (config.workingCopyPolicyDiffers === true)
    process.stderr.write(
      `ws: policy: working-copy agx.toml differs from the policy snapshot at ${revision}; working-copy policy is not used\n`,
    );
  if (config.ready.length === 0) {
    process.stderr.write(
      `ws: ready: none declared in agx.toml at ${revision}\n`,
    );
    return;
  }
  for (const [index, command] of config.ready.entries())
    process.stderr.write(
      `ws: ready: will run ${index + 1}/${config.ready.length}: ${command}\n`,
    );
}

function legacyMigration(
  rendered: Attempt<string | undefined>,
): Attempt<string> {
  if (!rendered.ok) return rendered;
  if (rendered.value === undefined)
    return bad("TOML serializer returned no migration");
  return good(rendered.value.trimEnd());
}
