import { afterEach, expect, test } from "bun:test";
import { fromThrowable } from "neverthrow";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { leaseFor } from "../../src/next/lease.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

async function cleanupRoot(root: string) {
  const records = await Bun.file(join(root, "state", "records.jsonl"))
    .text()
    .catch(() => "");
  for (const line of records.split("\n")) {
    const parsed = jsonOf(
      z.looseObject({
        kind: z.literal("started"),
        lease: z.object({ pid: z.number(), start: z.string().nullable() }),
      }),
    ).safeParse(line);
    if (
      parsed.success &&
      parsed.data.lease.start !== null &&
      (await leaseFor(parsed.data.lease.pid, null)).start ===
        parsed.data.lease.start
    ) {
      fromThrowable(() => process.kill(parsed.data.lease.pid, "SIGTERM"))();
    }
  }
  const pids = jsonOf(z.array(z.number())).safeParse(
    await Bun.file(join(root, "pids"))
      .text()
      .catch(() => ""),
  );
  if (pids.success)
    for (const pid of pids.data) {
      fromThrowable(() => process.kill(pid, "SIGKILL"))();
    }
}

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => cleanupRoot(root)));
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) await server.stop(true);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const cli = resolve("tools/agx/src/agx.ts");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agx-stop-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  const wrapper = join(root, "agx-worker");
  await Bun.write(
    wrapper,
    `#!${process.execPath}\nconst child = Bun.spawn([process.execPath, ${JSON.stringify(resolve("tools/agx-worker/src/next/cli.ts"))}, ...process.argv.slice(2)], {stdin:"inherit", stdout:"inherit", stderr:"inherit"}); process.exit(await child.exited);`,
  );
  await chmod(wrapper, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "xdg"),
    XDG_CONFIG_HOME: join(root, "config"),
    AGX_DISPATCHER_SESSION: "stop-fixture",
    MISE_TRUSTED_CONFIG_PATHS: process.cwd(),
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, "worker", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, out, err };
  };
  return { root, state, env, invoke };
}
const row = (root: string, pid: number) => ({
  kind: "started",
  id: "fixture-run",
  at: Temporal.Now.instant().toString(),
  ticket: "fixture",
  writes: [],
  cwd: root,
  workspace: root,
  row: "luna-high",
  dispatcher_session: null,
  vendor_session: null,
  pid,
});

