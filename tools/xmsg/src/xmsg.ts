#!/usr/bin/env bun
import { cli } from "cleye";
import { attempt, errorMessage } from "../../shared/src/attempt.ts";
import { standardCli } from "../../shared/src/cli.ts";
import { lookupAddress, parseProse } from "../../reason-transport/src/index.ts";
import packageJson from "../package.json" with { type: "json" };

const usage =
  "agx msg: usage: agx msg send --from <vendor>:<uuid> --to <vendor>:<uuid> --message <text> [--timeout-ms N]\n";
const addressPattern =
  /^(claude|codex):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

async function main(): Promise<number> {
  const parse = standardCli(cli, { version: packageJson.version }, () =>
    Bun.argv.slice(2),
  );
  const args = parse({
    name: "agx msg",
    parameters: ["[action]"],
    strictFlags: true,
    ignoreArgv(type, flag) {
      if (type === "unknown-flag") {
        process.stderr.write(`agx msg: unknown flag ${flag}\n`);
        process.exit(2);
      }
    },
    flags: {
      from: { type: String, description: "Sender vendor:full-UUID" },
      to: { type: String, description: "Recipient vendor:full-UUID" },
      message: { type: String, description: "Message text" },
      timeoutMs: {
        type: Number,
        default: 60_000,
        description: "Total deadline in milliseconds",
      },
    },
    help: {
      description:
        "Use agx msg send to deliver one message through Reason Network. Both sessions must be live and registered. Exits: 0 accepted, 2 usage, 3 unavailable or unregistered, 4 unknown.",
    },
  });
  const from = addressPattern.exec(args.flags.from ?? "");
  const to = addressPattern.exec(args.flags.to ?? "");
  const timeout = args.flags.timeoutMs;
  if (
    args._.action !== "send" ||
    args._.length !== 1 ||
    from === null ||
    to === null ||
    args.flags.message === undefined ||
    args.flags.message.length === 0 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 2_147_483_647
  ) {
    process.stderr.write(usage);
    return 2;
  }
  const binary = Bun.which("reason-network");
  if (binary === null) {
    process.stderr.write("agx msg: reason-network binary unavailable\n");
    return 3;
  }
  const deadline = performance.now() + timeout;
  const remaining = () => Math.floor(deadline - performance.now());
  for (const [side, match] of [
    ["sender", from],
    ["recipient", to],
  ] as const) {
    const left = remaining();
    if (left < 1) {
      process.stderr.write("agx msg: lookup deadline expired\n");
      return 4;
    }
    const result = await lookupAddress({
      binary,
      vendor: match[1]!,
      session: match[2]!,
      deadlineMs: left,
    });
    if (result.kind === "refused") {
      const value = match[0];
      process.stderr.write(
        side === "sender"
          ? `sender ${value} is not registered with Reason Network; call any Reason Network tool once in that session and retry\n`
          : `recipient ${value} is not registered with Reason Network or not live\n`,
      );
      return 3;
    }
    if (result.kind !== "accepted") {
      process.stderr.write(
        `agx msg: ${side} lookup ${result.kind}: ${result.text}\n`,
      );
      return result.kind === "unknown" ? 4 : 3;
    }
    if (side === "recipient")
      return send(binary, from, result.value, args.flags.message, remaining());
  }
  return 4;
}

async function send(
  binary: string,
  from: RegExpExecArray,
  address: string,
  message: string,
  remaining: number,
): Promise<number> {
  if (remaining < 1) {
    process.stderr.write(
      "acceptance unknown; do not resend without checking\n",
    );
    return 4;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, remaining);
  const result = await attempt(async () => {
    const child = Bun.spawn(
      [
        binary,
        "send",
        "--from",
        `${from[1] === "claude" ? "claude-code" : "codex"}:${from[2]}`,
        address,
        message,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      },
    );
    const [out, err, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    return { out, err, code };
  });
  clearTimeout(timer);
  if (!result.ok) {
    process.stderr.write(
      `acceptance unknown; do not resend without checking\n${errorMessage(result.error)}\n`,
    );
    return 4;
  }
  const { out, err, code } = result.value;
  const ids = parseProse("send", out);
  if (!controller.signal.aborted && code === 0 && ids !== undefined) {
    process.stdout.write(`accepted message id ${ids[0]}\n`);
    return 0;
  }
  process.stderr.write(
    `acceptance unknown; do not resend without checking\n${out}${err}`,
  );
  return 4;
}

if (import.meta.main) {
  const result = await attempt(main);
  if (result.ok) process.exitCode = result.value;
  else {
    process.stderr.write(`agx msg: ${errorMessage(result.error)}\n`);
    process.exitCode = 2;
  }
}
