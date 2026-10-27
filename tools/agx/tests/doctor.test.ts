import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoctorResponse, refreshDoctor } from "../src/refresh.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const entry = join(import.meta.dir, "../src/agx.ts");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agx-doctor-"));
  const state = join(root, "state");
  await mkdir(state);
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "xdg"),
    AGX_NEXT_STATE_DIR: undefined,
    PATH: root,
  };
  const member = async (tool: string, body: string) =>
    writeFile(
      join(root, `agx-${tool}`),
      `#!${process.execPath}\nif (${JSON.stringify(tool)} !== "status" && process.argv.slice(2).join(" ") !== "doctor --quiet") process.exit(99);\n${body}`,
      { mode: 0o755 },
    );
  for (const tool of ["worker", "ws", "ticket"])
    await member(tool, "process.exitCode = 0;");
  await member(
    "status",
    `await import(${JSON.stringify(join(import.meta.dir, "../../agx-status/src/status.ts"))});`,
  );
  const run = async (args = ["doctor", "--json"], timeout = 10000) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    });
    const [stdout, stderr, exit] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  return {
    root,
    state,
    member,
    run,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}
function decode(text: string): DoctorResponse {
  const result = jsonOf(DoctorResponse).safeParse(text);
  expect(result.success).toBe(true);
  return result.success
    ? result.data
    : {
        schema: 1,
        findings: [],
        kinds: {},
        total: 0,
        lost: 0,
        complete: false,
        captured_at: 0,
        members: [],
        stale: true,
        error: "decode failed",
        last_good_at: null,
      };
}
const finding = {
  tool: "agx-worker",
  object: "fixture/run",
  finding: "lost",
  remedy: "agx worker judge fixture reject",
};
const emit = `process.stdout.write(${JSON.stringify(JSON.stringify(finding) + "\n")});`;

test("default deadlines allow real-inventory durations and exit 1 findings", async () => {
  await using f = await fixture();
  await f.member(
    "worker",
    `await Bun.sleep(15000); ${emit} process.exitCode = 1;`,
  );
  await f.member(
    "ticket",
    `await Bun.sleep(30000); ${emit.replace("agx-worker", "agx-ticket")} process.exitCode = 1;`,
  );
  const result = await f.run(undefined, 40000);
  expect(result.exit, result.stderr).toBe(1);
  expect(result.stderr).toBe("");
  const data = decode(result.stdout);
  expect(data.complete).toBe(true);
  expect(data.total).toBe(2);
  for (const member of data.members) {
    expect(member).toMatchObject({
      complete: true,
      timed_out: false,
      deadline_ms: 60000,
      signal: null,
    });
  }
}, 45000);

test("member deadline names tool, budget and signal even with last-good findings", async () => {
  await using f = await fixture();
  expect((await f.run()).exit).toBe(0);
  await f.member("ticket", "await Bun.sleep(60000);");
  const result = await f.run(["doctor", "--json", "--timeout-ms", "500"]);
  expect(result.exit, result.stderr).toBe(2);
  expect(result.stderr).toContain(
    "agx-ticket exceeded 500 ms (signal SIGKILL, exit 137)",
  );
  const data = decode(result.stdout);
  expect(data).toMatchObject({ complete: false, stale: true, findings: [] });
  expect(data.members[2]).toMatchObject({
    tool: "agx-ticket",
    complete: false,
    timed_out: true,
    deadline_ms: 500,
    signal: "SIGKILL",
    exit: 137,
  });
  const status = await f.run(["status", "--json"]);
  expect(status.stdout).toContain('"timed_out":true');
});

test("external signal is not reported as a deadline kill", async () => {
  await using f = await fixture();
  await f.member("ticket", 'process.kill(process.pid, "SIGKILL");');
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(result.stderr).not.toContain("exceeded");
  expect(decode(result.stdout).members[2]).toMatchObject({
    timed_out: false,
    signal: "SIGKILL",
    exit: 137,
  });
});

