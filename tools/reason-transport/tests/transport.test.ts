import { expect, test } from "bun:test";
import { Session, parseProse } from "../src/index.ts";

const binary = new URL("./fake-server.ts", import.meta.url).pathname;
const deadlineMs = 3000;
async function opened(session: string) {
  const outcome = await Session.open({ binary, session, deadlineMs });
  if (outcome.kind !== "accepted") throw new Error(JSON.stringify(outcome));
  return outcome.value;
}

test("send, resend, status and session identity through stdio", async () => {
  const session = await opened("my-session");
  try {
    const input = { to: "alice/test@box", message: "hello", idempotencyKey: "same-key", deadlineMs };
    const first = await session.send(input);
    expect(first).toEqual({ kind: "accepted", value: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] });
    expect(await session.send(input)).toEqual(first);
    expect(await session.send({ ...input, idempotencyKey: "another-key" })).toEqual({ kind: "accepted", value: ["01ARZ3NDEKTSV4RRFFQ69G5FAW"] });
    expect(await session.status(["01ARZ3NDEKTSV4RRFFQ69G5FAV"], deadlineMs)).toEqual({ kind: "accepted", value: { receipts: [{ status: "accepted" }] } });
    expect(await session.address(deadlineMs)).toEqual({ kind: "accepted", value: "alice/my-session@box" });
  } finally { session.close(); }
});

test("pre-dispatch refusal and ambiguous error are distinct", async () => {
  for (const [mode, kind] of [["refused", "refused"], ["ambiguous", "unknown"], ["no-id", "unknown"]] as const) {
    const session = await opened(mode);
    try { expect((await session.send({ to: "alice/test", message: "hello", idempotencyKey: "same-key", deadlineMs })).kind).toBe(kind); }
    finally { session.close(); }
  }
});

test("missing binary, missing inputs and deadline", async () => {
  expect((await Session.open({ binary: "/no/such/reason-binary", session: "x", deadlineMs })).kind).toBe("unavailable");
  expect((await Session.open({ binary, session: "", deadlineMs })).kind).toBe("unavailable");
  expect((await Session.open({ binary, session: "missing-tool", deadlineMs })).kind).toBe("unavailable");
  const disconnected = await opened("disconnect");
  expect((await disconnected.send({ to: "alice/test", message: "hello", idempotencyKey: "same-key", deadlineMs })).kind).toBe("unknown");
  disconnected.close();
  const session = await opened("deadline");
  try { expect((await session.send({ to: "alice/test", message: "hello", idempotencyKey: "same-key", deadlineMs: 40 })).kind).toBe("unknown"); }
  finally { session.close(); }
});

test("parser recognizes literal render formats and rejects missing ids", () => {
  expect(parseProse("send", "message id 01ARZ3NDEKTSV4RRFFQ69G5FAV\n")).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
  expect(parseProse("send", "→ alice/test: queued\n")).toBeUndefined();
  expect(parseProse("address", "no team yet (this machine only) · you are alice on box\nalice · box · this machine\n  my-session  agent  live  -  pull · ← you\n")).toBe("alice/my-session@box");
});
