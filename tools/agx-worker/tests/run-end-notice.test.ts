import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { EndNoticeRequest } from "../src/next/end-notice.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const NoticeEvent = z.object({
  kind: z.literal("end-notice"),
  id: z.string(),
  notice: z.object({
    status: z.string(),
    exit: z.number().nullable(),
    receipt: z.string(),
  }),
});

type Case = {
  outcome: string;
  exit: number;
  dispatcher: string | null;
  senderExit?: number;
  resultPath?: string | null;
  verifyExits?: number[];
  /** Fake sender answers after this many ms; "never" blocks forever. */
  senderDelayMs?: number | "never";
  deadlineMs?: number;
};

/** Run the real notice worker once with a fake `agx msg send` on PATH. */
async function deliver(input: Case) {
  const root = await mkdtemp(join(tmpdir(), "agx-run-end-notice-"));
  roots.push(root);
  const state = join(root, "state");
  const sent = join(root, "sent.jsonl");
  await mkdir(state, { recursive: true });
  const ended = { kind: "ended", id: runId(input.outcome), outcome: input.outcome, exit: input.exit };
  await Bun.write(join(state, "records.jsonl"), `${JSON.stringify(ended)}\n`);
  const binary = join(root, "reason-network");
  await Bun.write(binary, `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`);
  await chmod(binary, 0o755);
  const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
  const request = {
    id: runId(input.outcome),
    ticket: "notice-ticket",
    dispatcher: input.dispatcher,
    startedAt: "2026-11-03T00:00:00Z",
    endedAt: "2026-11-03T00:03:00Z",
    outcome: input.outcome,
    exit: input.exit,
    resultPath: input.resultPath ?? null,
    verifyExits: input.verifyExits ?? [],
    parentPid: dead.pid,
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
  };
  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve("tools/agx-worker/src/next/cli.ts"),
      "--internal-end-notice",
      JSON.stringify(request),
    ],
    {
      env: {
        ...subprocessEnvironment(),
        PATH: `${root}:${process.env.PATH ?? ""}`,
        AGX_STATE_DIR: state,
        FAKE_LOG: sent,
        FAKE_MODE: input.senderDelayMs === "never" ? "hang" : input.senderExit === undefined || input.senderExit === 0 ? "ok" : "unknown",
        FAKE_DELAY_MS: String(typeof input.senderDelayMs === "number" ? input.senderDelayMs : 0),
      },
      timeout: 15_000,
    },
  );
  const records = await Bun.file(join(state, "records.jsonl"))
    .text()
    .catch(() => "");
  const notices = records
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(NoticeEvent).safeParse(line);
      return parsed.success ? [parsed.data] : [];
    });
  const sends = (await Bun.file(sent).text().catch(() => ""))
    .trim().split("\n").filter(Boolean).flatMap((line) => {
      const parsed = jsonOf(z.object({ method: z.literal("tools/call"), params: z.object({ arguments: z.object({ to: z.string(), message: z.string(), idempotency_key: z.string() }) }) })).safeParse(line);
      return parsed.success ? [parsed.data.params.arguments] : [];
    });
  const endedLines = records.trim().split("\n").filter((line) => {
    const parsed = jsonOf(z.object({ kind: z.literal("ended") })).safeParse(line);
    return parsed.success;
  });
  return { result, notices, sends, endedLines };
}

const runIds: Record<string, string> = {
  ok: "11111111-1111-4111-8111-111111111111",
  "verify-failed": "22222222-2222-4222-8222-222222222222",
  timeout: "33333333-3333-4333-8333-333333333333",
  stopped: "44444444-4444-4444-8444-444444444444",
};
function runId(outcome: string): string {
  return runIds[outcome] ?? "55555555-5555-4555-8555-555555555555";
}

for (const c of [
  {
    outcome: "ok",
    exit: 0,
    verifyExits: [0],
    resultPath: "/runs/a/result.json",
  },
  {
    outcome: "verify-failed",
    exit: 1,
    verifyExits: [1],
    resultPath: "/runs/b/result.json",
  },
  { outcome: "timeout", exit: 3, resultPath: "/runs/c/result.json" },
  { outcome: "stopped", exit: 143, resultPath: null },
]) {
  test(`run end notice: ${c.outcome} sends one notice with id, ticket, outcome, exit and report path`, async () => {
    const { sends, notices } = await deliver({
      ...c,
      dispatcher: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    });
    expect(sends).toHaveLength(1);
    expect(notices).toHaveLength(1);
    const send = sends[0];
    expect(send?.to).toBe("alice/dispatcher@host");
    expect(send?.idempotency_key).toBe(`${runId(c.outcome)}:end`);
    const message = send?.message ?? "";
    expect(message).toContain(runId(c.outcome));
    expect(message).toContain("notice-ticket");
    expect(message).toContain(`ended ${c.outcome}`);
    expect(message).toContain(`exit ${c.exit}`);
    expect(message).toContain(`result: ${c.resultPath ?? "none"}`);
    expect(message).toContain("agx worker ls --json");
    expect(notices[0]?.notice).toMatchObject({ status: "accepted", exit: 0 });
  });
}

test("run end notice: no dispatcher_session sends none and records why", async () => {
  const { sends, notices } = await deliver({
    outcome: "ok",
    exit: 0,
    dispatcher: null,
  });
  expect(sends).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.notice).toEqual({
    status: "skipped",
    exit: null,
    receipt: "skipped: no dispatcher session",
  });
});

test("run end notice: a failed send is recorded and does not touch the outcome", async () => {
  const { sends, notices, endedLines } = await deliver({
    outcome: "timeout",
    exit: 3,
    dispatcher: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    senderExit: 7,
  });
  expect(sends).toHaveLength(1);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.notice).toMatchObject({
    status: "unknown",
    exit: 1,
    receipt: "receipt unavailable",
  });
  expect(endedLines).toEqual([JSON.stringify({ kind: "ended", id: runId("timeout"), outcome: "timeout", exit: 3 })]);
});

test("run end notice: the default budget leaves tens of seconds over a relay turn", () => {
  const parsed = EndNoticeRequest.parse({
    id: "x",
    ticket: "t",
    dispatcher: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    startedAt: "2026-11-03T00:00:00Z",
    endedAt: "2026-11-03T00:03:00Z",
    outcome: "ok",
    resultPath: null,
    verifyExits: [],
    parentPid: 1,
  });
  expect(parsed.deadlineMs).toBeGreaterThanOrEqual(60_000);
});

test("run end notice: a sender that accepts after 3 s is recorded accepted", async () => {
  const { notices } = await deliver({
    outcome: "ok",
    exit: 0,
    dispatcher: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    senderDelayMs: 3_000,
    deadlineMs: 10_000,
  });
  expect(notices).toHaveLength(1);
  expect(notices[0]?.notice).toMatchObject({
    status: "accepted",
    exit: 0,
    receipt: "message id 01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
});

test("run end notice: a sender that never answers records deadline after the budget", async () => {
  const started = performance.now();
  const { notices } = await deliver({
    outcome: "ok",
    exit: 0,
    dispatcher: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    senderDelayMs: "never",
    deadlineMs: 1_000,
  });
  const elapsed = performance.now() - started;
  expect(notices).toHaveLength(1);
  expect(notices[0]?.notice).toMatchObject({ status: "deadline", exit: 4 });
  expect(elapsed).toBeGreaterThanOrEqual(1_000);
  expect(elapsed).toBeLessThan(10_000);
});
