import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { selectedInventory } from "./inventory.ts";
import {
  canonicalUuid,
  resolveRecipientSelector,
} from "./recipient-prefix.ts";

export const BOUND_CLAUDE_TARGET_ENV = "AGX_XMSG_BOUND_CLAUDE_TARGET";

const claudeAddress = z
  .string()
  .regex(/^claude:.+$/u)
  .refine((value) => value.trim() === value && !/[\r\n]/u.test(value));
const BoundClaudeTarget = z.strictObject({
  selector: claudeAddress,
  address: claudeAddress,
});
export type BoundClaudeTarget = z.output<typeof BoundClaudeTarget>;

export type BoundClaudeTargetRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "present"; binding: BoundClaudeTarget };

export function normalizeClaudeSelector(value: string): string | undefined {
  if (value.trim() !== value || /[\r\n]/u.test(value)) return undefined;
  const match = /^claude:(.+)$/u.exec(value);
  const id = match?.[1];
  if (id === undefined || id.trim() !== id) return undefined;
  const uuid = canonicalUuid(id);
  const normalized =
    uuid ?? (/^[0-9a-f-]+$/iu.test(id) ? id.toLowerCase() : id);
  return `claude:${normalized}`;
}

export function encodeBoundClaudeTarget(
  binding: BoundClaudeTarget,
): string {
  const normalized = normalizeClaudeSelector(binding.selector);
  const checked = BoundClaudeTarget.safeParse({
    ...binding,
    selector: normalized,
  });
  assert.ok(checked.success, new Error("invalid dispatch-bound Claude target"));
  return Buffer.from(JSON.stringify(checked.data)).toString("base64url");
}

export function readBoundClaudeTarget(
  env: NodeJS.ProcessEnv = process.env,
): BoundClaudeTargetRead {
  const encoded = env[BOUND_CLAUDE_TARGET_ENV];
  if (encoded === undefined) return { kind: "absent" };
  if (encoded === "" || encoded.length > 16_384)
    return { kind: "invalid", reason: "invalid encoded value length" };
  const parsed = jsonOf(BoundClaudeTarget).safeParse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  if (!parsed.success)
    return { kind: "invalid", reason: "invalid encoded target record" };
  if (normalizeClaudeSelector(parsed.data.selector) !== parsed.data.selector)
    return { kind: "invalid", reason: "selector is not normalized" };
  return { kind: "present", binding: parsed.data };
}

export function matchBoundClaudeTarget(
  selector: string,
  env: NodeJS.ProcessEnv = process.env,
):
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "unmatched" }
  | { kind: "matched"; name: string } {
  const read = readBoundClaudeTarget(env);
  if (read.kind !== "present") return read;
  if (
    normalizeClaudeSelector(selector) !== read.binding.selector
  )
    return { kind: "unmatched" };
  const name = read.binding.address.slice("claude:".length);
  return { kind: "matched", name };
}

/** Resolve a ticket/session selector before sandbox launch and retain its delivery name. */
export async function resolveClaudeDeliveryTarget(
  selector: string,
  timeoutMs: number,
): Promise<
  | { ok: true; binding: BoundClaudeTarget }
  | { ok: false; reason: string }
> {
  const normalized = normalizeClaudeSelector(selector);
  if (normalized === undefined)
    return { ok: false, reason: "expected claude:<UUID, prefix, or exact name>" };
  const id = normalized.slice("claude:".length);
  const bindName = (name: string) => ({
    ok: true as const,
    binding: { selector: normalized, address: `claude:${name}` },
  });
  const uuid = canonicalUuid(id);
  if (uuid !== undefined) {
    const resolved = await resolveClaudeTarget(uuid, timeoutMs);
    return resolved.ok
      ? bindName(resolved.name)
      : { ok: false, reason: resolved.reason };
  }
  if (!/^[0-9a-f-]+$/iu.test(id)) return bindName(id);

  const started = performance.now();
  const inventory = await selectedInventory("claude", timeoutMs);
  const resolution = resolveRecipientSelector(
    normalized,
    inventory.recipients,
    inventory.evidence,
  );
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const resolvedUuid = canonicalUuid(resolution.recipient.id);
  if (resolvedUuid === undefined)
    return { ok: false, reason: "resolved Claude target has no canonical UUID" };
  const remaining = Math.floor(timeoutMs - (performance.now() - started));
  if (remaining < 1)
    return { ok: false, reason: "Claude target resolution deadline exceeded" };
  const resolved = await resolveClaudeTarget(
    resolvedUuid,
    remaining,
    inventory,
  );
  return resolved.ok
    ? bindName(resolved.name)
    : { ok: false, reason: resolved.reason };
}

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
    ["busy", "shell", "idle", "waiting", "unknown"].includes(recipient.state),
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