test("public doctor refreshes, publishes exact output, and status reads the owned aggregate", async () => {
  await using f = await fixture();
  const clean = await f.run();
  expect(clean.exit, clean.stderr).toBe(0);
  expect(decode(clean.stdout)).toMatchObject({
    schema: 1,
    findings: [],
    kinds: {},
    total: 0,
    lost: 0,
    complete: true,
  });
  const path = join(f.state, "doctor-aggregate.json");
  const before = await stat(path);
  await f.member("worker", `${emit} process.exitCode = 1;`);
  const result = await f.run();
  expect(result.exit, result.stderr).toBe(1);
  const data = decode(result.stdout);
  expect(data).toMatchObject({
    findings: [finding],
    kinds: { lost: 1 },
    total: 1,
    lost: 1,
    complete: true,
    members: [
      { tool: "agx-worker", exit: 1, complete: true },
      { tool: "agx-ws", exit: 0, complete: true },
      { tool: "agx-ticket", exit: 0, complete: true },
    ],
  });
  expect(await Bun.file(path).text()).toBe(result.stdout);
  expect((await stat(path)).ino).not.toBe(before.ino);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await readdir(f.state)).toSorted()).toEqual([
    "doctor-aggregate.json",
    "doctor-refresh.sqlite",
    "doctor-refresh.sqlite.lock",
  ]);
  await f.member("status", `process.exit(99);`);
  // Use the real status entrypoint, with the same isolated owner state.
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../agx-status/src/status.ts"),
      "--json",
    ],
    {
      env: {
        ...subprocessEnvironment(),
        AGX_STATE_DIR: f.state,
        XDG_STATE_HOME: join(f.root, "xdg"),
        AGX_NEXT_STATE_DIR: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  const [out, err, exit] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  expect(exit, err).toBe(0);
  const status = jsonOf(z.object({ findings: DoctorResponse })).safeParse(out);
  expect(status.success).toBe(true);
  if (status.success) expect(status.data.findings).toEqual(data);
});

for (const [name, body] of [
  ["exit 2", "process.exitCode = 2;"],
  ["unexplained exit 1", "process.exitCode = 1;"],
  ["invalid JSONL", 'process.stdout.write("not json\\n");'],
  ["invalid record", 'process.stdout.write("{}\\n"); process.exitCode = 1;'],
  [
    "wrong tool",
    emit.replace("agx-worker", "agx-ticket") + "process.exitCode = 1;",
  ],
  ["findings with exit 0", emit],
  ["unexpected exit", "process.exitCode = 7;"],
  ["timeout", "await Bun.sleep(60000);"],
  ["oversized output", 'process.stdout.write("x".repeat(2 * 1024 * 1024));'],
] as const)
  test(`collection failure is incomplete, never a synthetic finding: ${name}`, async () => {
    await using f = await fixture();
    await f.member("worker", body);
    const result = await f.run(["doctor", "--json", "--timeout-ms", "500"]);
    expect(result.exit, result.stderr).toBe(2);
    const data = decode(result.stdout);
    expect(data.complete).toBe(false);
    expect(data.members[0]?.complete).toBe(false);
    expect(data.findings.every((row) => row.finding === "lost")).toBe(true);
    expect(data.stale).toBe(true);
    expect(data.error).toBeString();
    expect(data.last_good_at).toBeNull();
    expect(
      await Bun.file(join(f.state, "doctor-aggregate.json")).exists(),
    ).toBe(false);
    const status = await f.run(["status", "--json"]);
    expect(status.exit, status.stderr).toBe(0);
    const parsed = jsonOf(z.object({ findings: DoctorResponse })).safeParse(
      status.stdout,
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.findings).toEqual(data);
  });

test("valid findings survive invalid JSONL from another member", async () => {
  await using f = await fixture();
  await f.member("worker", `${emit} process.exitCode = 1;`);
  await f.member(
    "ws",
    'process.stdout.write("broken\\n"); process.exitCode = 2;',
  );
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(decode(result.stdout)).toMatchObject({
    complete: false,
    findings: [finding],
    total: 1,
    lost: 1,
  });
});

