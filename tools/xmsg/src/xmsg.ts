#!/usr/bin/env bun
import { cli } from "cleye";
import packageJson from "../package.json" with { type: "json" };
import { attempt, errorMessage } from "../../shared/src/attempt.ts";
import { standardCli } from "../../shared/src/cli.ts";
import { listRecipients, selectedInventory } from "./inventory.ts";
import {
  canonicalUuid,
  resolveGlobalRecipientSelector,
  resolveRecipientSelector,
} from "./recipient-prefix.ts";
import { claudeReceipt } from "./claude-receipt.ts";
import { resolveClaudeTarget } from "./claude-target.ts";
import {
  relayCheckCommand,
  relayEvidence,
  relayStatus,
} from "./relay-status.ts";

import { waitForReply } from "./wait.ts";

const unknownSender =
  "unknown (caller identity unavailable or inherited; use --from backend:<full-session-id>)";

function explicitSender(value: string): string | undefined {
  const match = /^(codex|claude):(.+)$/u.exec(value);
  const id = canonicalUuid(match?.[2] ?? "");
  return match === null || id === undefined ? undefined : `${match[1]}:${id}`;
}

function unknown(reason: string, output = "", relaySessionId?: string): number {
  process.stderr.write(
    `agx msg: acceptance unknown (${reason}); do not resend without checking\n`,
  );
  if (relaySessionId !== undefined) {
    const evidence = relayEvidence(output);
    const session = evidence.sessionId ?? relaySessionId;
    process.stderr.write(
      `agx msg: evidence: msg_id=${JSON.stringify(evidence.msgIds)} relay_session_id=${JSON.stringify(session)}\n` +
        `agx msg: check before any resend: ${relayCheckCommand(session)}\n`,
    );
  }
  return 4;
}

function claudePrompt(target: string, message: string): string {
  return [
    "Use ListAgents to find exactly one live Claude Code session matching the supplied identifier. If there is no exact unique match, do not send.",
    `Target: ${JSON.stringify(target)}`,
    `Send this exact text once using SendMessage: ${JSON.stringify(message)}`,
    "Do not retry or perform any other action. Your final text is not a delivery receipt; the caller inspects the tool result.",
  ].join("\n");
}

