import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const EndedRecord = z.object({
  kind: z.literal("ended"),
  outcome: z.string(),
  end_notice: z.object({ exit: z.number().nullable(), receipt: z.string() }),
});
setDefaultTimeout(15_000);
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runCase(input: {
  dispatcher: string;
  senderExit: number;
}): Promise<{
  root: string;
  state: string;
  notices: string[];
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
  const agx = join(root, "agx");
  await Bun.write(
    agx,
    `#!${process.execPath}\nimport { appendFileSync } from "node:fs"; appendFileSync(process.env.NOTICES_PATH, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log("fake transport accepted"); process.exit(Number(process.env.SENDER_EXIT));\n`,
  );
  await chmod(agx, 0o755);
  const portProbe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = portProbe.port;
  await portProbe.stop(true);
  const jevPath = join(root, "jev.ts");
  await Bun.write(
    jevPath,
    `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ answers: { worker: { choice: "luna-high", confidence: 0.9 } } }) });\n`,
  );
  const jev = Bun.spawn([process.execPath, jevPath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(jev);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}`).catch(() => null)) !== null)
      break;
    await Bun.sleep(25);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    AGX_STATE_DIR: state,
    AGX_TMP_ROOT: join(root, "tmp"),
    AGX_WORKER_BIN: worker,
    AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
    AGX_DISPATCHER_SESSION: input.dispatcher,
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_SESSION_ID: "",
    AGX_WORKER_PATH_SOURCE: "dispatcher",
    JEV_URL: `http://127.0.0.1:${port}`,
    TYPESAFE_API_KEY: "test-key",
    NOTICES_PATH: noticesPath,
    SENDER_EXIT: String(input.senderExit),
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "tools/agx-worker/src/next/cli.ts",
      "run",
      ticket,
      "--cd",
      root,
    ],
    { cwd: process.cwd(), env, timeout: 10_000 },
  );
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
  const noticeLines = await Bun.file(noticesPath)
    .text()
    .catch(() => "");
  return {
    root,
    state,
    notices: noticeLines.trim() === "" ? [] : noticeLines.trim().split("\n"),
    ended:
      ended?.success === true
        ? ended.data
        : {
            kind: "ended",
            outcome: "missing",
            end_notice: { exit: null, receipt: "missing" },
          },
  };
}

test("end notice sends exactly one timeout notice to the recorded dispatcher", async () => {
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
  const message = argv[argv.indexOf("--message") + 1] ?? "";
  expect(message).toContain("ended timeout");
  expect(message).toContain("result: ");
  expect(message).toContain("verify: not run");
  expect(result.ended.outcome).toBe("timeout");
  expect(result.ended.end_notice).toMatchObject({
    exit: 0,
    receipt: "fake transport accepted",
  });
});

test("end notice skips an unrecorded dispatcher and records the skip", async () => {
  const result = await runCase({ dispatcher: "", senderExit: 0 });
  expect(result.notices).toEqual([]);
  expect(result.ended.end_notice).toEqual({
    exit: null,
    receipt: "skipped: no dispatcher session",
  });
  expect(result.ended.outcome).toBe("timeout");
});

test("end notice send failure is recorded without changing the run outcome", async () => {
  const result = await runCase({
    dispatcher: "claude:dispatcher-fixture",
    senderExit: 7,
  });
  expect(result.notices).toHaveLength(1);
  expect(result.ended.outcome).toBe("timeout");
  expect(result.ended.end_notice).toMatchObject({
    exit: 7,
    receipt: "fake transport accepted",
  });
});
