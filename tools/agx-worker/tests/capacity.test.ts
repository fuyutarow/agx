import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "../../shared/src/zod.ts";
import { decodedJson } from "./decode.ts";
import { capacityMessage, MODEL_WAIT_MS } from "../src/workers/capacity.ts";
import { loadRoster } from "../src/roster/index.ts";
import { prepareTicketRepo } from "./ticket-repo.ts";
import { runHealth } from "../src/next/health.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const Receipt = z.looseObject({
  outcome: z.string(),
  row: z.string().nullable().optional(),
  rows: z.array(z.string()).optional(),
  id: z.string().optional(),
});
const fixture = async () => {
  const root = await mkdtemp(
    join(tmpdir(), `agx-test-${process.pid}-capacity-`),
  );
  roots.push(root);
  const bin = join(root, "vendor");
  await writeFile(
    bin,
    await readFile(new URL("fixtures/capacity-vendor.ts", import.meta.url)),
  );
  await chmod(bin, 0o755);
  const workerCommand = join(root, "worker-command");
  await writeFile(
    workerCommand,
    `#!${process.execPath}\nconst child = Bun.spawn([process.execPath, ${JSON.stringify(new URL("../src/next/cli.ts", import.meta.url).pathname)}, ...process.argv.slice(2)], {stdin: "inherit", stdout: "inherit", stderr: "inherit"});\nprocess.exitCode = await child.exited;\n`,
  );
  await chmod(workerCommand, 0o755);
  const prompt = join(root, "brief.md");
  await writeFile(prompt, "Do work.");
  return { root, bin, prompt, workerCommand };
};
const execute = async (args: string[], env: NodeJS.ProcessEnv) => {
  const child = Bun.spawn([process.execPath, ...args], {
    env: {
      ...subprocessEnvironment(),
      AGX_CONFIG: new URL("../src/roster/policy.example.toml", import.meta.url)
        .pathname,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 8_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
};

const capacityDispatch = async (mode: string) => {
  const root = await mkdtemp(join(tmpdir(), `agx-test-${process.pid}-capacity-`));
  roots.push(root);
  const f = { root };
  await prepareTicketRepo(f.root);
  const worker = join(f.root, "capacity-worker.ts");
  await writeFile(
    worker,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const row = args[args.indexOf("--row") + 1] ?? "";
appendFileSync(process.env.AGX_CAPACITY_LOG ?? "", JSON.stringify(args) + "\\n");
const capacity = process.env.AGX_CAPACITY_FIXTURE === "capacity-fast" || row === "sol-medium";
const report = { summary: "fake vendor completed", changes: [], checks: [], for_coordinator: [], open: [] };
process.stdout.write(JSON.stringify(capacity ? { outcome: "capacity", cause: "fake vendor at capacity", vendor_session: "capacity-thread" } : { report, vendor_session: "astra-thread" }) + "\\n");
process.exitCode = capacity ? 75 : 0;
`,
  );
  const ticket = join(f.root, "capacity.md");
  await writeFile(
    ticket,
    '+++\nschema = 2\nname = "capacity"\ntimeout_s = 60\nwrites = []\ncapabilities = ["long-tool-loop"]\noutcome = "test capacity reroute"\nverify = []\n[proposition]\nid = "CAPACITY"\nclaim = "reroute capacity"\nrefuted_by = "same row retried"\n+++\nWork.\n',
  );
  const policyExample = new URL(
    "../src/roster/policy.example.toml",
    import.meta.url,
  ).pathname;
  const loaded = await loadRoster({ policyPath: policyExample });
  if (!loaded.ok) expect.unreachable(loaded.error);
  const keep = new Set(["sol-medium", "astra-medium"]);
  const excluded = loaded.value.choice
    .filter((row) => !keep.has(row.id))
    .map((row) => row.id);
  const policy = (await readFile(policyExample, "utf8"))
    .replace('default = "luna-high"', 'default = "sol-medium"')
    .replace("exclude = []", `exclude = ${JSON.stringify(excluded)}`);
  const policyPath = join(f.root, "policy.toml");
  await writeFile(policyPath, policy);
  const state = join(f.root, "state");
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: {
          worker: {
            choice: "sol-medium",
            probabilities: { "sol-medium": 1 },
          },
        },
      }),
  });
  const env = {
    AGX_STATE_DIR: state,
    JEV_URL: `http://127.0.0.1:${server.port}/`,
    TYPESAFE_API_KEY: "test-key",
    AGX_WORKER_BIN: worker,
    AGX_CAPACITY_FIXTURE: mode,
    AGX_CAPACITY_LOG: join(f.root, "invocations.jsonl"),
    AGX_TMP_ROOT: join(f.root, "tmp"),
    AGX_CONFIG: policyPath,
    AGX_DISPATCHER_SESSION: "test-dispatcher",
    HOME: f.root,
  };
  const run = () =>
    execute(
      [
        "tools/agx-worker/src/next/cli.ts",
        "run",
        ticket,
        "--cd",
        f.root,
        "--sandbox",
        "none",
      ],
      env,
    );
  return { f, ticket, state, server, env, run };
};

test("vendor capacity errors are distinct from auth, rate limits, and quoted worker output", () => {
  expect(MODEL_WAIT_MS).toBe(120_000);
  expect(
    capacityMessage(
      "Selected model is at capacity. Please try a different model.",
      "codex",
    ),
  ).toBeDefined();
  expect(
    capacityMessage(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "claude",
    ),
  ).toBeDefined();
  // Native Claude Code 2.1.306 emits this before retrying an HTTP 529 response.
  expect(
    capacityMessage(
      '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":529,"error":"overloaded"}',
      "claude",
    ),
  ).toBeDefined();
  expect(
    capacityMessage(
      '{"type":"system","subtype":"api_retry","error_status":429,"error":"rate_limited"}',
      "claude",
    ),
  ).toBeUndefined();
  expect(
    capacityMessage(
      '{"type":"assistant","error_status":529,"message":"overloaded_error is quoted text"}',
      "claude",
    ),
  ).toBeUndefined();
  expect(
    capacityMessage(
      '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
      "codex",
    ),
  ).toBeUndefined();
  expect(
    runHealth(
      {
        state: "ended",
        ended_at: "2026-10-19T00:00:00Z",
        outcome: "capacity",
        returned: false,
        judgment: null,
      },
      false,
    ),
  ).toBeUndefined();
  expect(
    capacityMessage(
      '{"type":"error","error":{"type":"rate_limit_error"}}',
      "claude",
    ),
  ).toBeUndefined();
  expect(
    capacityMessage(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Selected model is at capacity"}}',
      "codex",
    ),
  ).toBeUndefined();
});

test.each(["codex", "stderr", "stubborn", "wait", "claude", "claude-stderr"])(
  "%s capacity ends a hanging vendor within seconds",
  async (mode) => {
    const f = await fixture();
    const claude = mode.startsWith("claude");
    const args = claude
      ? [
          "tools/agx-worker/src/workers/run-claude.ts",
          "--target",
          f.root,
          "--model",
          "claude-sonnet-5-5",
          "--prompt-file",
          f.prompt,
          "--claude-bin",
          f.bin,
        ]
      : [
          "tools/agx-worker/src/workers/codex.ts",
          "--choice",
          "sol-medium",
          "--model",
          "gpt-6.1-sol",
          "--effort",
          "medium",
          "--sandbox",
          "none",
          "--cd",
          f.root,
          "--prompt-file",
          f.prompt,
          "--receipt-dir",
          f.root,
        ];
    const start = performance.now();
    const result = await execute(args, {
      AGX_CODEX_BIN: f.bin,
      AGX_CAPACITY_FIXTURE: mode,
      AGX_TEST_MODEL_WAIT_MS: mode === "wait" ? "100" : "2000",
      AGX_CODEX_HOST_FILE: join(f.root, "missing-host"),
    });
    expect(result.exit, result.stderr).toBe(75);
    expect(decodedJson(Receipt, result.stdout).outcome).toBe("capacity");
    expect(performance.now() - start).toBeLessThan(4_000);
    expect(result.stdout).toContain('"worker_fault":false');
  },
);

test("a worker doing real work can exceed the startup wait without capacity", async () => {
  const f = await fixture();
  const result = await execute(
    [
      "tools/agx-worker/src/workers/codex.ts",
      "--choice",
      "sol-medium",
      "--model",
      "gpt-6.1-sol",
      "--effort",
      "medium",
      "--sandbox",
      "none",
      "--cd",
      f.root,
      "--prompt-file",
      f.prompt,
      "--receipt-dir",
      f.root,
    ],
    {
      AGX_CODEX_BIN: f.bin,
      AGX_CAPACITY_FIXTURE: "working",
      AGX_TEST_MODEL_WAIT_MS: "1000",
    },
  );
  expect(result.exit, result.stderr).toBe(0);
  expect(decodedJson(Receipt, result.stdout).outcome).toBe("ok");
});

test("authentication failures remain worker errors rather than cooling a model", async () => {
  const f = await fixture();
  const result = await execute(
    [
      "tools/agx-worker/src/workers/codex.ts",
      "--choice",
      "sol-medium",
      "--model",
      "gpt-6.1-sol",
      "--effort",
      "medium",
      "--sandbox",
      "none",
      "--cd",
      f.root,
      "--prompt-file",
      f.prompt,
      "--receipt-dir",
      f.root,
    ],
    { AGX_CODEX_BIN: f.bin, AGX_CAPACITY_FIXTURE: "auth" },
  );
  expect(result.exit).toBe(1);
  expect(decodedJson(Receipt, result.stdout).outcome).toBe("codex-failed");
});

// measured 5010ms on alpha 1.22.5 under host load
test("route contract: capacity reroutes within one run and keeps a same-vendor session", async () => {
  const { f, state, server, env, run } = await capacityDispatch("sol-only");
  await using _server = {
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
    },
  };

  const at = Temporal.Now.instant();
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "records.jsonl"),
    `${JSON.stringify({
      kind: "started",
      id: "prior-capacity",
      at: at.subtract({ seconds: 1 }).toString(),
      ticket: "prior-capacity",
      writes: [],
      cwd: f.root,
      workspace: f.root,
      row: "sol-medium",
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
    })}\n${JSON.stringify({
      kind: "ended",
      id: "prior-capacity",
      at: at.toString(),
      exit: 75,
      outcome: "capacity",
      report_path: null,
      vendor_session: null,
      verify: [],
    })}\n`,
  );

  const result = await run();
  expect(result.exit, result.stderr).toBe(0);
  const receipt = decodedJson(Receipt, result.stdout);
  expect(receipt).toMatchObject({
    row: "astra-medium",
    rows: ["sol-medium", "astra-medium"],
    outcome: "no-change",
  });
  if (receipt.id === undefined) return;

  const calls = (await readFile(join(f.root, "invocations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => decodedJson(z.array(z.string()), line));
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[calls[0].indexOf("--row") + 1]).toBe("sol-medium");
  expect(calls[1]?.[calls[1].indexOf("--row") + 1]).toBe("astra-medium");
  expect(calls[1]).toContain("--resume");
  expect(calls[1]).toContain("capacity-thread");

  const listed = await execute(
    ["tools/agx-worker/src/next/cli.ts", "ls", "--json"],
    env,
  );
  expect(listed.exit, listed.stderr).toBe(0);
  const runs = decodedJson(
    z.array(
      z.looseObject({
        id: z.string(),
        row: z.string(),
        model: z.string().optional(),
        outcome: z.string(),
        rows: z.array(z.string()).optional(),
      }),
    ),
    listed.stdout,
  );
  const current = runs.filter((record) => record.id === receipt.id);
  expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({
    row: "astra-medium",
    model: "gpt-6-astra",
    outcome: "no-change",
    rows: ["sol-medium", "astra-medium"],
  });
}, 11000);

// measured 5023ms on alpha 1.22.5 under host load
test("route contract: capacity exhausts eligible rows within the ticket time box", async () => {
  const { f, server, env, run } = await capacityDispatch("capacity-fast");
  await using _server = {
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
    },
  };

  const before = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - before;
  expect(result.exit, result.stderr).toBe(75);
  expect(elapsedMs).toBeLessThan(10_000);
  const receipt = decodedJson(Receipt, result.stdout);
  expect(receipt).toMatchObject({
    row: "astra-medium",
    rows: ["sol-medium", "astra-medium"],
    outcome: "capacity",
  });
  if (receipt.id === undefined) return;

  const calls = (await readFile(join(f.root, "invocations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => decodedJson(z.array(z.string()), line));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("--resume");
  expect(calls[1]).toContain("capacity-thread");
  const listed = await execute(
    ["tools/agx-worker/src/next/cli.ts", "ls", "--json"],
    env,
  );
  expect(listed.exit, listed.stderr).toBe(0);
  const runs = decodedJson(
    z.array(
      z.looseObject({
        id: z.string(),
        row: z.string(),
        model: z.string().optional(),
        outcome: z.string(),
        rows: z.array(z.string()).optional(),
      }),
    ),
    listed.stdout,
  );
  expect(runs.filter((record) => record.id === receipt.id)).toMatchObject([
    {
      row: "astra-medium",
      model: "gpt-6-astra",
      outcome: "capacity",
      rows: ["sol-medium", "astra-medium"],
    },
  ]);
}, 11000);
