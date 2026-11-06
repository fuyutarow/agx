import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatcherIdentityFor,
  lookupDispatcher,
  renderPromise,
} from "../src/next/run.ts";
import { parseNextTicket } from "../src/next/ticket.ts";

const source = `+++
schema = 2
name = "ack-line"
writes = []
outcome = "fixture"
[proposition]
id = "ACK-LINE"
claim = "route decides the ack line"
refuted_by = "wrong brief"
+++
Do the work.
`;
const originalPath = process.env.PATH;
const roots: string[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fake(directory: string) {
  const root = mkdtempSync(join(tmpdir(), "reason-brief-"));
  roots.push(root);
  const binary = join(root, "reason-network");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${directory}'\n`);
  chmodSync(binary, 0o755);
  process.env.PATH = root;
}
function brief(
  route: string,
  result: Awaited<ReturnType<typeof lookupDispatcher>>,
) {
  const parsed = parseNextTicket(source);
  if (!parsed.success) return expect.unreachable(parsed.reason);
  return renderPromise(
    parsed.ticket,
    "/work",
    "workspace-write",
    parsed.prose,
    "/run",
    undefined,
    result,
    route,
  );
}
test("accepted directory address alone is used in Codex brief", async () => {
  fake('{"sessions":[{"address":"alice/coordinator@host","is_me":true}]}');
  const result = await lookupDispatcher("claude:fixture");
  expect(result).toEqual({ kind: "accepted", value: "alice/coordinator@host" });
  expect(brief("codex", result)).toContain(
    "send_message to alice/coordinator@host",
  );
  expect(brief("codex", result)).toContain("address goes stale");
  expect(brief("claude", result)).not.toContain("completion ACK");
});
test("refused and unavailable lookups do not request ACK", async () => {
  fake('{"sessions":[]}');
  const refused = await lookupDispatcher("codex:fixture");
  expect(refused.kind).toBe("refused");
  expect(brief("codex", refused)).toContain(
    "No completion ACK: the run-end notice reports the end.",
  );
  process.env.PATH = join(tmpdir(), "missing-reason-path");
  const unavailable = await lookupDispatcher("codex:fixture");
  expect(unavailable.kind).toBe("unavailable");
  expect(brief("codex", unavailable)).not.toContain("send_message to");
});
test("qualified identity preserves raw session and prefers Codex thread", () => {
  expect(
    dispatcherIdentityFor("bare", { CLAUDE_CODE_SESSION_ID: "bare" }),
  ).toBe("claude:bare");
  expect(
    dispatcherIdentityFor("session", {
      CODEX_SESSION_ID: "session",
      CODEX_THREAD_ID: "thread",
    }),
  ).toBe("codex:thread");
});
