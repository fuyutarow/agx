import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { foldedRuns } from "../../src/next/store.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const sockets: Array<import("node:net").Socket> = [];
const NoticeRecord = z.object({
  status: z.enum(["pending", "accepted", "unreachable", "deadline", "skipped"]),
  exit: z.number().nullable(),
  receipt: z.string(),
});
const EndedRecord = z.object({
  id: z.string(),
  kind: z.literal("ended"),
  outcome: z.string(),
  end_notice: NoticeRecord,
});
const NoticeEvent = z.object({
  kind: z.literal("end-notice"),
  id: z.string(),
  notice: NoticeRecord,
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => {
            resolveClose();
          });
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function readNoticeEvent(
  state: string,
  id: string,
): Promise<z.output<typeof NoticeRecord> | undefined> {
  const text = await Bun.file(join(state, "records.jsonl"))
    .text()
    .catch(() => "");
  for (const line of text.trim().split("\n")) {
    if (line === "") continue;
    const event = jsonOf(NoticeEvent).safeParse(line);
    if (event.success && event.data.id === id) return event.data.notice;
  }
  return undefined;
}

async function waitForNotice(
  state: string,
  id: string,
  initial: z.output<typeof NoticeRecord>,
): Promise<z.output<typeof NoticeRecord>> {
  if (initial.status !== "pending") return initial;
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const notice = await readNoticeEvent(state, id);
    if (notice !== undefined) return notice;
    await Bun.sleep(20);
  }
  return initial;
}

