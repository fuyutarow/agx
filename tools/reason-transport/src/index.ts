import { fromThrowable } from "neverthrow";
import { spawn } from "node:child_process";
import { jsonOf, z } from "../../zod.ts";

export type Failure =
  | { kind: "refused"; text: string }
  | { kind: "unavailable"; text: string }
  | { kind: "usage"; text: string }
  | { kind: "unknown"; text: string };
export type Outcome<T> = { kind: "accepted"; value: T } | Failure;

// The send result is the only Reason Network prose agx interprets: render.rs:45,159-182.
export function parseProse(_kind: "send", text: string): string[] | undefined {
  const ids = [
    ...text.matchAll(/^message id ([0-9A-HJKMNP-TV-Z]{26})\r?$/gmu),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  return ids.length === 1 ? ids : undefined;
}

const textOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const validDeadline = (value: number) =>
  Number.isFinite(value) && value > 0 && value <= 2_147_483_647;

const directory = z.object({
  sessions: z.array(z.object({ address: z.string(), is_me: z.boolean() })),
});

/** Resolve a vendor session without registering it or opening an MCP connection. */
export async function lookupAddress(options: {
  binary: string;
  vendor: string;
  session: string;
  deadlineMs: number;
}): Promise<Outcome<string>> {
  if (
    options?.binary === undefined ||
    options.binary.length === 0 ||
    options.vendor === undefined ||
    options.vendor.length === 0 ||
    options.session === undefined ||
    options.session.length === 0 ||
    !validDeadline(options.deadlineMs)
  )
    return {
      kind: "usage",
      text: "binary, vendor, session and a positive deadlineMs are required",
    };
  let agent: string | undefined;
  if (options.vendor === "claude") agent = "claude-code";
  if (options.vendor === "codex") agent = "codex";
  if (agent === undefined)
    return { kind: "usage", text: "vendor must be claude or codex" };
  const started = fromThrowable(
    () =>
      spawn(options.binary, ["who", "--json"], {
        env: {
          ...process.env,
          REASON_NETWORK_AGENT: agent,
          REASON_NETWORK_SESSION: options.session,
        },
        stdio: "pipe",
        detached: true,
      }),
    textOf,
  )();
  if (started.isErr()) return { kind: "unavailable", text: started.error };
  const child = started.value;
  child.stdin.end();
  child.stderr.resume();
  child.on("exit", () => {
    if (child.pid !== undefined)
      fromThrowable(() => process.kill(-child.pid!, "SIGKILL"), textOf)();
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  return new Promise((resolve) => {
    let timedOut = false;
    let error: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined)
        fromThrowable(() => process.kill(-child.pid!, "SIGKILL"), textOf)();
      child.kill("SIGKILL");
    }, options.deadlineMs);
    child.on("error", (cause) => {
      error = textOf(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ kind: "unknown", text: "who deadline expired" });
        return;
      }
      if (error !== undefined || code !== 0) {
        resolve({
          kind: "unavailable",
          text: error ?? `who exited with code ${code}`,
        });
        return;
      }
      const parsed = jsonOf(directory).safeParse(output);
      if (!parsed.success) {
        resolve({ kind: "unavailable", text: "invalid who JSON directory" });
        return;
      }
      const matches = parsed.data.sessions.filter((row) => row.is_me);
      if (matches.length === 0) {
        resolve({
          kind: "refused",
          text: "session is not registered or not live",
        });
        return;
      }
      if (matches.length > 1) {
        resolve({
          kind: "unknown",
          text: "multiple sessions identify as this session",
        });
        return;
      }
      resolve({ kind: "accepted", value: matches[0]!.address });
    });
  });
}
