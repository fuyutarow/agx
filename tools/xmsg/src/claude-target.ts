import { homedir } from "node:os";
import { join } from "node:path";
import { selectedInventory } from "./inventory.ts";
import { canonicalUuid } from "./recipient-prefix.ts";

/** Use the native liveness-filtered registry view, never saved transcripts. */
export async function resolveClaudeTarget(
  uuid: string,
  timeoutMs: number,
  snapshot?: Awaited<ReturnType<typeof selectedInventory>>,
): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  const source = `claude agents --json (session registry ${JSON.stringify(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions"))})`;
  const inventory = snapshot ?? (await selectedInventory("claude", timeoutMs));
  const refuse = (reason: string) =>
    ({
      ok: false,
      reason: `Claude target resolution failed for claude:${uuid}: ${JSON.stringify(reason)}; searched ${source}`,
    }) satisfies { ok: false; reason: string };
  if (!inventory.evidence.available || !inventory.evidence.complete)
    return refuse(inventory.evidence.reason ?? "live inventory unavailable");
  const live = inventory.recipients.filter((recipient) =>
    ["busy", "shell", "idle", "waiting"].includes(recipient.state),
  );
  const matches = live.filter(
    (recipient) => canonicalUuid(recipient.id) === uuid,
  );
  if (matches.length !== 1)
    return refuse(`found ${matches.length} live registrations`);
  const name = matches[0]?.name;
  if (name === null || name === undefined || name.trim() === "")
    return refuse("live registration has no native name");
  if (live.filter((recipient) => recipient.name === name).length !== 1)
    return refuse("native name is not unique in live registrations");
  return { ok: true, name };
}