async function runCase(input: {
  dispatcher: string;
  senderExit: number;
  senderMode?: "fixture" | "xmsg";
  socketPort?: number;
  fakeRun?: boolean;
}): Promise<{
  root: string;
  state: string;
  notices: string[];
  claudeArgs: string[];
  elapsedMs: number;
  ended: z.output<typeof EndedRecord>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agx-end-notice-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const state = join(root, "state");
  const ticket = join(root, "ticket.md");
  await Bun.write(
    ticket,
    '+++\nschema = 2\nname = "end-notice-fixture"\nwrites = []\noutcome = "notice timeout"\nverify = []\ntimeout_s = 60\n[proposition]\nid = "NOTICE"\nclaim = "one notice follows a vendor timeout"\nrefuted_by = "no notice or multiple notices"\n+++\nRun the timeout fixture.\n',
  );
  const worker = join(root, "worker.ts");
  await Bun.write(
    worker,
    'console.log(JSON.stringify({ outcome: "timeout", timed_out: true, exit_code: 3 })); process.exit(3);\n',
  );
  const noticesPath = join(root, "notices.jsonl");
  const claudeArgsPath = join(root, "claude-args.jsonl");
  const agx = join(root, "agx");
  await Bun.write(
    agx,
    `#!${process.execPath}
import { subprocessEnvironment } from ${JSON.stringify(new URL("../../../shared/src/subprocess-env.ts", import.meta.url).pathname)};
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.NOTICES_PATH, JSON.stringify(args) + "\\n");
if (process.env.SENDER_MODE === "xmsg") {
  const forwarded = args[0] === "msg" ? args.slice(1) : args;
  const child = Bun.spawn([process.execPath, process.env.XMSG_ENTRY ?? "", ...forwarded], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: subprocessEnvironment(),
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exit;
} else {
  process.stdout.write(Number(process.env.SENDER_EXIT) === 0 ? "fake transport accepted\\n" : "fake transport unavailable\\n");
  process.exitCode = Number(process.env.SENDER_EXIT);
}
`,
  );
  await chmod(agx, 0o755);
  const claude = join(root, "claude");
  await Bun.write(
    claude,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
appendFileSync(process.env.CLAUDE_ARGS_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.NOTICE_SOCKET_PORT) });
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("error", reject);
});
await new Promise(() => {});
`,
  );
  await chmod(claude, 0o755);
  const jevPath = join(root, "jev.ts");
  await Bun.write(
    jevPath,
    `const jev = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ answers: { worker: { choice: "luna-high", confidence: 0.9 } } }) });\nconsole.log("ready:" + jev.port);\n`,
  );
  const jev = Bun.spawn([process.execPath, jevPath], {
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "ignore",
  });
  children.push(jev);
  if (jev.stdout === null) assert.fail("JEV fixture stdout is unavailable");
  const reader = jev.stdout.getReader();
  let readyLine = "";
  const decoder = new TextDecoder();
  while (!readyLine.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) assert.fail("JEV fixture exited before becoming ready");
    readyLine += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  const port = Number(readyLine.split(":")[1]?.trim());
  const claudeSession = input.dispatcher.startsWith("claude:")
    ? input.dispatcher.slice("claude:".length)
    : "";
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    PATH: `${root}:${process.env.PATH ?? ""}`,
    AGX_STATE_DIR: state,
    AGX_TMP_ROOT: join(root, "tmp"),
    AGX_WORKER_BIN: worker,
    AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
    AGX_DISPATCHER_SESSION: input.dispatcher,
    CLAUDE_CODE_SESSION_ID: claudeSession,
    CODEX_SESSION_ID: "",
    AGX_WORKER_PATH_SOURCE: "dispatcher",
    JEV_URL: `http://127.0.0.1:${port}`,
    TYPESAFE_API_KEY: "test-key",
    NOTICES_PATH: noticesPath,
    SENDER_EXIT: String(input.senderExit),
    SENDER_MODE: input.senderMode ?? "fixture",
    XMSG_ENTRY: resolve("tools/xmsg/src/xmsg.ts"),
    CLAUDE_ARGS_PATH: claudeArgsPath,
    NOTICE_SOCKET_PORT: String(input.socketPort ?? 0),
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  let command = [
    process.execPath,
    "tools/agx-worker/src/next/cli.ts",
    "run",
    ticket,
    "--cd",
    root,
  ];
  if (input.fakeRun === true) {
    const fakeRun = join(root, "fake-run.ts");
    const storePath = resolve("tools/agx-worker/src/next/store.ts");
    const noticePath = resolve("tools/agx-worker/src/next/end-notice.ts");
    const workerCli = resolve("tools/agx-worker/src/next/cli.ts");
    await Bun.write(
      fakeRun,
      `import { append, flushRunPublications, now } from ${JSON.stringify(storePath)};
import { scheduleEndNotice } from ${JSON.stringify(noticePath)};
import { subprocessEnvironment } from ${JSON.stringify(new URL("../../../shared/src/subprocess-env.ts", import.meta.url).pathname)};
const id = "fake-end-notice-run";
const dispatcher = process.env.AGX_DISPATCHER_SESSION ?? null;
const startedAt = now();
append({ kind: "started", id, at: startedAt, ticket: "end-notice-fixture", writes: [], cwd: process.cwd(), workspace: process.cwd(), row: "fixture", dispatcher_session: dispatcher, dispatcher_address: dispatcher, vendor_session: null, pid: process.pid });
const endedAt = now();
const end_notice = scheduleEndNotice({ id, ticket: "end-notice-fixture", dispatcher, address: dispatcher, startedAt, endedAt, outcome: "timeout", resultPath: null, verifyExits: [], env: subprocessEnvironment() }, [process.execPath, ${JSON.stringify(workerCli)}]);
append({ kind: "ended", id, at: endedAt, exit: 3, outcome: "timeout", end_notice, report_path: null, vendor_session: null, verify: [] });
await flushRunPublications();
process.exitCode = 3;
`,
    );
    command = [process.execPath, fakeRun];
  }
  const runStarted = performance.now();
  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    env,
    timeout: 5_000,
  });
  const elapsedMs = performance.now() - runStarted;
  expect(
    result.exitCode,
    `signal=${result.signalCode} stdout=${result.stdout.toString()} stderr=${result.stderr.toString()}`,
  ).toBe(3);
  const records = (await Bun.file(join(state, "records.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => jsonOf(z.looseObject({ kind: z.string() })).safeParse(line));
  const endedEvent = records.findLast(
    (record) => record.success && record.data.kind === "ended",
  );
  const ended =
    endedEvent?.success === true
      ? jsonOf(EndedRecord).safeParse(JSON.stringify(endedEvent.data))
      : undefined;
  expect(ended?.success).toBe(true);
  let finalNotice: z.output<typeof NoticeRecord> = {
    status: "pending",
    exit: null,
    receipt: "missing",
  };
  if (ended?.success === true)
    finalNotice = await waitForNotice(
      state,
      ended.data.id,
      ended.data.end_notice,
    );
  const noticeLines = await Bun.file(noticesPath)
    .text()
    .catch(() => "");
  const claudeLines = await Bun.file(claudeArgsPath)
    .text()
    .catch(() => "");
  const claudeArgs = claudeLines
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(z.array(z.string())).safeParse(line);
      if (!parsed.success) return [];
      return [parsed.data];
    })
    .flat();
  return {
    root,
    state,
    notices: noticeLines.trim() === "" ? [] : noticeLines.trim().split("\n"),
    claudeArgs,
    elapsedMs,
    ended:
      ended?.success === true
        ? { ...ended.data, end_notice: finalNotice }
        : {
            id: "missing",
            kind: "ended",
            outcome: "missing",
            end_notice: { status: "pending", exit: null, receipt: "missing" },
          },
  };
}

