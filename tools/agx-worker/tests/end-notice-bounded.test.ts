import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { scheduleEndNotice } from "../src/next/end-notice.ts";

// The suite runs on a loaded host; each case starts real processes.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const RunId = "66666666-6666-4666-8666-666666666666";
const NoticeEvent = z.object({
  kind: z.literal("end-notice"),
  notice: z.object({ status: z.string(), exit: z.number().nullable() }),
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agx-end-notice-bounded-"));
  roots.push(root);
  return root;
}

async function script(path: string, body: string): Promise<void> {
  await Bun.write(path, `#!${process.execPath}\n${body}`);
  await chmod(path, 0o755);
}

const alive = async (pid: number): Promise<boolean> => {
  const stat = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => "");
  return stat !== "" && !/^\d+ \(.*\) Z /u.test(stat);
};

/** Exercise the notice against a fake MCP child holding its pipes open. */
async function deliver(input: { hangs: boolean; deadlineMs: number }) {
  const root = await tempRoot();
  const state = join(root, "state");
  const log = join(root, "calls.jsonl");
  await script(
    join(root, "reason-network"),
    `import ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
  );
  const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
  const request = {
    id: RunId,
    ticket: "bounded-ticket",
    dispatcher: "claude:dispatcher",
    startedAt: "2026-11-03T00:00:00Z",
    endedAt: "2026-11-03T00:03:00Z",
    outcome: "ok",
    exit: 0,
    resultPath: null,
    verifyExits: [],
    parentPid: dead.pid,
    deadlineMs: input.deadlineMs,
  };
  const home = join(root, "rn-home");
  await Bun.write(
    join(home, "fake.json"),
    JSON.stringify({ log, mode: input.hangs ? "hang" : "hold-pipes" }),
  );
  const started = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("tools/agx-worker/src/next/cli.ts"),
      "--internal-end-notice",
      JSON.stringify(request),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...subprocessEnvironment(),
        PATH: `${root}:${process.env.PATH ?? ""}`,
        AGX_STATE_DIR: state,
        REASON_NETWORK_HOME: home,
      },
    },
  );
  const exit = await child.exited;
  const elapsedMs = performance.now() - started;
  const records = await Bun.file(join(state, "records.jsonl"))
    .text()
    .catch(() => "");
  const notices = records
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(NoticeEvent).safeParse(line);
      return parsed.success ? [parsed.data.notice] : [];
    });
  const calls = (
    await Bun.file(log)
      .text()
      .catch(() => "")
  )
    .trim()
    .split("\n");
  const helper =
    calls.flatMap((line) => {
      const parsed = jsonOf(z.object({ helper: z.number() })).safeParse(line);
      return parsed.success ? [parsed.data.helper] : [];
    })[0] ?? 0;
  return { exit, elapsedMs, notices, helper };
}

test("a notice whose relay never accepts exits within its deadline plus a small margin", async () => {
  const deadlineMs = 1_500;
  const { exit, elapsedMs, notices, helper } = await deliver({
    hangs: true,
    deadlineMs,
  });
  expect(notices.map((notice) => notice.status)).toEqual(["deadline"]);
  expect(elapsedMs).toBeLessThan(deadlineMs + 6_000);
  expect(exit).toBe(0);
  // The helper that held the sender's pipes is killed with it.
  expect(helper).toBeGreaterThan(0);
  expect(await alive(helper)).toBe(false);
});

test("an accepted notice exits promptly even when the sender left a helper on its pipes", async () => {
  const { exit, elapsedMs, notices, helper } = await deliver({
    hangs: false,
    deadlineMs: 30_000,
  });
  expect(notices.map((notice) => notice.status)).toEqual(["accepted"]);
  expect(elapsedMs).toBeLessThan(5_000);
  expect(exit).toBe(0);
  expect(await alive(helper)).toBe(false);
});

/** Fake `systemd-run` that records its argv and starts nothing. */
async function fakeSystemdRun(root: string, code: number): Promise<string> {
  const log = join(root, "systemd-run.jsonl");
  await script(
    join(root, "systemd-run"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exitCode = ${code};
`,
  );
  return log;
}

function schedule(root: string, marker: string) {
  const worker = join(root, "worker.ts");
  return scheduleEndNotice(
    {
      id: RunId,
      ticket: "bounded-ticket",
      dispatcher: "claude:dispatcher",
      startedAt: "2026-11-03T00:00:00Z",
      endedAt: "2026-11-03T00:03:00Z",
      outcome: "ok",
      exit: 0,
      resultPath: null,
      verifyExits: [],
      detachUnit: true,
      env: { PATH: `${root}:${process.env.PATH ?? ""}`, MARKER: marker },
    },
    [worker],
  );
}

test("a pending notice lives in its own unit, so an ended run's unit is free for --continue", async () => {
  const root = await tempRoot();
  const marker = join(root, "ran-in-run-unit");
  await script(
    join(root, "worker.ts"),
    `await Bun.write(process.env.MARKER, "ran");\n`,
  );
  const log = await fakeSystemdRun(root, 0);
  const notice = schedule(root, marker);
  expect(notice.status).toBe("pending");
  const calls = (await Bun.file(log).text())
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(z.array(z.string())).safeParse(line);
      return parsed.success ? [parsed.data] : [];
    });
  expect(calls).toHaveLength(1);
  const argv = calls[0] ?? [];
  expect(argv).toContain("--user");
  // Its own transient unit, never the run's `agt_*` unit.
  expect(argv).toContain(`--unit=agx-end-notice-${RunId}`);
  expect(argv.some((arg) => arg.startsWith("RuntimeMaxSec="))).toBe(true);
  expect(argv).toContain("--internal-end-notice");
  expect(argv.some((arg) => arg.startsWith("--setenv=MARKER="))).toBe(true);
  // Not also started as a child of the run (and so of the run's unit).
  await Bun.sleep(300);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("when the notice unit cannot be created the notice still starts as a detached child", async () => {
  const root = await tempRoot();
  const marker = join(root, "ran-directly");
  await script(
    join(root, "worker.ts"),
    `await Bun.write(process.env.MARKER, "ran");\n`,
  );
  await fakeSystemdRun(root, 1);
  expect(schedule(root, marker).status).toBe("pending");
  const deadline = performance.now() + 5_000;
  while (!(await Bun.file(marker).exists()) && performance.now() < deadline)
    await Bun.sleep(50);
  expect(await Bun.file(marker).exists()).toBe(true);
});
