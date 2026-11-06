import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const command = process.argv[2];
const log = process.env.FAKE_LOG ?? "";
const record = (data: object) => appendFileSync(log, `${JSON.stringify(data)}\n`);
if (command === "who") {
  record({ command, agent: process.env.REASON_NETWORK_AGENT, session: process.env.REASON_NETWORK_SESSION });
  process.stdout.write(JSON.stringify({ sessions: process.env.FAKE_MODE === "unregistered" ? [] : [{ address: "alice/dispatcher@host", is_me: true }] }));
} else if (command === "status") {
  record({ command, agent: process.env.REASON_NETWORK_AGENT, session: process.env.REASON_NETWORK_SESSION, args: process.argv.slice(3) });
  if (process.env.FAKE_MODE === "rename-fails") { process.stderr.write("rename denied"); process.exitCode = 1; }
} else if (command === "mcp") {
  record({ command, agent: process.env.REASON_NETWORK_AGENT, session: process.env.REASON_NETWORK_SESSION, thread: process.env.CODEX_THREAD_ID });
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
    if (request.method === "tools/list") result = { tools: ["send_message", "message_status", "list_team"].map((name) => ({ name })) };
    if (request.method === "tools/call" && process.env.FAKE_DELAY_MS !== undefined) await Bun.sleep(Number(process.env.FAKE_DELAY_MS));
    if (request.method === "tools/call" && process.env.FAKE_MODE === "unknown") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "receipt unavailable" } })}\n`); continue; }
    if (request.method === "tools/call") {
      const key = request.params.arguments.idempotency_key;
      const marker = `${log}.${key}`;
      if (!existsSync(marker)) { writeFileSync(marker, "delivered"); record({ delivery: key }); }
      result = { content: [{ type: "text", text: "message id 01ARZ3NDEKTSV4RRFFQ69G5FAV\n" }] };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  }
}
