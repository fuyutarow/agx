import { fromThrowable } from "neverthrow";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { jsonOf, z } from "../../zod.ts";

export type Failure =
  | { kind: "refused"; text: string }
  | { kind: "unavailable"; text: string }
  | { kind: "usage"; text: string }
  | { kind: "unknown"; text: string };
export type Outcome<T> = { kind: "accepted"; value: T } | Failure;

type Reply = { result?: unknown; error?: { message: string } | undefined };
const envelope = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });
const toolsResult = z.object({ tools: z.array(z.object({ name: z.string() })) });
const callResult = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
const statusResult = z.json();

// All Reason Network prose is interpreted here: render.rs:45,159-182,239-247.
export function parseProse(kind: "send", text: string): string[] | undefined;
export function parseProse(kind: "address", text: string): string | undefined;
export function parseProse(kind: "status", text: string): z.infer<typeof statusResult> | undefined;
export function parseProse(kind: "send" | "address" | "status", text: string): unknown {
  if (kind === "send") {
    const ids = [...text.matchAll(/^message id ([0-9A-HJKMNP-TV-Z]{26})\r?$/gmu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
    return ids.length === 1 ? ids : undefined;
  }
  if (kind === "address") {
    const header = /^.* · you are (\S+) on (\S+)\r?$/mu.exec(text);
    const names = [...text.matchAll(/^  (\S+)\s{2,}.* · ← you\r?$/gmu)];
    const person = header?.[1];
    const machine = header?.[2];
    const name = names[0]?.[1];
    return person !== undefined && machine !== undefined && name !== undefined && names.length === 1 ? `${person}/${name}@${machine}` : undefined;
  }
  const first = text.split("\n")[0];
  if (first === undefined) return undefined;
  const parsed = jsonOf(statusResult).safeParse(first);
  return parsed.success ? parsed.data : undefined;
}

const beforeSend = new Set([
  // mcp.rs:390-392; config.rs:39.
  "Your user turned Reason Network off for this folder",
]);
const textOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const validDeadline = (value: number) => Number.isFinite(value) && value > 0 && value <= 2_147_483_647;

const directory = z.object({ sessions: z.array(z.object({ address: z.string(), is_me: z.boolean() })) });

/** Resolve a vendor session without registering it or opening an MCP connection. */
export async function lookupAddress(options: { binary: string; vendor: string; session: string; deadlineMs: number }): Promise<Outcome<string>> {
  if (options?.binary === undefined || options.binary.length === 0 || options.vendor === undefined || options.vendor.length === 0 || options.session === undefined || options.session.length === 0 || !validDeadline(options.deadlineMs)) return { kind: "usage", text: "binary, vendor, session and a positive deadlineMs are required" };
  let agent: string | undefined;
  if (options.vendor === "claude") agent = "claude-code";
  if (options.vendor === "codex") agent = "codex";
  if (agent === undefined) return { kind: "usage", text: "vendor must be claude or codex" };
  const started = fromThrowable(() => spawn(options.binary, ["who", "--json"], { env: { ...process.env, REASON_NETWORK_AGENT: agent, REASON_NETWORK_SESSION: options.session }, stdio: "pipe", detached: true }), textOf)();
  if (started.isErr()) return { kind: "unavailable", text: started.error };
  const child = started.value;
  child.stdin.end();
  child.stderr.resume();
  child.on("exit", () => { if (child.pid !== undefined) fromThrowable(() => process.kill(-child.pid!, "SIGKILL"), textOf)(); });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  return new Promise((resolve) => {
    let timedOut = false;
    let error: string | undefined;
    const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) fromThrowable(() => process.kill(-child.pid!, "SIGKILL"), textOf)(); child.kill("SIGKILL"); }, options.deadlineMs);
    child.on("error", (cause) => { error = textOf(cause); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ kind: "unknown", text: "who deadline expired" }); return; }
      if (error !== undefined || code !== 0) { resolve({ kind: "unavailable", text: error ?? `who exited with code ${code}` }); return; }
      const parsed = jsonOf(directory).safeParse(output);
      if (!parsed.success) { resolve({ kind: "unavailable", text: "invalid who JSON directory" }); return; }
      const matches = parsed.data.sessions.filter((row) => row.is_me);
      if (matches.length === 0) { resolve({ kind: "refused", text: "session is not registered or not live" }); return; }
      if (matches.length > 1) { resolve({ kind: "unknown", text: "multiple sessions identify as this session" }); return; }
      resolve({ kind: "accepted", value: matches[0]!.address });
    });
  });
}