test("failed publication exits 2 and leaves the old target intact", async () => {
  await using f = await fixture();
  const path = join(f.state, "doctor-aggregate.json");
  await mkdir(path);
  await writeFile(join(path, "sentinel"), "old");
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(decode(result.stdout).complete).toBe(false);
  expect(await Bun.file(join(path, "sentinel")).text()).toBe("old");
  // C11 retains the coordination database; directory iteration order is unspecified.
  // Compare every entry so a leaked publication temporary file still fails.
  expect((await readdir(f.state)).toSorted()).toEqual([
    "doctor-aggregate.json",
    "doctor-refresh.sqlite",
    "doctor-refresh.sqlite.lock",
  ]);
});

test("doctor owns help and rejects invalid deadlines and operands before collection", async () => {
  await using f = await fixture();
  expect((await f.run(["doctor", "--help"])).stdout).toContain("--timeout-ms");
  for (const args of [
    ["--timeout-ms", "0"],
    ["--timeout-ms", "60001"],
    ["--timeout-ms", "NaN"],
    ["--deadline-ms", "0"],
    ["--deadline-ms", "125001"],
    ["--deadline-ms", "NaN"],
    ["extra"],
  ]) {
    const result = await f.run(["doctor", ...args]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
  }
  expect(await readdir(f.state)).toEqual([]);
});

test("missing member is incomplete while other member observations survive", async () => {
  await using f = await fixture();
  await rm(join(f.root, "agx-ws"));
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(decode(result.stdout).members[1]).toMatchObject({
    tool: "agx-ws",
    exit: null,
    complete: false,
  });
  expect(decode(result.stdout).findings).toEqual([]);
});

test("status exposes incomplete snapshots and refuses malformed ones over legacy success", async () => {
  await using f = await fixture();
  await f.member("worker", "process.exitCode = 2;");
  expect((await f.run()).exit).toBe(2);
  const status = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../agx-status/src/status.ts"),
        "--json",
      ],
      {
        env: {
          ...subprocessEnvironment(),
          AGX_STATE_DIR: f.state,
          XDG_STATE_HOME: join(f.root, "xdg"),
          AGX_NEXT_STATE_DIR: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [out, err, exit] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(exit, err).toBe(0);
    return out;
  };
  expect(await status()).toContain('"complete":false');
  expect(await status()).toContain('"stale":true');
  await writeFile(
    join(f.state, "doctor.json"),
    JSON.stringify({ kinds: {}, lost: 0, capturedAt: 0, complete: true }),
  );
  await writeFile(join(f.state, "doctor-aggregate.json"), "broken");
  const parsed = jsonOf(z.object({ findings: z.null() })).safeParse(
    await status(),
  );
  expect(parsed.success).toBe(true);
});

test("failed refresh retains last-good findings and reports the error through public status", async () => {
  await using f = await fixture();
  await f.member("worker", `${emit} process.exitCode = 1;`);
  const first = await f.run(["doctor", "--json", "--refresh"]);
  expect(first.exit, first.stderr).toBe(1);
  const good = decode(first.stdout);
  const path = join(f.state, "doctor-aggregate.json");
  const before = await stat(path);
  await f.member(
    "worker",
    'process.stdout.write("broken\\n"); process.exitCode = 2;',
  );
  const failed = await f.run(["doctor", "--json", "--refresh"]);
  expect(failed.exit, failed.stderr).toBe(2);
  const bad = decode(failed.stdout);
  expect(bad).toMatchObject({
    findings: good.findings,
    kinds: good.kinds,
    total: 1,
    lost: 1,
    captured_at: good.captured_at,
    last_good_at: good.captured_at,
    complete: false,
    stale: true,
  });
  expect(bad.error).toContain("incomplete");
  expect(await Bun.file(path).text()).toBe(first.stdout);
  expect((await stat(path)).ino).toBe(before.ino);
  const status = await f.run(["status", "--json"]);
  expect(status.exit, status.stderr).toBe(0);
  const parsed = jsonOf(
    z.object({ findings: DoctorResponse, poll_after_ms: z.number() }),
  ).safeParse(status.stdout);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.findings).toEqual(bad);
    expect(parsed.data.poll_after_ms).toBe(60000);
  }
  await f.member("worker", "process.exitCode = 0;");
  const recovered = await f.run(["doctor", "--json", "--refresh"]);
  expect(recovered.exit, recovered.stderr).toBe(0);
  expect(decode(recovered.stdout)).toMatchObject({
    stale: false,
    error: null,
    total: 0,
    complete: true,
  });
});

