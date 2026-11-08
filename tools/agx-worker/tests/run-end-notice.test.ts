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
  const ended = {
    kind: "ended",
    id: runId(input.outcome),
    outcome: input.outcome,
    exit: input.exit,
  };
  await Bun.write(join(state, "records.jsonl"), `${JSON.stringify(ended)}\n`);
  const binary = join(root, "reason-network");
  await Bun.write(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
  );
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
  const mode =
    input.senderDelayMs === "never"
      ? "hang"
      : input.senderExit === undefined || input.senderExit === 0
        ? "ok"
        : "unknown";
  const home = join(root, "rn-home");
  await Bun.write(
    join(home, "fake.json"),
    JSON.stringify({
      log: sent,
      mode,
      delayMs: String(
        typeof input.senderDelayMs === "number" ? input.senderDelayMs : 0,
      ),
    }),
  );
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
        REASON_NETWORK_HOME: home,
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
  const sends = (
    await Bun.file(sent)
      .text()
      .catch(() => "")
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = jsonOf(
        z.object({
          command: z.literal("send"),
          args: z.tuple([z.string(), z.string()]),
        }),
      ).safeParse(line);
      return parsed.success
        ? [{ to: parsed.data.args[0], message: parsed.data.args[1] }]
        : [];
    });
  const endedLines = records
    .trim()
    .split("\n")
    .filter((line) => {
      const parsed = jsonOf(z.object({ kind: z.literal("ended") })).safeParse(
        line,
      );
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
  expect(endedLines).toEqual([
    JSON.stringify({
      kind: "ended",
      id: runId("timeout"),
      outcome: "timeout",
      exit: 3,
    }),
  ]);
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
    receipt: "message id 01ARZ3NDEKTSV4RRFFQ69G5FA1",
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

test("a bare Claude dispatcher is qualified for a real run end notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-notice-run-"));
  roots.push(root);
  const { prepareTicketRepo } = await import("./ticket-repo.ts");
  await prepareTicketRepo(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  await mkdir(bin);
  await mkdir(state);
  const reason = join(bin, "reason-network");
  const sent = join(root, "reason.log");
  await Bun.write(
    join(root, "rn-home", "fake.json"),
    JSON.stringify({ log: sent, mode: "ok" }),
  );
  await Bun.write(
    reason,
    `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
  );
  await chmod(reason, 0o755);
  const mise = join(bin, "mise");
  await Bun.write(mise, '#!/bin/sh\nprintf "{}\\n"\n');
  await chmod(mise, 0o755);
  const ticket = join(root, "ticket.md");
  await Bun.write(
    ticket,
    `+++\nschema = 2\nname = "notice-integration"\nwrites = []\noutcome = "fixture"\nverify = ["true"]\n[proposition]\nid = "NOTICE"\nclaim = "notice uses identity"\nrefuted_by = "wrong identity"\n+++\nFixture.\n`,
  );
  const vendor = join(root, "vendor.ts");
  await Bun.write(
    vendor,
    'process.stdout.write(JSON.stringify({exit:0,report:{summary:"done",changes:[],checks:[],for_coordinator:[],open:[]},vendor_session:"vendor"}) + "\\n");',
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "mechanical", confidence: 0.9 } },
      }),
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "run",
        ticket,
        "--cd",
        root,
      ],
      {
        env: {
          ...subprocessEnvironment(),
          PATH: `${bin}:${process.env.PATH}`,
          AGX_STATE_DIR: state,
          AGX_WORKER_BIN: vendor,
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
          JEV_URL: `http://127.0.0.1:${server.port}/choice`,
          TYPESAFE_API_KEY: "test-key",
          CLAUDE_CODE_SESSION_ID: "bare-claude-session",
          AGX_DISPATCHER_SESSION: "",
          REASON_NETWORK_HOME: join(root, "rn-home"),
          XDG_STATE_HOME: join(root, "xdg"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(exit, stdout + stderr).toBe(0);
    let log = "";
    for (let i = 0; i < 100; i++) {
      log = await Bun.file(sent)
        .text()
        .catch(() => "");
      if (log.includes('"command":"send"')) break;
      await Bun.sleep(50);
    }
    expect(log).toContain(
      '"agent":"claude-code","session":"bare-claude-session"',
    );
    expect(log).toContain('"command":"send"');
    const records = await Bun.file(join(state, "records.jsonl")).text();
    expect(records).toContain('"dispatcher_session":"bare-claude-session"');
    expect(records).toContain('"ack_lookup_kind":"accepted"');
  } finally {
    await server.stop(true);
  }
}, 30_000);