async function send(
  kind: "codex" | "claude",
  id: string,
  message: string,
  timeoutMs: number,
  sender: string,
  relayTarget = id,
): Promise<number> {
  // Headers precede the blank line; never parse or strip the caller's body.
  const destination =
    kind === "claude" && canonicalUuid(id) !== undefined
      ? `\nto: claude:${canonicalUuid(id)}`
      : "";
  message = `from: ${sender}${destination}\n\n${message}`;
  // Known even if the child times out before its first frame.
  const relaySessionId = kind === "claude" ? crypto.randomUUID() : undefined;
  const relaySender = sender === unknownSender ? "unknown" : sender;
  const args =
    kind === "codex"
      ? ["queue", "--thread", id, "--message", message]
      : [
          "--print",
          "--name",
          `agx msg relay from ${relaySender}`,
          "--session-id",
          relaySessionId ?? "",
          "--model",
          "haiku",
          "--effort",
          "low",
          "--tools=ListAgents,SendMessage",
          "--allowedTools=ListAgents,SendMessage",
          "--output-format",
          "stream-json",
          "--verbose",
          claudePrompt(relayTarget, message),
        ];
  const timeout = AbortSignal.timeout(timeoutMs);
  const spawned = await attempt(() =>
    Bun.spawn([kind, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      signal: timeout,
      killSignal: "SIGKILL",
    }),
  );
  if (!spawned.ok) {
    process.stderr.write(
      `agx msg: transport unreachable: cannot start ${kind}: ${errorMessage(spawned.error)}\n`,
    );
    return 3;
  }
  const child = spawned.value;
  const result = await attempt(() =>
    Promise.all([child.exited, child.stdout.text()]),
  );
  if (!result.ok)
    return unknown(errorMessage(result.error), "", relaySessionId);
  const [code, output] = result.value;
  const capturePath = process.env.XMSG_RELAY_CAPTURE;
  if (kind === "claude" && capturePath !== undefined) {
    const captured = await attempt(() => Bun.write(capturePath, output));
    if (!captured.ok)
      process.stderr.write(
        `agx msg: relay capture failed: ${errorMessage(captured.error)}\n`,
      );
  }
  if (timeout.aborted)
    return unknown(`timed out after ${timeoutMs} ms`, output, relaySessionId);
  if (kind === "codex") {
    if (code !== 0) {
      process.stderr.write(
        `agx msg: codex transport rejected the request (exit ${code})\n`,
      );
      return 1;
    }
    process.stdout.write(
      output === "" ? `agx msg: accepted for codex:${id}\n` : output,
    );
    return 0;
  }
  const receipt = claudeReceipt(output, message);
  if (code !== 0)
    return unknown(
      `Claude relay process exited ${code}; inspect the Claude stderr above and check the recipient`,
      output,
      relaySessionId,
    );
  if (receipt?.accepted === "no-send") {
    process.stderr.write(
      `agx msg: no SendMessage attempted; Claude relay step failed: ${receipt.step} for claude:${JSON.stringify(id)} (process exit 0)\n` +
        `agx msg: evidence: ${receipt.evidence}\n` +
        (receipt.step === "target resolution / SendMessage invocation"
          ? "agx msg: ListAgents completed but the relay did not select and send to a unique peer. Session UUIDs from claude agents --json may not appear in ListAgents. Verify the intended peer's exact native name with ListAgents in Claude; if uniquely identified, use agx msg send --to 'claude:<exact-native-name>'. Do not guess from a similar name.\n"
          : "agx msg: inspect Claude's tool availability and permissions for ListAgents and SendMessage; run ListAgents in Claude to check the intended peer before trying again.\n"),
    );
    return 3;
  }
  if (receipt?.accepted === false) {
    process.stderr.write("agx msg: SendMessage rejected the request\n");
    return 1;
  }
  if (receipt === undefined)
    return unknown(
      "no confirmed SendMessage tool_result",
      output,
      relaySessionId,
    );
  process.stdout.write(
    `agx msg: accepted for claude:${id} msg_id=${receipt.msgId}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const parse = standardCli(cli, { version: packageJson.version }, () => [
    ...argv,
  ]);
  const parsed = await attempt(() =>
    parse({
      name: "agx msg",
      parameters: ["[action]"],
      strictFlags: true,
      ignoreArgv(type, flag) {
        if (type !== "unknown-flag") return;
        process.stderr.write(`agx msg: unknown flag ${flag}\n`);
        process.exit(2);
      },
      flags: {
        timing: {
          type: Boolean,
          description:
            "Print discovery and transport elapsed milliseconds to stderr (send only)",
        },
        json: {
          type: Boolean,
          description: "Machine-readable recipient inventory (list only)",
        },
        to: {
          type: String,
          description:
            "Recipient: [codex:|claude:]<UUID, UUID prefix or exact native name>; unqualified requires both inventories",
        },
        from: {
          type: String,
          description:
            "Authoritative envelope sender: codex:<full-UUID> or claude:<full-UUID>; overrides explicit AGX_MSG_FROM declaration",
        },
        relay: {
          type: String,
          description:
            "Relay session UUID to inspect without sending (status only)",
        },
        message: {
          type: String,
          description: "Exact body below the sender envelope",
        },
        timeoutMs: {
          type: Number,
          default: 60_000,
          description: "Send/discovery/wait deadline in milliseconds",
        },
      },
      help: {
        description:
          "Wait for exact reply input with agx msg wait --to codex:<full-UUID> --from backend:<full-UUID> --message TEXT [--timeout-ms N] (0 observed, 3 unobservable, 4 deadline; Claude inbox unsupported). List recipients with agx msg list [--json], send once with agx msg send, or inspect a Claude relay with agx msg status --relay <session-UUID>. Sender: --from > AGX_MSG_FROM > recorded AGX_RUN_ID session > unknown; never infer native session variables. The envelope from: line is caller attribution, not authentication. Claude from-name is relay transport, named agx msg relay from <sender or unknown>. List exits 0 complete, 3 incomplete. Send/status exit: 0 accepted, 1 rejected, 2 usage, 3 unreachable, 4 acceptance unknown.",
      },
    }),
  );
  if (!parsed.ok) {
    process.stderr.write(`agx msg: ${errorMessage(parsed.error)}\n`);
    return 2;
  }
  const args = parsed.value;
  if (args._.action === "wait") {
    const recipient = explicitSender(args.flags.to ?? "");
    const sender = explicitSender(args.flags.from ?? "");
    if (
      recipient === undefined ||
      sender === undefined ||
      args.flags.message === undefined ||
      args.flags.message.length === 0 ||
      args._.length !== 1 ||
      args.flags.json !== undefined ||
      args.flags.timing !== undefined ||
      args.flags.relay !== undefined ||
      !Number.isInteger(args.flags.timeoutMs) ||
      args.flags.timeoutMs < 1 ||
      args.flags.timeoutMs > 2_147_483_647
    ) {
      process.stderr.write(
        "agx msg: usage: agx msg wait --to backend:<full-UUID> --from backend:<full-UUID> --message TEXT [--timeout-ms N]\n",
      );
      return 2;
    }
    return waitForReply(
      recipient,
      sender,
      args.flags.message,
      args.flags.timeoutMs,
    );
  }
  if (args._.action === "status") {
    const session = canonicalUuid(args.flags.relay ?? "");
    if (
      session === undefined ||
      args._.length !== 1 ||
      args.flags.timing !== undefined ||
      args.flags.to !== undefined ||
      args.flags.from !== undefined ||
      args.flags.message !== undefined ||
      args.flags.json !== undefined
    ) {
      process.stderr.write(
        "agx msg: usage: agx msg status --relay <session-UUID>\n",
      );
      return 2;
    }
    return relayStatus(session);
  }
  if (args._.action === "list") {
    if (
      args.flags.timing !== undefined ||
      args._.length !== 1 ||
      args.flags.to !== undefined ||
      args.flags.from !== undefined ||
      args.flags.message !== undefined ||
      args.flags.relay !== undefined ||
      !Number.isInteger(args.flags.timeoutMs) ||
      args.flags.timeoutMs < 1 ||
      args.flags.timeoutMs > 2_147_483_647
    ) {
      process.stderr.write(
        "agx msg: usage: agx msg list [--json] [--timeout-ms N]\n",
      );
      return 2;
    }
    return listRecipients(args.flags.json ?? false, args.flags.timeoutMs);
  }
  const match = /^(codex|claude):(.+)$/u.exec(args.flags.to ?? "");
  let kind = match?.[1];
  const selector = args.flags.to;
  const id = match?.[2] ?? selector;
  const message = args.flags.message;
  const timeoutMs = args.flags.timeoutMs;
  if (
    args._.action !== "send" ||
    args.flags.json !== undefined ||
    args.flags.relay !== undefined ||
    args._.length !== 1 ||
    (kind === undefined && selector?.includes(":") === true) ||
    id === undefined ||
    id === "" ||
    id.trim() !== id ||
    message === undefined ||
    message.length === 0 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    process.stderr.write(
      "agx msg: usage: agx msg send --to [codex:|claude:]<UUID|UUID-prefix|exact-name> --message TEXT [--from backend:<full-session-UUID>] [--timeout-ms N]\n",
    );
    return 2;
  }
  const declaration = args.flags.from ?? process.env.AGX_MSG_FROM;
  const runSender =
    declaration === undefined && process.env.AGX_RUN_ID !== undefined
      ? await (
          await import("../../agx-worker/src/next/message-sender.ts")
        ).runMessageSender(process.env.AGX_RUN_ID)
      : undefined;
  const sender =
    declaration === undefined
      ? (explicitSender(runSender ?? "") ?? unknownSender)
      : explicitSender(declaration);
  if (sender === undefined) {
    process.stderr.write(
      `agx msg: invalid ${args.flags.from === undefined ? "AGX_MSG_FROM" : "--from"}; use codex:<full-session-UUID> or claude:<full-session-UUID> (no prefixes or names)\n`,
    );
    return 2;
  }
  const started = performance.now();
  const deadline = started + timeoutMs;
  let target = canonicalUuid(id) ?? id;
  let claudeSnapshot: Awaited<ReturnType<typeof selectedInventory>> | undefined;
  if (kind === undefined) {
    const inventories = await Promise.all([
      selectedInventory(
        "codex",
        Math.max(1, Math.floor(deadline - performance.now())),
      ),
      selectedInventory(
        "claude",
        Math.max(1, Math.floor(deadline - performance.now())),
      ),
    ]);
    const resolution = resolveGlobalRecipientSelector(
      id,
      inventories.flatMap((inventory) => inventory.recipients),
      inventories.map((inventory) => inventory.evidence),
    );
    if (!resolution.ok) {
      process.stderr.write(`agx msg: ${resolution.reason}\n`);
      process.stderr.write(
        resolution.candidates
          .toSorted((a, b) => a.address.localeCompare(b.address))
          .map(
            (candidate) =>
              `${candidate.address}\tname=${JSON.stringify(candidate.name)}\n`,
          )
          .join(""),
      );
      return resolution.error === "discovery-unavailable" ? 3 : 2;
    }
    kind = resolution.recipient.vendor;
    target = resolution.recipient.id;
    claudeSnapshot = inventories[1];
  } else if (canonicalUuid(id) === undefined && /^[0-9a-f-]+$/iu.test(id)) {
    if (kind !== "codex" && kind !== "claude") return 2;
    const inventory = await selectedInventory(kind, timeoutMs);
    const { recipients, evidence } = inventory;
    if (kind === "claude") claudeSnapshot = inventory;
    const resolution = resolveRecipientSelector(
      `${kind}:${id}`,
      recipients,
      evidence,
    );
    if (!resolution.ok) {
      process.stderr.write(`agx msg: ${resolution.reason}\n`);
      process.stderr.write(
        resolution.candidates
          .toSorted((a, b) => a.address.localeCompare(b.address))
          .map(
            (candidate) =>
              `${candidate.address}\tname=${JSON.stringify(candidate.name)}\n`,
          )
          .join(""),
      );
      return evidence.available ? 2 : 3;
    }
    target = canonicalUuid(resolution.recipient.id) ?? resolution.recipient.id;
  }
  let relayTarget = target;
  const uuid = canonicalUuid(target);
  if (kind === "claude" && uuid !== undefined) {
    const resolved = await resolveClaudeTarget(
      uuid,
      Math.max(1, Math.floor(deadline - performance.now())),
      claudeSnapshot,
    );
    if (!resolved.ok) {
      process.stderr.write(`agx msg: ${resolved.reason}\n`);
      return 3;
    }
    relayTarget = resolved.name;
  }
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) {
    process.stderr.write(
      "agx msg: discovery exhausted the send deadline; no send attempted\n",
    );
    return 3;
  }
  if (kind !== "codex" && kind !== "claude") return 2;
  const transportStarted = performance.now();
  const outcome = await send(
    kind,
    target,
    message,
    remaining,
    sender,
    relayTarget,
  );
  if (args.flags.timing === true) {
    process.stderr.write(
      JSON.stringify({
        timing: "agx msg send",
        backend: kind,
        discoveryMs: Math.round(transportStarted - started),
        transportMs: Math.round(performance.now() - transportStarted),
        totalMs: Math.round(performance.now() - started),
        transport:
          kind === "claude"
            ? "one-shot claude --print model relay"
            : "codex queue",
        exit: outcome,
      }) + "\n",
    );
  }
  return outcome;
}

if (import.meta.main) {
  const result = await attempt(main);
  process.exitCode = result.ok
    ? result.value
    : unknown(errorMessage(result.error));
}
