import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const command = process.argv[2];
const log = process.env.FAKE_LOG ?? "";
const record = (data: object) => appendFileSync(log, `${JSON.stringify(data)}\n`);
// The daemon's live registry: key -> session name. A session is in it only after its MCP process made a tool call
// (mcp.rs `session_for` -> `session`), and registers under `<repo>-<agent>` (agent.rs `default_name`), never under
// REASON_NETWORK_SESSION (mcp.rs:440 `name: None`).
const registryFile = `${log}.registry`;
const registry = (): Record<string, string> => (existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, "utf8")) : {});
const keyOf = () => `${process.env.REASON_NETWORK_AGENT}:${process.env.REASON_NETWORK_SESSION}`;
const register = () => { const live = registry(); const key = keyOf(); if (live[key] === undefined) { live[key] = "fuyu-reason"; writeFileSync(registryFile, JSON.stringify(live)); } return live[key]; };
if (command === "who") {
  record({ command, agent: process.env.REASON_NETWORK_AGENT, session: process.env.REASON_NETWORK_SESSION });
  process.stdout.write(JSON.stringify({ sessions: process.env.FAKE_MODE === "unregistered" ? [] : [{ address: "alice/dispatcher@host", is_me: true }] }));
} else if (command === "status") {
  const live = registry();
  const key = keyOf();
  const name = process.argv[3] === "--name" ? process.argv[4] : undefined;
  record({ command, agent: process.env.REASON_NETWORK_AGENT, session: process.env.REASON_NETWORK_SESSION, args: process.argv.slice(3), registered: live[key] !== undefined });
  if (live[key] === undefined) {
    // daemon/sessions.rs:298: `g.live.get_mut(key).ok_or_else(|| anyhow!("this session is not registered"))`
    process.stderr.write("this session is not registered"); process.exitCode = 1;
  } else if (process.env.FAKE_MODE === "rename-fails") { process.stderr.write("rename denied"); process.exitCode = 1; }
  else if (name !== undefined) { live[key] = name; writeFileSync(registryFile, JSON.stringify(live)); }
} else if (command === "mcp") {
  record({ command, agent: process.env.REASON_NETWORK_AGENT, session: process.env.REASON_NETWORK_SESSION, thread: process.env.CODEX_THREAD_ID });
  // A new MCP process is a new session: the previous run's registration ended with its process.
  const previous = registry(); delete previous[keyOf()]; writeFileSync(registryFile, JSON.stringify(previous));
  if (["hang", "hold-pipes"].includes(process.env.FAKE_MODE ?? "")) {
    const helper = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    record({ helper: helper.pid });
  }
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    record({ method: request.method, params: request.params });
    if (process.env.FAKE_MODE === "hang" && request.method === "tools/call") continue;
    if (process.env.FAKE_MODE === "hang-initialize" && request.method === "initialize") continue;
    let result: unknown = {};
    if (request.method === "tools/call" && request.params.name === "list_team") {
      if (process.env.FAKE_MODE === "list-fails") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "directory unavailable" }] } })}\n`); continue; }
      const name = register();
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: `team · you are alice on host\n  ${name}  reason · ← you\n` }] } })}\n`);
      continue;
    }
    if (request.method === "tools/list") result = { tools: ["send_message", "message_status", "list_team"].map((name) => ({ name })) };
    if (request.method === "tools/call" && process.env.FAKE_DELAY_MS !== undefined) await Bun.sleep(Number(process.env.FAKE_DELAY_MS));
    if (request.method === "tools/call" && process.env.FAKE_MODE === "unknown") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "receipt unavailable" } })}\n`); continue; }
    if (request.method === "tools/call") {
      record({ sentFrom: register() });
      const key = request.params.arguments.idempotency_key;
      const marker = `${log}.${key}`;
      if (!existsSync(marker)) { writeFileSync(marker, "delivered"); record({ delivery: key }); }
      result = { content: [{ type: "text", text: "message id 01ARZ3NDEKTSV4RRFFQ69G5FAV\n" }] };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  }
}
