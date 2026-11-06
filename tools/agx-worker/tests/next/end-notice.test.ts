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
  // Per run: the first tool call (list_team) registers the session, the rename follows it, the send comes from agx-manager.
  const steps = calls.flatMap((c) => c.command === "mcp" ? ["open"] : c.command === "status" ? [`rename:registered=${c.registered}`] : c.method === "tools/call" ? [c.params.name] : c.sentFrom !== undefined ? [`from:${c.sentFrom}`] : []);
  expect(steps).toEqual(Array(2).fill(["open", "list_team", "rename:registered=true", "send_message", "from:agx-manager"]).flat());
  const sends = calls.filter((c) => c.method === "tools/call" && c.params.name === "send_message").map((c) => c.params.arguments);
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
  expect(await (await run("unknown")).invoke()).toMatchObject({ status: "unknown", receipt: expect.stringContaining("receipt unavailable") });
  const hanging = await run("hang");
  expect(["deadline", "unknown"]).toContain((await hanging.invoke()).status);
  const helper = (await hanging.calls()).find((call) => call.helper !== undefined)?.helper;
  expect(helper).toBeGreaterThan(0);
  const helperStat = await Bun.file(`/proc/${helper}/stat`).text().catch(() => "");
  expect(helperStat === "" || /^\d+ \(.*\) Z /u.test(helperStat)).toBe(true);
  expect(["deadline", "unknown"]).toContain((await (await run("hang-initialize")).invoke()).status);
  expect(await (await run("rename-fails")).invoke()).toMatchObject({ status: "accepted", receipt: expect.stringContaining("rename denied") });
});
test("the receipt names the rename outcome and the notice is sent from agx-manager", async () => {
  const fixture = await run();
  const notice = await fixture.invoke();
  expect(notice.status).toBe("accepted");
  expect(notice.receipt).toContain("sender agx-manager");
  const calls = await fixture.calls();
  expect(calls.filter((c) => c.sentFrom !== undefined).at(-1)?.sentFrom).toBe("agx-manager");
});
test("a rename before registration is refused by the daemon, so the notice renames only after list_team", async () => {
  const root = await mkdtemp(join(tmpdir(), "notice-reason-fake-")); roots.push(root);
  const binary = join(root, "reason-network");
  await Bun.write(binary, `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`);
  await chmod(binary, 0o755);
  const early = Bun.spawnSync([binary, "status", "--name", "agx-manager"], { env: { ...process.env, FAKE_LOG: join(root, "calls"), REASON_NETWORK_AGENT: "reason", REASON_NETWORK_SESSION: "agx-manager" } });
  expect(early.exitCode).toBe(1);
  expect(early.stderr.toString()).toBe("this session is not registered");
});
test("a refused rename still sends the notice and the receipt says why", async () => {
  const fixture = await run("rename-fails");
  const notice = await fixture.invoke();
  const { receipt } = notice;
  expect(notice.status).toBe("accepted");
  expect(receipt).toContain("rename failed: rename denied");
  expect(receipt).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect((await fixture.calls()).filter((c) => c.sentFrom !== undefined).at(-1)?.sentFrom).toBe("fuyu-reason");
});
test("a failed registration skips the rename, says so, and still sends the notice", async () => {
  const fixture = await run("list-fails");
  const notice = await fixture.invoke();
  expect(notice.status).toBe("accepted");
  expect(notice.receipt).toContain("rename skipped: session not registered (directory unavailable)");
  const calls = await fixture.calls();
  expect(calls.some((c) => c.command === "status")).toBe(false);
  expect(calls.filter((c) => c.delivery === `${id}:end`)).toHaveLength(1);
});
