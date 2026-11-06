import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const id = "66666666-6666-4666-8666-666666666666";
async function run(mode = "ok", missing = false) {
  const root = await mkdtemp(join(tmpdir(), "notice-reason-")); roots.push(root);
  const state = join(root, "state"); const log = join(root, "calls");
  if (!missing) {
    const binary = join(root, "reason-network");
    await Bun.write(binary, `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`);
    await chmod(binary, 0o755);
  }
  const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
  const request = { id, ticket: "test", dispatcher: "claude:dispatcher", startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T00:01:00Z", outcome: "ok", exit: 0, resultPath: null, verifyExits: [], parentPid: dead.pid, deadlineMs: 800 };
  const invoke = async () => {
    const child = Bun.spawn([process.execPath, resolve("tools/agx-worker/src/next/cli.ts"), "--internal-end-notice", JSON.stringify(request)], { env: { ...process.env, PATH: root, AGX_STATE_DIR: state, FAKE_LOG: log, FAKE_MODE: mode, CODEX_THREAD_ID: "worker-thread" }, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, `${out} ${err}`).toBe(0);
    const records = (await Bun.file(join(state, "records.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
    return records.filter((row) => row.kind === "end-notice").at(-1).notice;
  };
  return { invoke, calls: async () => (await Bun.file(log).text().catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}
test("sends from manager to resolved dispatcher with a stable idempotency key", async () => {
  const fixture = await run();
  for (let i = 0; i < 2; i++) expect(await fixture.invoke()).toMatchObject({ status: "accepted", receipt: expect.stringContaining("01ARZ3NDEKTSV4RRFFQ69G5FAV") });
  const calls = await fixture.calls();
  expect(calls.filter((c) => c.command === "who").map((c) => [c.agent, c.session])).toEqual([["claude-code", "dispatcher"], ["claude-code", "dispatcher"]]);
  expect(calls.filter((c) => c.command === "mcp").map((c) => [c.agent, c.session, c.thread])).toEqual([["reason", "agx-manager", "worker-thread"], ["reason", "agx-manager", "worker-thread"]]);
  expect(calls.filter((c) => c.command === "status").every((c) => c.agent === "reason" && c.session === "agx-manager" && c.args.join(" ") === "--name agx-manager")).toBe(true);
  const sends = calls.filter((c) => c.method === "tools/call").map((c) => c.params.arguments);
  expect(sends).toHaveLength(2);
  expect(calls.filter((c) => c.delivery === `${id}:end`)).toHaveLength(1);
  for (const send of sends) { expect(send.idempotency_key).toBe(`${id}:end`); expect(send.to).toBe("alice/dispatcher@host"); expect(send.message).toContain("No reply needed; read: agx worker ls --json"); }
});
test("unregistered and absent binary are unreachable", async () => {
  const unregistered = await run("unregistered");
  expect(await unregistered.invoke()).toMatchObject({ status: "unreachable", receipt: "dispatcher session is not registered with Reason Network or not live" });
  expect((await unregistered.calls()).some((call) => call.command === "mcp")).toBe(false);
  expect(await (await run("ok", true)).invoke()).toMatchObject({ status: "unreachable", receipt: "reason-network executable not found on PATH" });
});
test("deadline is not accepted and rename failure is retained", async () => {
  expect(await (await run("unknown")).invoke()).toMatchObject({ status: "unknown", receipt: "receipt unavailable" });
  const hanging = await run("hang");
  expect(["deadline", "unknown"]).toContain((await hanging.invoke()).status);
  const helper = (await hanging.calls()).find((call) => call.helper !== undefined)?.helper;
  expect(helper).toBeGreaterThan(0);
  const helperStat = await Bun.file(`/proc/${helper}/stat`).text().catch(() => "");
  expect(helperStat === "" || /^\d+ \(.*\) Z /u.test(helperStat)).toBe(true);
  expect(["deadline", "unknown"]).toContain((await (await run("hang-initialize")).invoke()).status);
  expect(await (await run("rename-fails")).invoke()).toMatchObject({ status: "accepted", receipt: expect.stringContaining("rename denied") });
});
