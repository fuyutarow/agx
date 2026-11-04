import { afterEach, expect, test } from "bun:test";
import {
  BOUND_CLAUDE_TARGET_ENV,
  encodeBoundClaudeTarget,
} from "../../xmsg/src/claude-target.ts";
import { renderPromise } from "../src/next/run.ts";
import { parseNextTicket } from "../src/next/ticket.ts";

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
Send a completion ACK to the coordinator.
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
    "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    route,
  );
};

const saved = {
  bound: process.env[BOUND_CLAUDE_TARGET_ENV],
  unbound: process.env.AGX_DISPATCH_ACK_UNBOUND,
};
const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
afterEach(() => {
  restore(BOUND_CLAUDE_TARGET_ENV, saved.bound);
  restore("AGX_DISPATCH_ACK_UNBOUND", saved.unbound);
});

const bind = (): void => {
  delete process.env.AGX_DISPATCH_ACK_UNBOUND;
  process.env[BOUND_CLAUDE_TARGET_ENV] = encodeBoundClaudeTarget({
    selector: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    address: "claude:dotfiles-agt_sd3n",
  });
};

test("a bound claude brief uses the end notice instead of an ACK", () => {
  bind();
  const claude = brief("claude");
  expect(claude).not.toContain("SendMessage");
  expect(claude).toContain(
    "Do not send a completion ACK, even if the ticket asks for one.",
  );
  expect(claude).toContain(
    "The agx-manager end notice is the completion notice",
  );
  expect(claude).toContain("$AGX_RUN_DIR/result.md");
});

test("an unbound claude brief uses the same completion notice", () => {
  delete process.env[BOUND_CLAUDE_TARGET_ENV];
  process.env.AGX_DISPATCH_ACK_UNBOUND = "1";
  const claude = brief("claude");
  expect(claude).not.toContain("SendMessage");
  expect(claude).toContain(
    "The agx-manager end notice is the completion notice",
  );
  expect(claude).toContain("$AGX_RUN_DIR/result.md");
  expect(claude).not.toContain("dotfiles-agt_sd3n");
});

test("codex briefs are unchanged by the ack line", () => {
  bind();
  const codex = brief("codex");
  expect(codex).not.toContain("SendMessage");
  expect(codex).not.toContain("dotfiles-agt_sd3n");
  expect(codex).toContain("Send a completion ACK to the coordinator.");
  const claude = brief("claude");
  const line = claude
    .split("\n")
    .find((l) => l.includes("agx-manager end notice"));
  expect(line).toBeDefined();
  expect(claude.replace(`${line}\n`, "")).toBe(codex);
});
