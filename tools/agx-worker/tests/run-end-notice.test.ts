import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

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
};

/** Run the real notice worker once with a fake `agx msg send` on PATH. */
async function deliver(input: Case) {
  const root = await mkdtemp(join(tmpdir(), "agx-run-end-notice-"));
  roots.push(root);
  const state = join(root, "state");
  const sent = join(root, "sent.jsonl");
  const agx = join(root, "agx");
  await Bun.write(
    agx,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.SENT_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
const code = Number(process.env.SENDER_EXIT);
process.stdout.write(code === 0 ? "enqueued receipt-1\\n" : "relay unavailable\\n");
process.exitCode = code;
`,
  );
  await chmod(agx, 0o755);
  const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
  const request = {
    id: runId(input.outcome),
    ticket: "notice-ticket",
    dispatcher: input.dispatcher,
    address: input.dispatcher,
    startedAt: "2026-11-03T00:00:00Z",
    endedAt: "2026-11-03T00:03:00Z",
    outcome: input.outcome,
    exit: input.exit,
    resultPath: input.resultPath ?? null,
    verifyExits: input.verifyExits ?? [],
    parentPid: dead.pid,
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
        SENT_PATH: sent,
        SENDER_EXIT: String(input.senderExit ?? 0),
      },
      timeout: 10_000,
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
    .filter((line) => line !== "")
    .flatMap((line) => {
      const parsed = jsonOf(z.array(z.string())).safeParse(line);
      return parsed.success ? [parsed.data] : [];
    });
  return { result, notices, sends };
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

const messageOf = (argv: string[]): string =>
  argv[argv.indexOf("--message") + 1] ?? "";

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
    const argv = sends[0] ?? [];
    expect(argv.slice(0, 4)).toEqual([
      "msg",
      "send",
      "--to",
      "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    ]);
    const message = messageOf(argv);
    expect(message).toContain(runId(c.outcome));
    expect(argv[argv.indexOf("--from") + 1]).toBe(
      `agx-manager:${runId(c.outcome)}`,
    );
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
  const { sends, notices } = await deliver({
    outcome: "timeout",
    exit: 3,
    dispatcher: "claude:d5fd4690-9c34-4937-ab24-54a8f96a8b9d",
    senderExit: 7,
  });
  expect(sends).toHaveLength(1);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.notice).toMatchObject({
    status: "unreachable",
    exit: 7,
    receipt: "relay unavailable",
  });
});