async function waitFor(path: string) {
  const until = performance.now() + 3000;
  while (!(await Bun.file(path).exists()) && performance.now() < until)
    await Bun.sleep(10);
  expect(await Bun.file(path).exists(), path).toBe(true);
}

function barrier() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      release?.();
    },
  };
}

test("doctor contract: a caller that arrives during a refresh returns the next refresh, never the one already running", async () => {
  await using f = await fixture();
  const previous = process.env.AGX_STATE_DIR;
  process.env.AGX_STATE_DIR = f.state;
  using _restoreEnv = {
    [Symbol.dispose]: () => {
      if (previous === undefined) delete process.env.AGX_STATE_DIR;
      else process.env.AGX_STATE_DIR = previous;
    },
  };
  const firstStarted = barrier();
  const firstFinish = barrier();
  const secondStarted = barrier();
  const secondFinish = barrier();
  const oldWaiting = barrier();
  const oldResume = barrier();
  const newerWaiting = barrier();
  const newerResume = barrier();
  let generation = 0;
  const collect = async () => {
    generation += 1;
    const current = generation;
    if (current === 1) {
      firstStarted.release();
      await firstFinish.promise;
    }
    if (current === 2) {
      secondStarted.release();
      await secondFinish.promise;
    }
    return {
      schema: 1 as const,
      findings: [],
      kinds: {},
      total: 0,
      lost: 0,
      captured_at: current,
      complete: true,
      members: (["agx-worker", "agx-ws", "agx-ticket"] as const).map(
        (tool) => ({
          tool,
          exit: 0,
          complete: true,
        }),
      ),
    };
  };
  const first = refreshDoctor(collect, 10000, 10000);
  await firstStarted.promise;
  const old = refreshDoctor(collect, 10000, 10000, async () => {
    oldWaiting.release();
    await oldResume.promise;
  });
  await oldWaiting.promise;
  const second = refreshDoctor(collect, 10000, 10000);
  firstFinish.release();
  await secondStarted.promise;
  const newer = refreshDoctor(collect, 10000, 10000, async () => {
    newerWaiting.release();
    await newerResume.promise;
  });
  await newerWaiting.promise;
  secondFinish.release();
  expect((await second).captured_at).toBe(2);
  newerResume.release();
  expect((await newer).captured_at).toBe(3);
  oldResume.release();
  expect((await old).captured_at).toBe(3);
  expect((await first).captured_at).toBe(1);
  expect(generation).toBe(3);
});

test("concurrent CLI refreshes serialize all members and coalesce callers into one pending round", async () => {
  await using f = await fixture();
  const events = join(f.root, "events");
  const gate = join(f.root, "gate");
  for (const tool of ["worker", "ws", "ticket"]) {
    await f.member(
      tool,
      `
      const { appendFile, mkdir, rm } = await import("node:fs/promises");
      const lock = ${JSON.stringify(f.root)} + "/active-${tool}";
      await mkdir(lock); // atomic: overlapping invocations of this member fail
      await appendFile(${JSON.stringify(events)}, "start ${tool}\\n");
      await Bun.write(${JSON.stringify(join(f.root, `started-${tool}`))}, "ready");
      while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(10);
      await Bun.sleep(80);
      await appendFile(${JSON.stringify(events)}, "end ${tool}\\n");
      await rm(lock, { recursive: true });
    `,
    );
  }
  const first = f.run(["doctor", "--json", "--refresh"]);
  await Promise.all(
    ["worker", "ws", "ticket"].map((tool) =>
      waitFor(join(f.root, `started-${tool}`)),
    ),
  );
  const pending = Array.from({ length: 6 }, () =>
    f.run(["doctor", "--json", "--refresh"]),
  );
  // Hold every member until all concurrent source CLIs have had time to join the queue.
  await Bun.sleep(750);
  await writeFile(gate, "go");
  const results = await Promise.all([first, ...pending]);
  for (const result of results) expect(result.exit, result.stderr).toBe(0);
  const responses = results.map((result) => decode(result.stdout));
  expect(
    new Set(responses.slice(1).map((response) => response.captured_at)).size,
  ).toBe(1);
  expect(responses[1]?.captured_at).toBeGreaterThan(
    responses[0]?.captured_at ?? 0,
  );
  const lines = (await Bun.file(events).text()).trim().split("\n");
  for (const tool of ["worker", "ws", "ticket"]) {
    expect(lines.filter((line) => line === `start ${tool}`).length).toBe(2);
    expect(lines.filter((line) => line === `end ${tool}`).length).toBe(2);
  }
  expect(lines.slice(0, 3).every((line) => line.startsWith("start "))).toBe(
    true,
  );
  expect(lines.slice(3, 6).every((line) => line.startsWith("end "))).toBe(true);
  expect(lines.slice(6, 9).every((line) => line.startsWith("start "))).toBe(
    true,
  );
  expect(lines.slice(9).every((line) => line.startsWith("end "))).toBe(true);
});