async function unitRun(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { stopExit: number; stopStderr?: string; signal?: boolean },
) {
  const owner = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  children.push(owner);
  const unit = "agt_stop-contract.service";
  const started = {
    ...row(f.root, owner.pid),
    lease: await leaseFor(owner.pid, unit),
  };
  await Bun.write(
    join(f.state, "records.jsonl"),
    `${JSON.stringify(started)}\n`,
  );
  const binary = join(f.root, "systemctl");
  await Bun.write(
    binary,
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.includes("--property=MainPID")) process.stdout.write(${JSON.stringify(String(owner.pid))}); else if (args.includes("stop")) { if (${options.signal === true}) process.kill(${owner.pid}, "SIGKILL"); const reason = ${JSON.stringify(options.stopStderr ?? "")}; if (reason !== "") process.stderr.write(reason); process.exit(${options.stopExit}); } else process.exit(2);`,
  );
  await chmod(binary, 0o755);
  f.env.PATH = `${f.root}:${f.env.PATH ?? ""}`;
  return { owner, started };
}

test("stop contract: stopping a running worker reports stopped", async () => {
  const f = await fixture();
  const { owner, started } = await unitRun(f, {
    stopExit: 1,
    signal: true,
  });
  const stopped = await f.invoke("stop", started.id);
  expect(await owner.exited).toBe(137);
  expect(stopped.exit, stopped.err).toBe(0);
  expect(stopped.out).toContain(`stopped ${started.id}`);
  expect(stopped.err).not.toContain("cannot stop");
  const listed = await f.invoke("ls", started.id, "--json");
  expect(listed.out).toContain('"state":"ended"');
  expect(listed.out).toContain('"outcome":"stopped"');
});

test("stop contract: stopping an ended run says it already ended", async () => {
  const f = await fixture();
  const endedAt = "2026-10-28T04:09:32.110041291Z";
  await Bun.write(
    join(f.state, "records.jsonl"),
    [
      row(f.root, 1),
      {
        kind: "ended",
        id: "fixture-run",
        at: endedAt,
        exit: 0,
        outcome: "ok",
        vendor_session: null,
        report_path: null,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const stopped = await f.invoke("stop", "fixture-run");
  expect(stopped.exit).toBe(0);
  expect(stopped.err).toContain("already ended");
  expect(stopped.err).toContain("outcome=ok");
  expect(stopped.err).toContain(endedAt);
  expect(stopped.err).not.toContain("cannot stop");
  expect(await Bun.file(join(f.state, "records.jsonl")).text()).not.toContain(
    "stop-requested",
  );
});

test("stop contract: a failed stop names its reason and exits non-zero", async () => {
  const f = await fixture();
  const { owner, started } = await unitRun(f, { stopExit: 23 });
  const stopped = await f.invoke("stop", started.id);
  expect(owner.exitCode).toBeNull();
  expect(stopped.exit).not.toBe(0);
  expect(stopped.err).toContain("systemctl exited with status 23");
  expect(stopped.err).not.toContain("service: ;");
});

test("unknown, ended, ownerless and reused PID records never signal an unrelated process", async () => {
  const f = await fixture();
  const unrelated = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  children.push(unrelated);
  expect((await f.invoke("stop", "unknown")).err).toContain("unknown run id");
  const started = row(f.root, unrelated.pid);
  for (const lease of [
    undefined,
    { ...(await leaseFor(unrelated.pid, null)), start: "wrong-boot:1" },
  ]) {
    await Bun.write(
      join(f.state, "records.jsonl"),
      `${JSON.stringify({ ...started, lease })}\n`,
    );
    expect((await f.invoke("stop", started.id)).exit).toBe(
      lease === undefined ? 2 : 1,
    );
    expect(unrelated.exitCode).toBeNull();
  }
  await Bun.write(
    join(f.state, "records.jsonl"),
    `${JSON.stringify(started)}\n${JSON.stringify({ kind: "ended", id: started.id, at: Temporal.Now.instant().toString(), exit: 0, outcome: "ok", vendor_session: null, report_path: null })}\n`,
  );
  const ended = await f.invoke("stop", started.id);
  expect(ended.exit).toBe(0);
  expect(ended.err).toContain("already ended");
  expect(unrelated.exitCode).toBeNull();
});

for (const { unit, session } of [
  { unit: null, session: "fake-session" },
  { unit: "agt_stop-fixture", session: "fake-session" },
  { unit: "agt_stop-fixture-c2", session: "fake-session" },
  { unit: null, session: null },
]) {
  test(`real run stop under ${unit ?? "PID lease"} preserves session=${session !== null}`, async () => {
    const f = await fixture();
    await prepareTicketRepo(f.root);
    const ticket = join(f.root, "ticket.md");
    await Bun.write(
      ticket,
      '+++\nschema = 2\nname = "stop-fixture"\nwrites = []\noutcome = "stop fixture"\nverify = []\n[proposition]\nid = "STOP"\nclaim = "stops"\nrefuted_by = "vendor remains"\n+++\nWait.\n',
    );
    const worker = join(f.root, "worker.ts");
    const resumedSession = join(f.root, "resumed-session");
    await Bun.write(
      worker,
      `const resumeIndex = process.argv.indexOf("--resume");\nif (resumeIndex >= 0 && process.env.AGX_TEST_FINISH_RESUME === "1") { const session = process.argv[resumeIndex + 1]; await Bun.write(${JSON.stringify(resumedSession)}, session); process.stdout.write(JSON.stringify({ exit: 0, report: { summary: "resumed", changes: [], checks: [], for_coordinator: [], open: [] }, vendor_session: session }) + "\\n"); } else { if (process.env.AGX_TEST_VENDOR_SESSION !== undefined) await Bun.write(process.env.AGX_CODEX_PROGRESS_FILE, JSON.stringify({ schema: 1, last: "vendor started", at: Temporal.Now.instant().toString(), commands: 0, files: 0, session: process.env.AGX_TEST_VENDOR_SESSION })); const descendant = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdout:"ignore",stderr:"ignore"}); await Bun.write(${JSON.stringify(join(f.root, "pids"))}, JSON.stringify([process.pid, descendant.pid])); setInterval(() => {}, 1000); }`,
    );
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ answers: { worker: { choice: "luna-high" } } }),
    });
    servers.push(server);
    Object.assign(f.env, {
      AGX_WORKER_BIN: worker,
      AGX_TMP_ROOT: join(f.root, "tmp"),
      JEV_URL: `http://127.0.0.1:${server.port}`,
      TYPESAFE_API_KEY: "test",
      AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
      AGX_WORKER_PATH_SOURCE: "dispatcher",
      ...(session === null ? {} : { AGX_TEST_VENDOR_SESSION: session }),
    });
    const resumed = unit?.endsWith("-c2") === true;
    if (resumed) {
      await Bun.write(
        join(f.state, "records.jsonl"),
        [
          { ...row(f.root, 0), id: "previous", ticket: "stop-fixture" },
          {
            kind: "ended",
            id: "previous",
            at: Temporal.Now.instant().toString(),
            exit: 0,
            outcome: "ok",
            vendor_session: "fake-session",
            report_path: null,
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
    }
    const runArgs = [
      "worker",
      "run",
      ticket,
      "--cd",
      f.root,
      ...(resumed ? ["--continue", "previous"] : []),
      ...(unit === null
        ? []
        : [
            "--dispatch-binding",
            JSON.stringify({
              id: crypto.randomUUID(),
              ticket: "stop-fixture",
              workspace: f.root,
              unit,
            }),
          ]),
    ];
    if (unit !== null) {
      f.env.INVOCATION_ID = "fixture-invocation";
      await Bun.write(
        join(f.root, "systemd-run"),
        `#!${process.execPath}\nconst args = process.argv.slice(2); const child = Bun.spawn([process.execPath, ${JSON.stringify(cli)}, ...args.slice(args.indexOf("--") + 2)], {env:process.env, stdout:"inherit", stderr:"inherit"}); await Bun.write(${JSON.stringify(join(f.root, "main-pid"))}, String(process.pid)); process.exit(await child.exited);`,
      );
      await chmod(join(f.root, "systemd-run"), 0o755);
      await Bun.write(
        join(f.root, "systemctl"),
        `#!${process.execPath}\nconst args = process.argv.slice(2); if (!args.includes(${JSON.stringify(`${unit}.service`)})) process.exit(2); if (args.includes("show")) { if (args.includes("--property=MainPID")) process.stdout.write(await Bun.file(${JSON.stringify(join(f.root, "main-pid"))}).text()); else if (args.includes("--property=ControlGroup")) process.stdout.write((await Bun.file("/proc/self/cgroup").text()).trim().split(":").slice(2).join(":")); else process.stdout.write("active"); } else { await Bun.write(${JSON.stringify(join(f.root, "unit-call"))}, JSON.stringify(args)); const started = (await Bun.file(${JSON.stringify(join(f.state, "records.jsonl"))}).text()).trim().split("\\n").map(line => JSON.parse(line)).findLast(event => event.kind === "started"); process.kill(started.pid, "SIGTERM"); }`,
      );
      await chmod(join(f.root, "systemctl"), 0o755);
    } else {
      Reflect.deleteProperty(f.env, "INVOCATION_ID");
    }
    const owner = Bun.spawn(
      unit === null
        ? [process.execPath, cli, ...runArgs]
        : [
            join(f.root, "systemd-run"),
            "--user",
            `--unit=${unit}`,
            "--",
            "agx",
            ...runArgs,
          ],
      { env: f.env, stdout: "ignore", stderr: "pipe", timeout: 30000 },
    );
    children.push(owner);
    const ownerError = new Response(owner.stderr).text();
    for (
      let i = 0;
      i < 400 && !(await Bun.file(join(f.root, "pids")).exists());
      i += 1
    )
      await Bun.sleep(25);
    expect(
      await Bun.file(join(f.root, "pids")).exists(),
      owner.exitCode === null ? "vendor startup timed out" : await ownerError,
    ).toBe(true);
    const records = await Bun.file(join(f.state, "records.jsonl")).text();
    const start = records.split("\n").flatMap((line) => {
      const parsed = jsonOf(
        z.looseObject({ kind: z.literal("started"), id: z.string() }),
      ).safeParse(line);
      return parsed.success && parsed.data.id !== "previous"
        ? [parsed.data]
        : [];
    })[0];
    if (start === undefined) expect.unreachable("started record is missing");
    const stopped = await f.invoke("stop", start.id.slice(0, 12));
    expect(stopped.exit, stopped.err).toBe(0);
    expect(await owner.exited, await ownerError).toBe(143);
    if (unit !== null) {
      expect(await Bun.file(join(f.root, "unit-call")).text()).toBe(
        JSON.stringify(["--user", "stop", `${unit}.service`]),
      );
      expect(records).toContain(`"unit":"${unit}.service"`);
    }
    if (resumed) expect(records).toContain('"continues":"previous"');
    const pids = jsonOf(z.array(z.number())).safeParse(
      await Bun.file(join(f.root, "pids")).text(),
    );
    expect(pids.success).toBe(true);
    if (!pids.success) return;
    for (const pid of pids.data)
      expect((await leaseFor(pid, null)).start).toBeNull();
    const listed = await f.invoke("ls", start.id, "--json");
    expect(listed.exit).toBe(0);
    expect(listed.out).toContain('"outcome":"stopped"');
    expect(listed.out).toContain('"stopped_by":"stop-fixture"');
    expect(listed.out).toContain(
      `"vendor_session":${session === null ? "null" : JSON.stringify(session)}`,
    );
    expect((await f.invoke("stop", start.id)).err).toContain("already ended");
    if (session === null) {
      expect(stopped.out).toContain("not continuable");
      const refused = await f.invoke(
        "run",
        ticket,
        "--cd",
        f.root,
        "--continue",
        start.id,
      );
      expect(refused.exit).toBe(2);
      expect(refused.err).toContain("has no vendor session to continue");
    } else if (unit === null) {
      f.env.AGX_TEST_FINISH_RESUME = "1";
      const continued = await f.invoke(
        "run",
        ticket,
        "--cd",
        f.root,
        "--continue",
        start.id,
      );
      expect(continued.exit, continued.err).toBe(0);
      expect(await Bun.file(resumedSession).text()).toBe(session);
    }
  });
}

