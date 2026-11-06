import { expect, test } from "bun:test";
import { Session, parseProse } from "../src/index.ts";
import { mkdtemp, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = new URL("./fake-server.ts", import.meta.url).pathname;
const deadlineMs = 3000;
async function opened(session: string) {
  const outcome = await Session.open({ binary, session, deadlineMs });
  if (outcome.kind !== "accepted") throw new Error(JSON.stringify(outcome));
  return outcome.value;
}

test("send, resend, status and session identity through stdio", async () => {
  const previousThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "worker-thread";
  const session = await opened("my-session");
  try {
    const input = { to: "alice/test@box", message: "hello", idempotencyKey: "same-key", deadlineMs };
    const first = await session.send(input);
    expect(first).toEqual({ kind: "accepted", value: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] });
    expect(await session.send(input)).toEqual(first);
    expect(await session.send({ ...input, idempotencyKey: "another-key" })).toEqual({ kind: "accepted", value: ["01ARZ3NDEKTSV4RRFFQ69G5FAW"] });
    expect(await session.status(["01ARZ3NDEKTSV4RRFFQ69G5FAV"], deadlineMs)).toEqual({ kind: "accepted", value: { receipts: [{ status: "accepted" }] } });
    expect(await session.address(deadlineMs)).toEqual({ kind: "accepted", value: "alice/my-session@box" });
  } finally { session.close(); if (previousThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previousThread; }
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
  expect((await Session.open({ binary, session: "failed-initialize", deadlineMs })).kind).toBe("unavailable");
  expect((await Session.open({ binary, session: "missing-tool", deadlineMs })).kind).toBe("unavailable");
  const disconnected = await opened("disconnect");
  expect((await disconnected.send({ to: "alice/test", message: "hello", idempotencyKey: "same-key", deadlineMs })).kind).toBe("unknown");
  disconnected.close();
  const session = await opened("deadline");
  try { expect((await session.send({ to: "alice/test", message: "hello", idempotencyKey: "same-key", deadlineMs: 40 })).kind).toBe("unknown"); }
  finally { session.close(); }
});

test("caller errors are usage and never start or call the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reason-transport-"));
  const marker = join(dir, "started");
  const executable = join(dir, "server");
  await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(executable, 0o755);
  try {
    const valid = { binary: executable, session: "test", deadlineMs };
    const badDeadlines = [undefined, 0, -1, Infinity, NaN, 2_147_483_648];
    for (const options of [
      { ...valid, binary: undefined }, { ...valid, binary: "" },
      { ...valid, session: undefined }, { ...valid, session: "" },
      ...badDeadlines.map((value) => ({ ...valid, deadlineMs: value })),
    ]) {
      // Exercise untyped callers at the public boundary.
      // @ts-expect-error deliberately missing required arguments
      expect((await Session.open(options)).kind).toBe("usage");
    }
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);

    const calls = join(dir, "calls");
    const session = await opened(`calls:${calls}`);
    try {
      const input = { to: "alice/test", message: "hello", idempotencyKey: "key", deadlineMs };
      for (const field of ["to", "message", "idempotencyKey"] as const) {
        for (const value of [undefined, ""]) {
          expect((await session.send({ ...input, [field]: value })).kind).toBe("usage");
        }
      }
      for (const ids of [undefined, [], [""], ["valid", ""]]) {
        // @ts-expect-error deliberately missing required argument
        expect((await session.status(ids, deadlineMs)).kind).toBe("usage");
      }
      for (const value of badDeadlines) {
        // @ts-expect-error deliberately missing deadline
        expect((await session.send({ ...input, deadlineMs: value })).kind).toBe("usage");
        // @ts-expect-error deliberately missing deadline
        expect((await session.status(["valid"], value)).kind).toBe("usage");
        // @ts-expect-error deliberately missing deadline
        expect((await session.address(value)).kind).toBe("usage");
      }
      expect(await readFile(calls).then(() => true, () => false)).toBe(false);
      expect(await session.send(input)).toEqual({ kind: "accepted", value: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] });
      expect(await readFile(calls, "utf8")).toBe("call\n");
    } finally { session.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("parser recognizes literal render formats and rejects missing ids", () => {
  expect(parseProse("send", "message id 01ARZ3NDEKTSV4RRFFQ69G5FAV\n")).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
  expect(parseProse("send", "→ alice/test: queued\n")).toBeUndefined();
  expect(parseProse("address", "no team yet (this machine only) · you are alice on box\nalice · box · this machine\n  my-session  agent  live  -  pull · ← you\n")).toBe("alice/my-session@box");
});