test("whole-request deadline kills a hanging collection and preserves the prior snapshot", async () => {
  await using f = await fixture();
  const good = await f.run();
  expect(good.exit, good.stderr).toBe(0);
  await f.member("worker", "await Bun.sleep(60000);");
  const started = performance.now();
  const result = await f.run([
    "doctor",
    "--json",
    "--refresh",
    "--timeout-ms",
    "60000",
    "--deadline-ms",
    "200",
  ]);
  expect(performance.now() - started).toBeLessThan(2500);
  expect(result.exit, result.stderr).toBe(2);
  expect(decode(result.stdout)).toMatchObject({
    stale: true,
    complete: false,
    captured_at: decode(good.stdout).captured_at,
  });
  expect(decode(result.stdout).error).toBeString();
  expect(await Bun.file(join(f.state, "doctor-aggregate.json")).text()).toBe(
    good.stdout,
  );
  await f.member("worker", "process.exitCode = 0;");
  expect((await f.run()).exit).toBe(0);
});

test("a waiting caller has its own deadline and does not cancel the owner", async () => {
  await using f = await fixture();
  const started = join(f.root, "owner-started");
  const gate = join(f.root, "owner-gate");
  await f.member(
    "worker",
    `
    await Bun.write(${JSON.stringify(started)}, "ready");
    while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(10);
  `,
  );
  const owner = f.run(["doctor", "--json", "--refresh"]);
  await waitFor(started);
  const waiter = await f.run([
    "doctor",
    "--json",
    "--refresh",
    "--deadline-ms",
    "100",
  ]);
  expect(waiter.exit, waiter.stderr).toBe(2);
  expect(decode(waiter.stdout)).toMatchObject({
    stale: true,
    last_good_at: null,
    complete: false,
  });
  expect(decode(waiter.stdout).error).toContain("waiting");
  await writeFile(gate, "go");
  const result = await owner;
  expect(result.exit, result.stderr).toBe(0);
  const status = await f.run(["status", "--json"]);
  expect(status.exit, status.stderr).toBe(0);
  expect(status.stdout).toContain('"error":null');
});


test("doctor contract: ws counts and the oldest unjudged run age per repository", async () => {
  await using f = await fixture();
  const summary = { type: "workspace_summary" as const, repo: "/repo", workspace_count: 2, unjudged_returned_runs: 1, oldest_unjudged_age_hours: 30, unjudged_warn_hours: 24 };
  const warning = { tool: "agx-ws", object: "/repo/runs", finding: "unjudged-age", remedy: "judge returned runs" };
  await f.member("ws", `process.stdout.write(${JSON.stringify(JSON.stringify(summary) + "\n" + JSON.stringify(warning) + "\n")}); process.exitCode = 1;`);
  const result = await f.run();
  expect(result.exit, result.stderr).toBe(1);
  const data = decode(result.stdout);
  expect(data.workspaces).toEqual([summary]);
  expect(data.kinds["unjudged-age"]).toBe(1);
});
