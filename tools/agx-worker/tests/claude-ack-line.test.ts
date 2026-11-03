import { expect, test } from "bun:test";
import { renderPromise } from "../src/next/run.ts";
import { parseNextTicket } from "../src/next/ticket.ts";
import { claudeAckLine } from "../src/ticket.ts";

const source = `+++
schema = 2
name = "ack-line"
writes = []
outcome = "fixture"
verify = ["true"]
[proposition]
id = "ACK-LINE"
claim = "route decides the ack line"
refuted_by = "wrong brief"
+++
body
`;

const brief = (route: "claude" | "codex"): string => {
  const parsed = parseNextTicket(source);
  if (!parsed.success) return expect.unreachable(parsed.reason);
  return renderPromise(
    parsed.ticket,
    "/work",
    "workspace-write",
    parsed.prose,
    "/run",
    undefined,
    "claude:coordinator",
    route,
  );
};

test("ack route contract: only the claude-route brief tells the worker to use SendMessage", () => {
  const claude = brief("claude");
  const codex = brief("codex");
  expect(claude).toContain(claudeAckLine);
  expect(claude).toContain("SendMessage");
  expect(codex).not.toContain(claudeAckLine);
  expect(codex).not.toContain("SendMessage");
  // No other brief text changes: removing the line yields the codex brief.
  expect(claude.replace(`${claudeAckLine}\n`, "")).toBe(codex);
});
