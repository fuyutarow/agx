import { attempt, errorMessage } from "../../shared/src/attempt.ts";
import { codexInputs } from "./inventory.ts";

/** Observe retained native input, never enqueue acceptance or assistant prose. */
export async function waitForReply(
  recipient: string,
  sender: string,
  body: string,
  timeoutMs: number,
): Promise<number> {
  if (recipient.startsWith("claude:")) {
    process.stderr.write(
      "agx msg: reply observation unavailable for Claude: replies enter the receiving harness inbox; ListAgents and SendMessage expose no inbox read API. Observe the reply inside that Claude session.\n",
    );
    return 3;
  }
  const started = performance.now();
  const deadline = started + timeoutMs;
  const threadId = recipient.slice("codex:".length);
  process.stderr.write(
    `agx msg: waiting up to ${timeoutMs} ms for exact reply input addressed to ${recipient}\n`,
  );
  for (;;) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) break;
    const observed = await attempt(() => codexInputs(threadId, remaining));
    if (!observed.ok && performance.now() >= deadline) break;
    if (!observed.ok) {
      process.stderr.write(
        `agx msg: reply observation unavailable: ${errorMessage(observed.error)}\n`,
      );
      return 3;
    }
    if (performance.now() >= deadline) break;
    const reply = observed.value.find(
      (input) => input.text === `from: ${sender}\n\n${body}`,
    );
    if (reply !== undefined) {
      process.stdout.write(
        JSON.stringify({
          recipient,
          sender,
          itemId: reply.id,
          body,
          elapsedMs: Math.round(performance.now() - started),
          evidence: "codex thread/read userMessage",
        }) + "\n",
      );
      return 0;
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - performance.now())));
  }
  process.stderr.write(
    `agx msg: reply deadline exceeded after ${Math.round(performance.now() - started)} ms; no matching native thread input observed (pending queue entries are not receipts)\n`,
  );
  return 4;
}
