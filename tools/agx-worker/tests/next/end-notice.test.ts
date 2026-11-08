import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminalEnvironment } from "../../src/next/end-notice.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const id = "66666666-6666-4666-8666-666666666666";
const otherId = "77777777-7777-4777-8777-777777777777";
const agentNames = [
  "REASON_NETWORK_AGENT",
  "TINCAN_AGENT",
  "REASON_NETWORK_SESSION",
  "TINCAN_SESSION",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "GROK_SESSION_ID",
  "GROK_WORKSPACE_ROOT",
  "GEMINI_CLI",
  "GEMINI_SESSION_ID",
  "CURSOR_AGENT",
  "OPENCODE",
  "OPENCODE_SESSION_ID",
  "COPILOT_CLI",
  "COPILOT_AGENT_SESSION_ID",
  "AI_AGENT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
];
async function fixture(mode = "ok", missing = false) {
  const root = await mkdtemp(join(tmpdir(), "notice-reason-"));
  roots.push(root);
  const state = join(root, "state");
  const log = join(root, "calls");
  if (!missing) {
    const binary = join(root, "reason-network");
    await Bun.write(
      binary,
      `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
    );
    await chmod(binary, 0o755);
  }
  const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
  const request = (runId: string) => ({
    id: runId,
    ticket: "test",
    dispatcher: "claude:dispatcher",
    startedAt: "2026-11-03T00:00:00Z",
    endedAt: "2026-11-03T00:01:00Z",
    outcome: "ok",
    exit: 0,
    resultPath: null,
    verifyExits: [],
    parentPid: dead.pid,
    deadlineMs: 800,
  });
  const invoke = async (
    runId = id,
    extra: Record<string, string> = {},
    stateDir = state,
  ) => {
    const agentEnv = Object.fromEntries(
      agentNames.map((name) => [name, "inherited"]),
    );
    // The send gets only PATH, HOME and REASON_NETWORK_HOME, so the fake reads its settings from REASON_NETWORK_HOME.
    const home = join(root, `home-${runId}`);
    await Bun.write(
      join(home, "fake.json"),
      JSON.stringify({ log, mode, delayMs: extra.FAKE_DELAY_MS }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "--internal-end-notice",
        JSON.stringify(request(runId)),
      ],
      {
        env: {
          ...subprocessEnvironment(),
          ...agentEnv,
          CLAUDE_CODE_SESSION_ID: "dispatcher-session",
          CODEX_THREAD_ID: "worker-thread",
          PATH: root,
          HOME: process.env.HOME ?? root,
          REASON_NETWORK_HOME: home,
          AGX_STATE_DIR: stateDir,
          FAKE_CANARY: "parent-only",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, `${out} ${err}`).toBe(0);
    const records = (await Bun.file(join(stateDir, "records.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return records
      .filter((row) => row.kind === "end-notice" && row.id === runId)
      .at(-1).notice;
  };
  return {
    root,
    state,
    invoke,
    calls: async () =>
      (
        await Bun.file(log)
          .text()
          .catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test("one terminal send per run to the address lookupAddress resolved, with no agent variable", async () => {
  const run = await fixture();
  expect(await run.invoke()).toEqual({
    status: "accepted",
    exit: 0,
    receipt: "message id 01ARZ3NDEKTSV4RRFFQ69G5FA6",
  });
  const calls = await run.calls();
  expect(
    calls.filter((c) => c.command === "who").map((c) => [c.agent, c.session]),
  ).toEqual([["claude-code", "dispatcher"]]);
  const sends = calls.filter((c) => c.command === "send");
  expect(sends).toHaveLength(1);
  const send = sends[0];
  expect(send.args).toHaveLength(2);
  expect(send.hasFrom).toBe(false);
  expect(send.args[0]).toBe("alice/dispatcher@host");
  expect(send.args[1]).toContain(`agx run ${id} test ended ok exit 0`);
  expect(send.args[1]).toContain("No reply needed; read: agx worker ls --json");
  // The parent set every agent variable (and these two on top); the send's environment is the allowlist and nothing else.
  expect(send.envNames).toEqual(["HOME", "PATH", "REASON_NETWORK_HOME"]);
  for (const name of [
    "CLAUDECODE",
    "CODEX_SESSION_ID",
    "TINCAN_AGENT",
    "TINCAN_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
  ])
    expect(send.envNames).not.toContain(name);
  expect(send.args[1].split("\n")[0]).toBe(`agx end-notice run ${id}`);
  expect(calls.some((c) => c.command === "mcp" || c.command === "status")).toBe(
    false,
  );
});

test("the child environment is the allowlist: PATH, HOME and REASON_NETWORK_HOME when set", () => {
  const parent = {
    PATH: "/bin",
    HOME: "/home/x",
    REASON_NETWORK_HOME: "/rn",
    FAKE_LOG: "log",
    CLAUDE_PROJECT_DIR: "/p",
    ...Object.fromEntries(agentNames.map((name) => [name, "v"])),
    CODEX_SANDBOX_OTHER: "1",
  };
  expect(terminalEnvironment(parent)).toEqual({
    PATH: "/bin",
    HOME: "/home/x",
    REASON_NETWORK_HOME: "/rn",
  });
  expect(terminalEnvironment({ PATH: "/bin", CLAUDECODE: "1" })).toEqual({
    PATH: "/bin",
  });
  expect(terminalEnvironment({})).toEqual({});
});

test("two notices for different runs started together are both accepted", async () => {
  const run = await fixture();
  const [first, second] = await Promise.all([
    run.invoke(id, { FAKE_DELAY_MS: "400" }),
    run.invoke(
      otherId,
      { FAKE_DELAY_MS: "400" },
      join(run.root, "state-other"),
    ),
  ]);
  expect(first).toEqual({
    status: "accepted",
    exit: 0,
    receipt: "message id 01ARZ3NDEKTSV4RRFFQ69G5FA6",
  });
  expect(second).toEqual({
    status: "accepted",
    exit: 0,
    receipt: "message id 01ARZ3NDEKTSV4RRFFQ69G5FA7",
  });
  const calls = await run.calls();
  expect(calls.filter((c) => c.command === "send")).toHaveLength(2);
  expect(
    calls
      .filter((c) => c.delivery !== undefined)
      .map((c) => c.delivery)
      .sort(),
  ).toEqual([id, otherId]);
  expect(calls.some((c) => c.command === "mcp")).toBe(false);
});

test("a send without a message id is unknown and is not retried", async () => {
  for (const mode of ["no-id", "two-ids", "unknown"]) {
    const run = await fixture(mode);
    expect(await run.invoke()).toMatchObject({ status: "unknown", exit: 1 });
    expect(
      (await run.calls()).filter((c) => c.command === "send"),
    ).toHaveLength(1);
  }
  expect((await (await fixture("unknown")).invoke()).receipt).toBe(
    "receipt unavailable",
  );
});

test("an unregistered dispatcher is unreachable and nothing is sent; an absent binary is unreachable", async () => {
  const unregistered = await fixture("unregistered");
  expect(await unregistered.invoke()).toMatchObject({
    status: "unreachable",
    receipt:
      "dispatcher session is not registered with Reason Network or not live",
  });
  expect(
    (await unregistered.calls()).some(
      (call) => call.command === "send" || call.command === "mcp",
    ),
  ).toBe(false);
  expect(await (await fixture("ok", true)).invoke()).toMatchObject({
    status: "unreachable",
    receipt: "reason-network executable not found on PATH",
  });
});

test("a send that never ends is a deadline and its helper is killed", async () => {
  const hanging = await fixture("hang");
  expect((await hanging.invoke()).status).toBe("deadline");
  const calls = await hanging.calls();
  expect(calls.filter((c) => c.command === "send")).toHaveLength(1);
  const helper = calls.find((call) => call.helper !== undefined)?.helper;
  expect(helper).toBeGreaterThan(0);
  const helperStat = await Bun.file(`/proc/${helper}/stat`)
    .text()
    .catch(() => "");
  expect(helperStat === "" || /^\d+ \(.*\) Z /u.test(helperStat)).toBe(true);
});