test("systemd stop uses only a matching recorded unit and PID", async () => {
  const f = await fixture();
  const owner = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  children.push(owner);
  const lease = await leaseFor(owner.pid, "agt_fixture.service");
  await Bun.write(
    join(f.state, "records.jsonl"),
    `${JSON.stringify({ ...row(f.root, owner.pid), lease })}\n`,
  );
  const binary = join(f.root, "systemctl");
  await Bun.write(
    binary,
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.includes("show")) process.stdout.write(String(${owner.pid})); else { await Bun.write(${JSON.stringify(join(f.root, "unit-call"))}, JSON.stringify(args)); process.kill(${owner.pid}, "SIGKILL"); }`,
  );
  await chmod(binary, 0o755);
  f.env.PATH = `${f.root}:${f.env.PATH ?? ""}`;
  // A live PID in a different unit must not authorize stopping that unit.
  const matchingBinary = await Bun.file(binary).text();
  await Bun.write(
    binary,
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.includes("--property=MainPID")) process.stdout.write("1"); else if (args.includes("--property=ControlGroup")) process.stdout.write("/unrelated.service"); else process.exit(2);`,
  );
  const refused = await f.invoke("stop", "fixture-run");
  expect(refused.exit).toBe(2);
  expect(refused.err).toContain("no longer owns run");
  expect(owner.exitCode).toBeNull();
  expect(await Bun.file(join(f.root, "unit-call")).exists()).toBe(false);
  await Bun.write(binary, matchingBinary);
  expect((await f.invoke("stop", "fixture-run")).exit).toBe(0);
  expect(await Bun.file(join(f.root, "unit-call")).text()).toBe(
    JSON.stringify(["--user", "stop", "agt_fixture.service"]),
  );
  expect((await f.invoke("ls", "--json")).out).toContain('"outcome":"stopped"');
});

