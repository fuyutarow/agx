import { afterAll, afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { foldedRuns } from "../../src/next/store.ts";
import { createTempTracker } from "../temp.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";

const tempDirs = createTempTracker();
afterAll(tempDirs.assertRemoved);

const roots: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const vendorPids = new Set<number>();

afterEach(async () => {
  for (const child of processes.splice(0))
    if (child.exitCode === null) child.kill("SIGKILL");
  for (const server of servers.splice(0)) await server.stop(true);
  for (const pid of vendorPids) {
    Bun.spawnSync(["kill", "-KILL", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  vendorPids.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const Event = z.looseObject({
  kind: z.string(),
  id: z.string().optional(),
  vendor_session: z.string().nullable().optional(),
});
const eventsIn = (state: string) =>
  (existsSync(join(state, "records.jsonl"))
    ? readFileSync(join(state, "records.jsonl"), "utf8")
    : ""
  )
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(Event).safeParse(line);
      return parsed.success ? [parsed.data] : [];
    });

const waitFor = async <T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
): Promise<T> => {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  return assert.fail(`timed out waiting for ${description}`);
};

const fixture = async (reportedSession: boolean) => {
  const root = tempDirs.register(
    mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-session-persist-`)),
  );
  roots.push(root);
  await prepareTicketRepo(root);
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const ticket = join(root, "ticket.md");
  writeFileSync(
    ticket,
    `+++\nschema = 2\nname = "session-persist"\nwrites = []\noutcome = "continue the fake vendor run"\nverify = []\ntimeout_s = 120\n[proposition]\nid = "SESSION"\nclaim = "reported sessions persist"\nrefuted_by = "a lost run cannot resume its vendor session"\n+++\nRun the session persistence fixture.\n`,
  );

  const vendor = join(root, "fake-vendor.ts");
  const vendorPidPath = join(root, "fake-vendor.pid");
  const argvPath = join(root, "vendor-argv.jsonl");
  writeFileSync(
    vendor,
    `import { appendFileSync, writeFileSync } from "node:fs";
const resumeIndex = process.argv.indexOf("--resume");
if (process.env.AGX_TEST_HOLD === "1") {
  writeFileSync(${JSON.stringify(vendorPidPath)}, String(process.pid));
  if (process.env.AGX_TEST_SESSION !== "")
    await Bun.write(process.env.AGX_CODEX_PROGRESS_FILE, JSON.stringify({ schema: 1, at: "2026-10-27T00:00:00Z", last: "starting", commands: 0, turns: 0, files: 0, session: process.env.AGX_TEST_SESSION }));
  await Bun.sleep(60000);
  process.exit(97);
}
appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv) + "\\n");
const session = resumeIndex < 0 ? "fresh-session" : "resumed-" + process.argv[resumeIndex + 1];
process.stdout.write(JSON.stringify({ exit: 0, report: { summary: "done", changes: [], checks: [], for_coordinator: [], open: [] }, vendor_session: session }) + "\\n");
`,
  );

  const mise = join(bin, "mise");
  writeFileSync(mise, "#!/usr/bin/env bun\nconsole.log('{}');\n");
  chmodSync(mise, 0o755);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "luna-high", confidence: 0.9 } },
      }),
  });
  servers.push(server);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AGX_STATE_DIR: state,
    AGX_TMP_ROOT: join(root, "agx-tmp"),
    AGX_WORKER_BIN: vendor,
    AGX_CONFIG: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
    AGX_DISPATCHER_SESSION: "session-persist-test",
    AGX_TEST_HOLD: "1",
    AGX_TEST_SESSION: reportedSession ? "reported-vendor-session" : "",
    JEV_URL: `http://127.0.0.1:${server.port}/choice`,
    MISE_GLOBAL_CONFIG_FILE: join(root, "mise-config.toml"),
    TYPESAFE_API_KEY: "test-key",
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_STATE_HOME: join(root, "xdg-state"),
  };
  // The fake run must not inherit the verifier's outer systemd lease or vendor identity.
  // Otherwise loss detection can see the still-active verifier unit and miss this lost run.
  for (const key of [
    "AGX_RUN_ID",
    "AGX_RUN_DIR",
    "AGX_MSG_FROM",
    "AGX_WORKER_PATH_SOURCE",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "INVOCATION_ID",
  ] as const)
    delete env[key];

  const runArgs = [
    process.execPath,
    "tools/agx-worker/src/next/cli.ts",
    "run",
    ticket,
    "--cd",
    root,
    "--sandbox",
    "read-only",
  ];
  const start = () => {
    const child = Bun.spawn(runArgs, {
      cwd: process.cwd(),
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    processes.push(child);
    return child;
  };

  return {
    root,
    state,
    ticket,
    vendorPidPath,
    argvPath,
    env,
    runArgs,
    start,
  };
};

const killProcess = (pid: number): void => {
  const result = Bun.spawnSync(["kill", "-KILL", String(pid)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0)
    assert.fail(`could not kill fixture process ${pid}`);
};

const killRunAfterStart = async (
  f: Awaited<ReturnType<typeof fixture>>,
  reportedSession: boolean,
) => {
  const owner = f.start();
  const started = await waitFor(
    () =>
      eventsIn(f.state).find(
        (event) => event.kind === "started" && event.id !== undefined,
      )?.id,
    "started run record",
  );
  const pid = await waitFor(
    () => {
      const value = existsSync(f.vendorPidPath)
        ? Number(readFileSync(f.vendorPidPath, "utf8"))
        : undefined;
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0
        ? value
        : undefined;
    },
    "fake vendor process",
  );
  vendorPids.add(pid);

  if (reportedSession) {
    const event = await waitFor(
      () =>
        eventsIn(f.state).find(
          (entry) =>
            entry.kind === "session" &&
            entry.id === started &&
            entry.vendor_session === "reported-vendor-session",
        ),
      "persisted vendor session event",
    );
    expect(event.vendor_session).toBe("reported-vendor-session");
  } else {
    await Bun.sleep(150);
    expect(
      eventsIn(f.state).some(
        (event) => event.kind === "session" && event.id === started,
      ),
    ).toBe(false);
  }

  owner.kill("SIGKILL");
  await owner.exited;
  killProcess(pid);
  vendorPids.delete(pid);

  const lost = await waitFor(
    async () => (await foldedRuns(f.state)).find((run) => run.id === started),
    "lost run projection",
  );
  expect(lost).toMatchObject({
    id: started,
    state: "ended",
    outcome: "lost",
    vendor_session: reportedSession ? "reported-vendor-session" : null,
  });
  return started;
};

describe("worker contract: session persist", () => {
  test("a lost run keeps and resumes the session reported before work", async () => {
    const f = await fixture(true);
    const previousId = await killRunAfterStart(f, true);
    const result = Bun.spawnSync(
      [
        process.execPath,
        "tools/agx-worker/src/next/cli.ts",
        "run",
        f.ticket,
        "--cd",
        f.root,
        "--sandbox",
        "read-only",
        "--continue",
        previousId,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...f.env,
          AGX_TEST_HOLD: undefined,
          AGX_TEST_SESSION: undefined,
        },
        timeout: 15_000,
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const resumedArgs = jsonOf(z.array(z.string())).safeParse(
      readFileSync(f.argvPath, "utf8").trim(),
    );
    expect(resumedArgs.success).toBe(true);
    if (resumedArgs.success) {
      const resumeIndex = resumedArgs.data.indexOf("--resume");
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(resumedArgs.data.at(resumeIndex + 1)).toBe(
        "reported-vendor-session",
      );
    }
    expect(result.stderr.toString()).not.toContain("fresh session");
  }, 30_000);

  test("a lost run with no reported session starts fresh and says so", async () => {
    const f = await fixture(false);
    const previousId = await killRunAfterStart(f, false);
    const result = Bun.spawnSync(
      [
        process.execPath,
        "tools/agx-worker/src/next/cli.ts",
        "run",
        f.ticket,
        "--cd",
        f.root,
        "--sandbox",
        "read-only",
        "--continue",
        previousId,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...f.env,
          AGX_TEST_HOLD: undefined,
          AGX_TEST_SESSION: undefined,
        },
        timeout: 15_000,
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toContain(
      `run ${previousId} was lost before the vendor reported a session; continuing with a fresh session`,
    );
    const freshArgs = jsonOf(z.array(z.string())).safeParse(
      readFileSync(f.argvPath, "utf8").trim(),
    );
    expect(freshArgs.success).toBe(true);
    if (freshArgs.success) expect(freshArgs.data).not.toContain("--resume");
  }, 30_000);
});
