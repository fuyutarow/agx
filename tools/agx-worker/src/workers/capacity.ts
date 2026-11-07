import { jsonOf, z } from "../../../shared/src/zod.ts";

// Allow ordinary startup/network latency, but never spend a long ticket waiting for a model.
export const MODEL_WAIT_MS = 120_000;
export const CAPACITY_EXIT = 75; // Temporary vendor unavailability, not a worker failure.
export const CAPACITY_STOP_GRACE_MS = 1_000;

export function modelWaitMs(): number {
  const testMs = Number(process.env.AGX_TEST_MODEL_WAIT_MS);
  return Number.isFinite(testMs) && testMs > 0
    ? Math.min(testMs, MODEL_WAIT_MS)
    : MODEL_WAIT_MS;
}

const ErrorEnvelope = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  error_status: z.number().nullable().optional(),
  error_code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .union([
      z.string(),
      z.looseObject({
        type: z.string().optional(),
        message: z.string().optional(),
      }),
    ])
    .optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
});

/** Recognize billing failures only in vendor errors or plain diagnostics. */
export function creditsUnavailable(line: string): boolean {
  const parsed = jsonOf(ErrorEnvelope).safeParse(line);
  if (parsed.success) {
    const event = parsed.data;
    if (
      event.error_code === "enforced_spend_limit_reached" &&
      event.type !== "assistant"
    )
      return true;
    if (
      !(
        event.type === "error" ||
        event.is_error === true ||
        event.subtype === "api_retry" ||
        event.error !== undefined
      )
    )
      return false;
    if (
      event.type === "system" &&
      event.subtype === "api_retry" &&
      event.error === "billing_error"
    )
      return true;
  } else if (line.trimStart().startsWith("{")) return false;
  return /Your credit balance is too low to access the Anthropic API|Credit balance too low|You have reached your specified (?:workspace )?API usage limits|enforced_spend_limit_reached/iu.test(
    line,
  );
}

/** Only vendor errors or plain diagnostics count; quoted tool/assistant output does not. */
export function capacityMessage(
  line: string,
  vendor: "codex" | "claude",
): string | undefined {
  const parsed = jsonOf(ErrorEnvelope).safeParse(line);
  let message = line;
  if (parsed.success) {
    const event = parsed.data;
    const vendorError =
      event.type === "error" ||
      event.type === "turn.failed" ||
      event.is_error === true ||
      event.subtype === "api_retry" ||
      (vendor === "claude" && event.error !== undefined);
    if (!vendorError) return undefined;
    if (
      vendor === "claude" &&
      event.type === "system" &&
      event.subtype === "api_retry" &&
      event.error_status === 529
    )
      return JSON.stringify(event);
    message = JSON.stringify(event);
  } else if (line.trimStart().startsWith("{")) {
    return undefined;
  }
  const matches =
    vendor === "codex"
      ? /\bselected model is at capacity\b/iu.test(message)
      : // Anthropic documents HTTP 529 as overloaded_error:
        // https://platform.claude.com/docs/en/api/errors
        /\boverloaded_error\b|\bAPI Error:\s*529\b/iu.test(message);
  return matches ? message.trim() : undefined;
}

/** Session/turn metadata and reconnect messages do not establish that a model answered. */
export function modelAnswered(
  line: string,
  vendor: "codex" | "claude",
): boolean {
  const parsed = jsonOf(z.looseObject({ type: z.string() })).safeParse(line);
  if (!parsed.success) return false;
  return vendor === "codex"
    ? ["item.started", "item.completed", "turn.completed"].includes(
        parsed.data.type,
      )
    : [
        "assistant",
        "result",
        "content_block_start",
        "content_block_delta",
      ].includes(parsed.data.type);
}