export class Session {
  private next = 0;
  private pending = new Map<number, (reply: Reply | undefined) => void>();
  private closed = false;
  private constructor(private child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const parsed = jsonOf(envelope).safeParse(line);
      if (!parsed.success || parsed.data.id === undefined) return;
      const resolve = this.pending.get(parsed.data.id);
      if (resolve !== undefined) { this.pending.delete(parsed.data.id); resolve(parsed.data); }
    });
    child.stderr.resume();
    const close = () => {
      this.closed = true;
      for (const resolve of this.pending.values()) resolve(undefined);
      this.pending.clear();
    };
    child.on("error", close);
    child.on("close", close);
    child.stdin.on("error", close);
  }

  static async open(options: { binary: string; session: string; deadlineMs: number }): Promise<Outcome<Session>> {
    if (options?.binary === undefined || options.binary.length === 0 || options.session === undefined || options.session.length === 0 || !validDeadline(options.deadlineMs)) return { kind: "usage", text: "binary, session and a positive deadlineMs are required" };
    const started = fromThrowable(() => spawn(options.binary, ["mcp"], { env: { ...process.env, REASON_NETWORK_AGENT: "reason", REASON_NETWORK_SESSION: options.session, REASON_NETWORK_NO_UPDATE: "1" }, stdio: "pipe", detached: true }), textOf)();
    if (started.isErr()) return { kind: "unavailable", text: started.error };
    if (started.value.pid === undefined) { started.value.on("error", () => {}); return { kind: "unavailable", text: "MCP process could not start" }; }
    const session = new Session(started.value);
    const deadlineAt = performance.now() + options.deadlineMs;
    const remaining = () => Math.max(1, Math.floor(deadlineAt - performance.now()));
    const init = await session.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reason-agx-transport", version: "1.22.107" } }, remaining());
    if (init === undefined) { session.close(); return { kind: "unknown", text: "MCP initialization reply unavailable or deadline expired" }; }
    if (init.error !== undefined) { session.close(); return { kind: "unavailable", text: init.error.message }; }
    session.notify("notifications/initialized");
    if (performance.now() >= deadlineAt) { session.close(); return { kind: "unavailable", text: "MCP initialization deadline expired" }; }
    const listed = await session.request("tools/list", {}, remaining());
    if (listed === undefined) { session.close(); return { kind: "unknown", text: "MCP tools/list reply unavailable or deadline expired" }; }
    const checked = toolsResult.safeParse(listed.result);
    if (!checked.success || !["send_message", "message_status", "list_team"].every((name) => checked.data.tools.some((tool) => tool.name === name))) {
      session.close(); return { kind: "unavailable", text: "required MCP tool missing or tools/list failed" };
    }
    return { kind: "accepted", value: session };
  }

  close(): void { if (this.child.pid !== undefined) fromThrowable(() => process.kill(-this.child.pid!, "SIGKILL"), textOf)(); this.child.kill("SIGKILL"); }
  private notify(method: string): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
  private async request(method: string, params: object, deadlineMs: number): Promise<Reply | undefined> {
    if (this.closed || !validDeadline(deadlineMs)) return undefined;
    const id = ++this.next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(undefined); }, deadlineMs);
      this.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error !== null && error !== undefined) { const done = this.pending.get(id); this.pending.delete(id); done?.(undefined); }
      });
    });
  }
  private async call(name: string, args: object, deadlineMs: number): Promise<Outcome<string>> {
    if (!validDeadline(deadlineMs)) return { kind: "usage", text: "a positive deadlineMs is required" };
    const reply = await this.request("tools/call", { name, arguments: args }, deadlineMs);
    if (reply === undefined) return { kind: "unknown", text: "MCP reply unavailable or deadline expired" };
    if (reply.error !== undefined) return { kind: "unknown", text: reply.error.message };
    const result = callResult.safeParse(reply.result);
    if (!result.success) return { kind: "unknown", text: "invalid MCP tool result" };
    const text = result.data.content.map((block) => block.text ?? "").join("\n");
    if (result.data.isError === true) return { kind: beforeSend.has(text) ? "refused" : "unknown", text };
    return { kind: "accepted", value: text };
  }
  async send(input: { to: string; message: string; idempotencyKey: string; deadlineMs: number }): Promise<Outcome<string[]>> {
    if (input?.to === undefined || input.to.length === 0 || input.message === undefined || input.message.length === 0 || input.idempotencyKey === undefined || input.idempotencyKey.length === 0) return { kind: "usage", text: "to, message and idempotencyKey are required" };
    const result = await this.call("send_message", { to: input.to, message: input.message, idempotency_key: input.idempotencyKey }, input.deadlineMs);
    if (result.kind !== "accepted") return result;
    const ids = parseProse("send", result.value);
    return Array.isArray(ids) && ids.length > 0 ? { kind: "accepted", value: ids } : { kind: "unknown", text: result.value };
  }
  async status(ids: string[], deadlineMs: number): Promise<Outcome<unknown>> {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || id.length === 0)) return { kind: "usage", text: "message ids are required" };
    const result = await this.call("message_status", { ids }, deadlineMs);
    if (result.kind !== "accepted") return result;
    const value = parseProse("status", result.value);
    return value === undefined ? { kind: "unknown", text: result.value } : { kind: "accepted", value };
  }
  async address(deadlineMs: number): Promise<Outcome<string>> {
    const result = await this.call("list_team", {}, deadlineMs);
    if (result.kind !== "accepted") return result;
    const value = parseProse("address", result.value);
    return typeof value === "string" ? { kind: "accepted", value } : { kind: "unknown", text: result.value };
  }
}
