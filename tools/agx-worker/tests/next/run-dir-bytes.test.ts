import { expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizeNotice } from "../../src/next/end-notice.ts";
import { measureRunDir } from "../../src/next/reclaim-runs.ts";

test("measures a 300 MiB run and counts hard links once", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-size-"));
  try {
    mkdirSync(join(root, "artifacts"));
    const file = join(root, "artifacts", "large");
    const fd = openSync(file, "w");
    ftruncateSync(fd, 300 * 1024 * 1024);
    closeSync(fd);
    const one = measureRunDir(root);
    linkSync(file, join(root, "artifacts", "linked"));
    const two = measureRunDir(root);
    expect(two.bytes - one.bytes).toBeLessThan(4096);
    expect(two.bytes).toBeGreaterThanOrEqual(300 * 1024 * 1024);
    expect(two.largest?.name).toBe("artifacts");
    expect(sizeNotice(two)).toContain(
      "300.0 MiB; largest subdirectory: artifacts",
    );
    expect(sizeNotice({ bytes: 100 })).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("brief directs large output to reclaimable artifacts", () => {
  const source = readFileSync("tools/agx-worker/src/next/run.ts", "utf8");
  expect(source).toContain("Put large outputs in $AGX_RUN_DIR/artifacts/");
});

test("ended records expose measured bytes and delivered notices distinguish large and small runs", async () => {
  const { append, foldedRuns } = await import("../../src/next/store.ts");
  const { chmodSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "agx-end-size-"));
  try {
    const state = join(root, "state");
    const log = join(root, "calls");
    const home = join(root, "reason-home");
    mkdirSync(home);
    writeFileSync(join(home, "fake.json"), JSON.stringify({ log, mode: "ok" }));
    const binary = join(root, "reason-network");
    writeFileSync(
      binary,
      `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
    );
    chmodSync(binary, 0o755);
    const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
    for (const [id, bytes] of [
      ["66666666-6666-4666-8666-666666666666", 300 * 1024 * 1024],
      ["77777777-7777-4777-8777-777777777777", 10],
    ] as const) {
      const dir = join(state, "runs", id);
      mkdirSync(join(dir, "artifacts"), { recursive: true });
      const fd = openSync(join(dir, "artifacts", "payload"), "w");
      ftruncateSync(fd, bytes);
      closeSync(fd);
      const at = "2026-11-01T00:00:00Z";
      append(
        {
          kind: "started",
          id,
          at,
          ticket: "size",
          writes: [],
          cwd: root,
          workspace: root,
          row: "test",
          dispatcher_session: null,
          vendor_session: null,
          pid: process.pid,
        },
        state,
        false,
      );
      append(
        {
          kind: "ended",
          id,
          at: "2026-11-01T00:01:00Z",
          exit: 0,
          outcome: "ok",
          report_path: null,
          vendor_session: null,
          verify: [],
        },
        state,
        false,
      );
      const run = (await foldedRuns(state)).find((entry) => entry.id === id);
      expect(run?.run_dir_bytes).toBeGreaterThanOrEqual(bytes);
      const size = measureRunDir(dir);
      expect(run?.run_dir_bytes).toBe(size.bytes);
      const request = {
        id,
        ticket: "size",
        dispatcher: "claude:dispatcher",
        startedAt: at,
        endedAt: "2026-11-01T00:01:00Z",
        outcome: "ok",
        exit: 0,
        resultPath: null,
        verifyExits: [],
        parentPid: dead.pid,
        deadlineMs: 3000,
        runDirSize: size,
      };
      const child = Bun.spawn(
        [
          process.execPath,
          resolve("tools/agx-worker/src/next/cli.ts"),
          "--internal-end-notice",
          JSON.stringify(request),
        ],
        {
          env: {
            ...process.env,
            PATH: root,
            REASON_NETWORK_HOME: home,
            AGX_STATE_DIR: state,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, stdout + stderr).toBe(0);
    }
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const sends = calls.filter((call) => call.command === "send");
    expect(sends).toHaveLength(2);
    expect(sends[0].args[1]).toContain(
      "300.0 MiB; largest subdirectory: artifacts",
    );
    expect(sends[1].args[1]).not.toContain("Run directory:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop's fallback end records the directory size and its fold retains it", async () => {
  const { leaseFor } = await import("../../src/next/lease.ts");
  const { foldedRuns } = await import("../../src/next/store.ts");
  const { writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "agx-stopped-size-"));
  const owner = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const state = join(root, "state");
    const id = "stopped-run";
    const dir = join(state, "runs", id);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "payload"), "measurement");
    const lease = await leaseFor(owner.pid, null);
    expect(lease.start).not.toBeNull();
    const start = {
      kind: "started",
      id,
      at: "2026-11-01T00:00:00Z",
      ticket: "stop",
      writes: [],
      cwd: root,
      workspace: root,
      row: "test",
      dispatcher_session: null,
      vendor_session: null,
      pid: owner.pid,
      lease,
    };
    writeFileSync(join(state, "records.jsonl"), JSON.stringify(start) + "\n");
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "stop",
        id,
      ],
      {
        env: { ...process.env, AGX_STATE_DIR: state },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      owner.exited,
    ]);
    expect(exit, stdout + stderr).toBe(0);
    const lines = readFileSync(join(state, "records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ended = lines.findLast((line) => line.kind === "ended");
    expect(ended.run_dir_bytes).toBeGreaterThanOrEqual(11);
    const run = (await foldedRuns(state)).find((item) => item.id === id);
    expect(run?.run_dir_bytes).toBe(ended.run_dir_bytes);
  } finally {
    owner.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker run measures its 300 MiB output and delivers the size notice", async () => {
  const { prepareTicketRepo } = await import("../ticket-repo.ts");
  const { subprocessEnvironment } =
    await import("../../../shared/src/subprocess-env.ts");
  const { chmodSync, writeFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "agx-real-size-"));
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "mechanical", confidence: 0.9 } },
      }),
  });
  try {
    await prepareTicketRepo(root);
    const state = join(root, "state");
    const ticket = join(root, "ticket.md");
    writeFileSync(
      ticket,
      '+++\nschema = 2\nname = "size-probe"\nwrites = ["output.txt"]\noutcome = "size measured"\nverify = []\n[proposition]\nid = "SIZE"\nclaim = "size recorded"\nrefuted_by = "missing size"\n+++\nRun the fixture.\n',
    );
    const worker = join(root, "worker.ts");
    writeFileSync(
      worker,
      'import { mkdirSync, openSync, ftruncateSync, closeSync, writeFileSync } from "node:fs"; const dir = process.env.AGX_RUN_DIR + "/artifacts"; mkdirSync(dir); const fd = openSync(dir + "/large", "w"); ftruncateSync(fd, 300 * 1024 * 1024); closeSync(fd); writeFileSync("output.txt", "done"); console.log(JSON.stringify({report:{summary:"done",changes:[],checks:[],for_coordinator:[],open:[]}}));\n',
    );
    const home = join(root, "reason-home");
    mkdirSync(home);
    const log = join(root, "reason-log");
    writeFileSync(join(home, "fake.json"), JSON.stringify({ log, mode: "ok" }));
    const reason = join(root, "reason-network");
    writeFileSync(
      reason,
      `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
    );
    chmodSync(reason, 0o755);
    const env = {
      ...subprocessEnvironment(),
      PATH: `${root}:${process.env.PATH ?? ""}`,
      AGX_STATE_DIR: state,
      XDG_STATE_HOME: join(root, "xdg"),
      XDG_CONFIG_HOME: join(root, "config"),
      JEV_URL: `http://127.0.0.1:${server.port}`,
      TYPESAFE_API_KEY: "test-key",
      AGX_WORKER_BIN: worker,
      AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
      REASON_NETWORK_HOME: home,
    };
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "run",
        ticket,
        "--cd",
        root,
        "--session",
        "claude:dispatcher",
      ],
      { env, stdout: "pipe", stderr: "pipe", timeout: 20000 },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).toBe(0);
    const lines = readFileSync(join(state, "records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ended = lines.findLast((line) => line.kind === "ended");
    expect(ended.run_dir_bytes).toBeGreaterThanOrEqual(300 * 1024 * 1024);
    expect(
      readFileSync(join(state, "runs", ended.id, "brief.md"), "utf8"),
    ).toContain("Put large outputs in $AGX_RUN_DIR/artifacts/");
    const deadline = performance.now() + 10000;
    while (
      (!existsSync(log) ||
        !readFileSync(log, "utf8").includes('"command":"send"')) &&
      performance.now() < deadline
    )
      await Bun.sleep(20);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const send = calls.find((call) => call.command === "send");
    expect(send.args[1]).toContain(
      "300.0 MiB; largest subdirectory: artifacts",
    );
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