test("an inferred lost owner without an end record is refused", async () => {
  const f = await fixture();
  const owner = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  children.push(owner);
  const lease = await leaseFor(owner.pid, "agt_ended-c2.service");
  await Bun.write(
    join(f.state, "records.jsonl"),
    `${JSON.stringify({ ...row(f.root, owner.pid), lease })}\n`,
  );
  owner.kill("SIGKILL");
  await owner.exited;
  const binary = join(f.root, "systemctl");
  await Bun.write(
    binary,
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.includes("--property=ActiveState")) process.stdout.write("inactive"); else if (args.includes("--property=Result")) process.stdout.write("success"); else { await Bun.write(${JSON.stringify(join(f.root, "unit-call"))}, JSON.stringify(args)); process.exit(2); }`,
  );
  await chmod(binary, 0o755);
  const ended = await f.invoke("stop", "fixture-run");
  expect(ended.exit).toBe(1);
  expect(ended.err).toContain("inferred outcome lost");
  expect(ended.err).toContain("without a recorded end time");
  expect(ended.out).not.toContain("already ended");
  expect(await Bun.file(join(f.root, "unit-call")).exists()).toBe(false);
  expect(await Bun.file(join(f.state, "records.jsonl")).text()).not.toContain(
    "stop-requested",
  );
});

test("a direct systemctl stop retains a started vendor session for continuation", async () => {
  const f = await fixture();
  await prepareTicketRepo(f.root);
  const ticket = join(f.root, "ticket.md");
  await Bun.write(
    ticket,
    '+++\nschema = 2\nname = "signal-fixture"\nwrites = []\noutcome = "signal fixture"\nverify = []\n[proposition]\nid = "SIGNAL"\nclaim = "preserves sessions"\nrefuted_by = "a stopped session is lost"\n+++\nWait.\n',
  );
  const unit = "agt_signal-fixture";
  const session = "fake-vendor-session";
  const ready = join(f.root, "vendor-ready");
  const resumed = join(f.root, "resumed-session");
  const worker = join(f.root, "worker.ts");
  await Bun.write(
    worker,
    `const resumeIndex = process.argv.indexOf("--resume");\nif (resumeIndex >= 0) { const session = process.argv[resumeIndex + 1]; await Bun.write(${JSON.stringify(resumed)}, session); process.stdout.write(JSON.stringify({ exit: 0, report: { summary: "resumed", changes: [], checks: [], for_coordinator: [], open: [] }, vendor_session: session }) + "\\n"); } else { await Bun.write(process.env.AGX_CODEX_PROGRESS_FILE, JSON.stringify({ schema: 1, last: "vendor started", at: Temporal.Now.instant().toString(), commands: 0, files: 0, session: ${JSON.stringify(session)} })); await Bun.write(${JSON.stringify(ready)}, "started"); setInterval(() => {}, 1000); }\n`,
  );
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ answers: { worker: { choice: "luna-high" } } }),
  });
  servers.push(server);
  Object.assign(f.env, {
    AGX_WORKER_BIN: worker,
    AGX_TMP_ROOT: join(f.root, "tmp"),
    JEV_URL: `http://127.0.0.1:${server.port}`,
    TYPESAFE_API_KEY: "test",
    AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
    AGX_WORKER_PATH_SOURCE: "dispatcher",
    INVOCATION_ID: "fixture-invocation",
  });
  const binding = {
    id: crypto.randomUUID(),
    ticket: "signal-fixture",
    workspace: f.root,
    unit,
  };
  const owner = Bun.spawn(
    [
      process.execPath,
      cli,
      "worker",
      "run",
      ticket,
      "--cd",
      f.root,
      "--dispatch-binding",
      JSON.stringify(binding),
    ],
    { env: f.env, stdout: "ignore", stderr: "pipe", timeout: 30000 },
  );
  children.push(owner);
  const ownerError = new Response(owner.stderr).text();
  for (let i = 0; i < 400 && !(await Bun.file(ready).exists()); i += 1)
    await Bun.sleep(25);
  const vendorReady = await Bun.file(ready).exists();
  expect(
    vendorReady,
    owner.exitCode === null
      ? "fake vendor startup timed out"
      : await ownerError,
  ).toBe(true);
  const recordsPath = join(f.state, "records.jsonl");
  const beforeStop = (await Bun.file(recordsPath).text())
    .trim()
    .split("\n")
    .flatMap((line) => {
      const event = jsonOf(
        z.looseObject({ kind: z.string(), id: z.string() }),
      ).safeParse(line);
      return event.success ? [event.data] : [];
    });
  const started = beforeStop.findLast((event) => event.kind === "started");
  if (started === undefined) expect.unreachable("started event is missing");
  const systemctl = join(f.root, "systemctl");
  await Bun.write(
    systemctl,
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (JSON.stringify(args) !== JSON.stringify(["--user", "stop", ${JSON.stringify(`${unit}.service`)}])) process.exit(2); const events = (await Bun.file(${JSON.stringify(recordsPath)}).text()).trim().split("\\n").map(line => JSON.parse(line)); const started = events.findLast(event => event.kind === "started"); process.kill(started.pid, "SIGTERM");`,
  );
  await chmod(systemctl, 0o755);
  const stoppedBySystemd = Bun.spawnSync(
    [systemctl, "--user", "stop", `${unit}.service`],
    { env: f.env, timeout: 5000 },
  );
  expect(stoppedBySystemd.exitCode, stoppedBySystemd.stderr.toString()).toBe(0);
  expect(await owner.exited, await ownerError).toBe(143);
  const afterStop = (await Bun.file(recordsPath).text())
    .trim()
    .split("\n")
    .flatMap((line) => {
      const event = jsonOf(
        z.looseObject({
          kind: z.string(),
          id: z.string(),
          vendor_session: z.string().nullable().optional(),
        }),
      ).safeParse(line);
      return event.success ? [event.data] : [];
    });
  const ended = afterStop.findLast(
    (event) => event.kind === "ended" && event.id === started.id,
  );
  expect(ended?.vendor_session).toBe(session);

  const continued = await f.invoke(
    "run",
    ticket,
    "--cd",
    f.root,
    "--continue",
    started.id,
  );
  expect(continued.exit, continued.err).toBe(0);
  expect(await Bun.file(resumed).text()).toBe(session);
});