test("end notice contract: sends exactly one timeout notice to the recorded dispatcher", async () => {
  const result = await runCase({
    dispatcher: "claude:dispatcher-fixture",
    senderExit: 0,
  });
  expect(result.notices).toHaveLength(1);
  const argvResult = jsonOf(z.array(z.string())).safeParse(
    result.notices[0] ?? "[]",
  );
  expect(argvResult.success).toBe(true);
  if (!argvResult.success) return;
  const argv = argvResult.data;
  expect(argv.slice(0, 4)).toEqual([
    "msg",
    "send",
    "--to",
    "claude:dispatcher-fixture",
  ]);
  expect(argv).toContain("--exact");
  const message = argv[argv.indexOf("--message") + 1] ?? "";
  expect(message).toContain("ended timeout");
  expect(message).toContain("result: ");
  expect(message).toContain("verify: not run");
  expect(result.ended.outcome).toBe("timeout");
  expect(result.ended.end_notice).toMatchObject({
    status: "accepted",
    exit: 0,
    receipt: "fake transport accepted",
  });
});

test("end notice contract: skips an unrecorded dispatcher and records the skip", async () => {
  const result = await runCase({ dispatcher: "", senderExit: 0 });
  expect(result.notices).toEqual([]);
  expect(result.ended.end_notice).toEqual({
    status: "skipped",
    exit: null,
    receipt: "skipped: no dispatcher session",
  });
  expect(result.ended.outcome).toBe("timeout");
});

test("end notice contract: send failure is recorded without changing the run outcome", async () => {
  const result = await runCase({
    dispatcher: "claude:dispatcher-fixture",
    senderExit: 7,
  });
  expect(result.notices).toHaveLength(1);
  expect(result.ended.outcome).toBe("timeout");
  expect(result.ended.end_notice).toMatchObject({
    status: "unreachable",
    exit: 7,
    receipt: "fake transport unavailable",
  });
});

test("end notice contract: a dead dispatcher never delays the run end", async () => {
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    sockets.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    assert.fail("unanswering socket did not bind a TCP port");
  const dispatcherId = "80d8b978-a8bf-4797-8f93-12829e759502";
  const result = await runCase({
    dispatcher: `claude:${dispatcherId}`,
    senderExit: 0,
    senderMode: "xmsg",
    socketPort: address.port,
    fakeRun: true,
  });
  expect(result.elapsedMs).toBeLessThan(2_000);
  expect(accepted).toBeGreaterThan(0);
  expect(result.claudeArgs[0]).toBe("--print");
  expect(result.claudeArgs).not.toContain("agents");
  expect(result.ended.end_notice).toMatchObject({
    status: "deadline",
    exit: 4,
  });
  expect(result.ended.outcome).toBe("timeout");
  const recorded = (await foldedRuns(result.state)).find(
    (run) => run.id === result.ended.id,
  );
  expect(recorded?.end_notice).toMatchObject({
    status: "deadline",
    exit: 4,
  });
});
