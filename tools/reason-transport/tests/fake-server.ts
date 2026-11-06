#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { jsonOf, z } from "../../zod.ts";

const request = z.object({ id: z.number().optional(), method: z.string(), params: z.object({ name: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional() }).optional() });
const sent = new Map<string, string>();
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const parsed = jsonOf(request).safeParse(line);
  if (!parsed.success || parsed.data.id === undefined) continue;
  const { id, method, params } = parsed.data;
  let result: unknown = {};
  if (method === "initialize" && process.env.REASON_NETWORK_SESSION === "failed-initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { message: "initialization failed" } })}\n`);
    continue;
  }
  if (method === "tools/list") result = { tools: (process.env.REASON_NETWORK_SESSION === "missing-tool" ? ["send_message"] : ["send_message", "message_status", "list_team"]).map((name) => ({ name })) };
  if (method === "tools/call") {
    const mode = process.env.REASON_NETWORK_SESSION;
    if (mode?.startsWith("calls:")) appendFileSync(mode.slice(6), "call\n");
    if (mode === "deadline") continue;
    if (mode === "disconnect") process.exit(0);
    let text = "";
    let isError = false;
    if (params?.name === "send_message") {
      if (mode === "refused") { text = "Your user turned Reason Network off for this folder"; isError = true; }
      else if (mode === "ambiguous") { text = "no answer from the network daemon in 30s"; isError = true; }
      else if (mode === "no-id") text = "→ alice/test@box: queued\n";
      else {
        const key = String(params?.arguments?.idempotency_key);
        if (!sent.has(key)) sent.set(key, sent.size === 0 ? "01ARZ3NDEKTSV4RRFFQ69G5FAV" : "01ARZ3NDEKTSV4RRFFQ69G5FAW");
        text = `→ alice/test@box: queued\nmessage id ${sent.get(key)}\n`;
      }
    }
    if (params?.name === "message_status") text = '{"receipts":[{"status":"accepted"}]}';
    if (params?.name === "list_team") text = `no team yet (this machine only) · you are alice on box\nalice · box · this machine\n  ${mode}  agent  live  -  pull · ← you\n`;
    if (process.env.REASON_NETWORK_NO_UPDATE !== "1") { text = "missing no-update"; isError = true; }
    result = { isError, content: [{ type: "text", text }] };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
