import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { decodedJson } from "./decode.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { judgeRun } from "../src/next/run.ts";
import { prepareTicketRepo } from "./ticket-repo.ts";
import { createTempTracker } from "./temp.ts";

setDefaultTimeout(90_000);

const temps = createTempTracker();
afterAll(temps.assertRemoved);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const store = resolve(import.meta.dir, "../src/next/store.ts");
const cli = resolve(import.meta.dir, "../src/next/cli.ts");
const Row = z.looseObject({ id: z.string(), kind: z.string() });

/** Another process that holds the publication lock (`current-runs.json`) until stdin closes. */
async function holdPublicationLock(root: string) {
  const script = join(root, "publication-holder.ts");
  writeFileSync(
    script,
    `import { join } from "node:path";
import { acquireWorkspaceLock } from ${JSON.stringify(store)};
const root = process.argv[2];
if (root === undefined) throw new Error("missing root");
const lock = await acquireWorkspaceLock(join(root, "current-runs.json"), root);
if (!lock.ok) throw new Error(lock.error);
const released = new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
  process.stdin.once("end", () => resolve());
});
process.stdout.write(String(process.pid) + "\\n");
await released;
await lock.release();
`,
  );
  const holder = Bun.spawn([process.execPath, script, root], {
    env: subprocessEnvironment(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const reader = holder.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const pid = Number(new TextDecoder().decode(first.value).trim());
  expect(pid).toBe(holder.pid);
  cleanups.push(async () => {
    await holder.stdin.end();
    await holder.exited;
  });
  return { pid, release: async () => holder.stdin.end() };
}

async function fixture() {
  const root = temps.register(
    mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-run-exits-`)),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await prepareTicketRepo(root);
  const state = join(root, "state");
  mkdirSync(state);
  const log = join(state, "records.jsonl");
  const ticket = join(root, "ticket.md");
  const worker = join(root, "worker.ts");
  writeFileSync(
    ticket,
    `+++\nschema = 2\nname = "exits-after-end"\nwrites = []\noutcome = "exit with the run"\nverify = ["true"]\n[proposition]\nid = "EXIT"\nclaim = "a run process exits once its run has ended"\nrefuted_by = "a process alive after the ended record"\n+++\nFixture.\n`,
  );
  writeFileSync(
    worker,
    `console.log(JSON.stringify({ report: { summary: "done", changes: [], checks: [], for_coordinator: [], open: [] }, vendor_session: "fixture-session" }));\n`,
  );
  const jev = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "mechanical", confidence: 0.9 } },
      }),
  });
  cleanups.push(async () => {
    await jev.stop(true);
  });
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "tmp"),
    JEV_URL: `http://127.0.0.1:${jev.port}/choice`,
    AGX_WORKER_BIN: worker,
    TYPESAFE_API_KEY: "test-key",
    AGX_CONFIG: new URL("../src/roster/policy.example.toml", import.meta.url)
      .pathname,
    AGX_DISPATCHER_SESSION: undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    CODEX_SESSION_ID: undefined,
  };
  const records = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .flatMap((line) => {
            const row = jsonOf(Row).safeParse(line);
            if (!row.success) return [];
            return [row.data];
          })
      : [];
  return { root, state, ticket, env, records, log };
}

test("a run process exits within seconds of its ended record while another process holds the publication lock", async () => {
  const f = await fixture();
  const holder = await holdPublicationLock(f.state);
  const child = Bun.spawn(
    [process.execPath, cli, "run", f.ticket, "--cd", f.root],
    { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 80_000 },
  );
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  const out = new Response(child.stdout).text();
  const err = new Response(child.stderr).text();
  let endedAt: number | undefined;
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline && child.exitCode === null) {
    if (f.records().some((row) => row.kind === "ended")) {
      endedAt = performance.now();
      break;
    }
    await Bun.sleep(10);
  }
  expect(endedAt, await err).toBeDefined();
  const exit = await child.exited;
  const afterEnd = performance.now() - (endedAt ?? 0);
  expect(exit, await err).toBe(0);
  // The holder keeps the lock for 30 s in the report; the run must not wait for it.
  expect(afterEnd).toBeLessThan(8_000);
  expect(
    decodedJson(
      z.looseObject({ exit: z.number() }),
      (await out).trim().split("\n").at(-1) ?? "{}",
    ),
  ).toMatchObject({ exit: 0 });
  expect(f.records().filter((row) => row.kind === "ended")).toHaveLength(1);
  // The workspace lock is released: the next run in this workspace is not refused.
  await holder.release();
});

test("judge returns within its bound while the publication lock is held, naming the lock and holder", async () => {
  const f = await fixture();
  const id = "judge-bound-fixture";
  writeFileSync(
    f.log,
    [
      {
        kind: "started",
        id,
        at: "2026-11-03T00:00:00Z",
        ticket: "fixture",
        writes: [],
        cwd: f.root,
        workspace: f.root,
        row: "fixture",
        dispatcher_session: null,
        vendor_session: null,
        pid: process.pid,
      },
      {
        kind: "ended",
        id,
        at: "2026-11-03T00:01:00Z",
        exit: 0,
        outcome: "ok",
        report_path: null,
        vendor_session: null,
        verify: [],
      },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
  const holder = await holdPublicationLock(f.state);
  const failures: string[] = [];
  const began = performance.now();
  const code = await judgeRun(
    { id, decision: "accept" },
    {
      root: f.state,
      lockWaitMs: 1_000,
      writeStdout: () => {},
      onLockFailure: (message, exitCode) => {
        failures.push(message);
        return exitCode;
      },
    },
  );
  const elapsed = performance.now() - began;
  expect(code).toBe(2);
  expect(elapsed).toBeLessThan(5_000);
  const message = failures.join("");
  expect(message).toContain(
    `publication lock ${join(f.state, "current-runs.json")}`,
  );
  expect(message).toContain("stayed busy past 1000ms");
  expect(message).toContain(`holder pid=${holder.pid}`);
  expect(message).toContain("publication-holder.ts");
  // Nothing was recorded: the judgment is not half-applied.
  expect(f.records().some((row) => row.kind === "judged")).toBe(false);
  await holder.release();
});
