import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../src/xmsg.ts");
const sender = "claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipient = "codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
async function run(args: string[], mode = "ok", install = true) {
  const root = await mkdtemp(join(tmpdir(), "xmsg-test-"));
  try {
    const log = join(root, "calls");
    if (install)
      await writeFile(
        join(root, "reason-network"),
        `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.LOG, JSON.stringify({args:process.argv.slice(2), agent:process.env.REASON_NETWORK_AGENT, session:process.env.REASON_NETWORK_SESSION})+'\\n');\nif(process.argv[2]==='who') { if(process.env.MODE==='lookup-timeout') await Bun.sleep(2000); const absent=process.env.MODE===process.env.REASON_NETWORK_SESSION; process.stdout.write(JSON.stringify({sessions:absent?[]:[{address:'person/peer@host',is_me:true}]})); } else { if(process.env.MODE==='timeout') await Bun.sleep(2000); if(process.env.MODE==='failure') process.exit(7); if(process.env.MODE!=='missing') process.stdout.write('message id ${id}\\n'); if(process.env.MODE==='multiple') process.stdout.write('message id ${id}\\n'); }\n`,
        { mode: 0o755 },
      );
    const child = Bun.spawn([process.execPath, entry, ...args], {
      env: { ...process.env, PATH: root, LOG: log, MODE: mode },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    const calls = (await Bun.file(log).exists())
      ? (await Bun.file(log).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return { out, err, code, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const valid = [
  "send",
  "--from",
  sender,
  "--to",
  recipient,
  "--message",
  "hello",
];
test("sends once with mapped sender and resolved address", async () => {
  const result = await run(valid);
  expect(result.code).toBe(0);
  expect(result.out).toBe(`accepted message id ${id}\n`);
  expect(result.calls).toHaveLength(3);
  expect(result.calls[0]).toMatchObject({
    agent: "claude-code",
    session: sender.slice(7),
  });
  expect(result.calls[1]).toMatchObject({
    agent: "codex",
    session: recipient.slice(6),
  });
  expect(result.calls[2].args).toEqual([
    "send",
    "--from",
    `claude-code:${sender.slice(7)}`,
    "person/peer@host",
    "hello",
  ]);
});
test.each([
  [sender.slice(7), "sender"],
  [recipient.slice(6), "recipient"],
])("refuses unregistered %s", async (mode, side) => {
  const result = await run(valid, mode);
  expect(result.code).toBe(3);
  expect(result.err).toContain(
    `${side} ${side === "sender" ? sender : recipient} is not registered with Reason Network`,
  );
  expect(result.calls.every((call) => call.args[0] === "who")).toBe(true);
});
test("missing binary", async () => {
  const result = await run(valid, "ok", false);
  expect(result.code).toBe(3);
  expect(result.calls).toHaveLength(0);
});
test.each(["failure", "missing", "multiple", "timeout"])(
  "unknown acceptance %s is never retried",
  async (mode) => {
    const result = await run([...valid, "--timeout-ms", "300"], mode);
    expect(result.code).toBe(4);
    expect(result.err).toContain(
      "acceptance unknown; do not resend without checking",
    );
    expect(result.calls.filter((call) => call.args[0] === "send")).toHaveLength(
      1,
    );
  },
);
test.each([
  "alice",
  "codex:abcd",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "agx-manager:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
])("rejects invalid address %s before execution", async (value) => {
  for (const index of [2, 4]) {
    const args = [...valid];
    args[index] = value;
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.calls).toHaveLength(0);
  }
});
test.each(["list", "wait", "status"])("removed command %s", async (action) => {
  const result = await run([action]);
  expect(result.code).toBe(2);
  expect(result.calls).toHaveLength(0);
});
