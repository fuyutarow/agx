import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
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
import { z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { loadRoster } from "../../src/roster/index.ts";
import { runClaude, toRelay } from "../../src/workers/run-claude.ts";
import { route } from "../../src/next/route.ts";
import { routingEvents } from "../../src/next/routing-events.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { decoded, decodedJson } from "../decode.ts";

setDefaultTimeout(60_000);

const cliPath = new URL("../../src/next/cli.ts", import.meta.url).pathname;
const examplePolicy = new URL(
  "../../src/roster/policy.example.toml",
  import.meta.url,
).pathname;

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const saved = Object.fromEntries(
  [
    "AGX_CONFIG",
    "AGX_STATE_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "HOME",
    "JEV_URL",
    "PATH",
    "TYPESAFE_API_KEY",
    "XDG_CONFIG_HOME",
  ].map((name) => [name, process.env[name]]),
);

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agx-credits-unavailable-"));
  roots.push(root);
  return root;
}

const Call = z.looseObject({ key: z.boolean(), token: z.boolean() });

/** A fake claude: with an API key it fails with the credits error, without one it answers. */
function fakeClaude(root: string): { bin: string; calls: () => unknown[] } {
  const bin = join(root, "claude");
  const log = join(root, "claude-calls.jsonl");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '{"key":%s,"token":%s}\\n' "$([ -n "$ANTHROPIC_API_KEY" ] && echo true || echo false)" "$([ -n "$ANTHROPIC_AUTH_TOKEN" ] && echo true || echo false)" >> ${JSON.stringify(log)}\nif [ -n "$ANTHROPIC_API_KEY" ]; then echo "Credit balance too low" >&2; exit 1; fi\nprintf '{"result":"ok"}\\n'\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodedJson(Call, line));
    },
  };
}

function isolatedWorkerEnvironment(root: string) {
  process.env.HOME = root;
  process.env.AGX_STATE_DIR = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "inline-test-secret";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

function runConfig(root: string, claudeBin: string, extra = {}) {
  return {
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 10_000,
    safeMode: false,
    bare: false,
    claudeBin,
    route: "claude-api" as const,
    ...extra,
  };
}

test("the worker CLI defaults to stop: a credits failure ends as capacity on the first attempt, writes the marker and never starts a subscription attempt", async () => {
  const root = tempRoot();
  isolatedWorkerEnvironment(root);
  const claude = fakeClaude(root);
  writeFileSync(join(root, "brief.md"), "hello");
  const child = Bun.spawn(
    [
      process.execPath,
      cliPath,
      "--internal-claude",
      "--route",
      "claude-api",
      "--target",
      root,
      "--prompt-file",
      join(root, "brief.md"),
      "--model",
      "test",
      "--claude-bin",
      claude.bin,
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  expect(exit).toBe(75);
  expect(claude.calls()).toEqual([{ key: true, token: false }]);
  expect(
    decodedJson(
      z.looseObject({ outcome: z.string(), cause: z.string() }),
      stdout.trim().split("\n").at(-1) ?? "",
    ),
  ).toMatchObject({ outcome: "capacity", cause: "credits_unavailable" });
  expect(existsSync(join(root, "state", "claude-credits-unavailable"))).toBe(
    true,
  );
});

test("policy stop: a credits failure ends as capacity on the first attempt, writes the marker and never starts a subscription attempt", async () => {
  const root = tempRoot();
  isolatedWorkerEnvironment(root);
  const claude = fakeClaude(root);
  const run = await runClaude(
    runConfig(root, claude.bin, { route: "claude-api" }),
  );
  expect(claude.calls()).toEqual([{ key: true, token: false }]);
  const relay = toRelay(run);
  expect(relay.outcome).toBe("capacity");
  expect(relay.cause).toBe("credits_unavailable");
  expect(relay.credential).toBe("api_key");
  expect(run.exitCode).toBe(75);
  expect(
    readFileSync(join(root, "state", "claude-credits-unavailable"), "utf8"),
  ).toContain("credits unavailable");
});

function mechanicalJev(): void {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: {
          worker: { choice: "mechanical", probabilities: { mechanical: 1 } },
        },
      }),
  });
  servers.push(server);
  process.env.JEV_URL = `http://127.0.0.1:${server.port}/`;
  process.env.TYPESAFE_API_KEY = "routing-fixture-secret";
}

/** A policy file with the example's keys, only the two named rows kept, and the given credits policy. */
async function policyKeeping(
  root: string,
  keep: readonly string[],
  onCredits: "stop" | "subscription" | undefined,
): Promise<string> {
  const loaded = await loadRoster({ policyPath: examplePolicy });
  if (!loaded.ok) return expect.unreachable(loaded.error);
  const excluded = loaded.value.choice
    .filter((row) => !keep.includes(row.id))
    .map((row) => row.id);
  let text = readFileSync(examplePolicy, "utf8")
    .replace(/^allow = .*$/mu, 'allow = ["codex", "claude-api"]')
    .replace(
      '"claude-session" = "stop"',
      '"claude-session" = "stop", "claude-api" = "continue"',
    )
    .replace("exclude = []", `exclude = ${JSON.stringify(excluded)}`)
    .replace(/^on_credits_unavailable = .*\n/mu, "");
  if (onCredits !== undefined)
    text = text.replace(
      "max_turns = 60\n",
      `max_turns = 60\non_credits_unavailable = "${onCredits}"\n`,
    );
  const path = join(root, "policy.toml");
  writeFileSync(path, text);
  return path;
}

function writeFreshMarker(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "claude-credits-unavailable"),
    "credits unavailable\n",
  );
}

const Filter = z.looseObject({
  reason: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
  removed: z.array(z.looseObject({ row: z.string() })),
});

function lastFilters(): z.output<typeof Filter>[] {
  const audit = routingEvents().events.at(-1)?.audit;
  return decoded(z.array(Filter), audit?.filters ?? []);
}

test("a fresh marker removes claude rows from routing under the default policy and the audit names the filter", async () => {
  const root = tempRoot();
  isolatedWorkerEnvironment(root);
  process.env.AGX_CONFIG = await policyKeeping(
    root,
    ["haiku-medium", "astra-medium"],
    undefined,
  );
  mechanicalJev();
  writeFreshMarker(root);
  const choice = await route("credits routing fixture");
  expect(choice.route).toBe("codex");
  const filter = lastFilters().find(
    (entry) => entry.reason === "claude-api credits unavailable",
  );
  expect(filter?.before).toContain("haiku-medium");
  expect(filter?.after).toEqual(["astra-medium"]);
  expect(filter?.removed.map((row) => row.row)).toEqual(["haiku-medium"]);
});

test("without a marker claude rows stay in routing and the filter removes nothing", async () => {
  const root = tempRoot();
  isolatedWorkerEnvironment(root);
  process.env.AGX_CONFIG = await policyKeeping(
    root,
    ["haiku-medium", "astra-medium"],
    undefined,
  );
  mechanicalJev();
  await route("credits routing fixture, no marker");
  const filter = lastFilters().find(
    (entry) => entry.reason === "claude-api credits unavailable",
  );
  expect(filter?.removed).toEqual([]);
  expect(filter?.after).toContain("haiku-medium");
});

test("a stale marker no longer removes claude rows", async () => {
  const root = tempRoot();
  isolatedWorkerEnvironment(root);
  process.env.AGX_CONFIG = await policyKeeping(
    root,
    ["haiku-medium", "astra-medium"],
    undefined,
  );
  mechanicalJev();
  writeFreshMarker(root);
  const old = Temporal.Now.instant().subtract({ hours: 25 }).epochMilliseconds;
  const { utimesSync } = await import("node:fs");
  utimesSync(
    join(root, "state", "claude-credits-unavailable"),
    old / 1000,
    old / 1000,
  );
  await route("credits routing fixture, stale marker");
  const filter = lastFilters().find(
    (entry) => entry.reason === "claude-api credits unavailable",
  );
  expect(filter?.removed).toEqual([]);
});

const Receipt = z.looseObject({
  outcome: z.string(),
  row: z.string().nullable().optional(),
  rows: z.array(z.string()).optional(),
});

test("one run: a credits failure on a claude row continues on a codex row, with no second claude attempt", async () => {
  const root = tempRoot();
  await prepareTicketRepo(root);
  const claude = fakeClaude(root);
  const invocations = join(root, "invocations.jsonl");
  // The worker stand-in runs the real claude worker for claude rows (against the fake claude) and
  // reports success for codex rows.
  const worker = join(root, "worker-command");
  writeFileSync(
    worker,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const internalClaude = args.includes("--internal-claude");
const route = internalClaude ? "claude" : "codex";
appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ route, args }) + "\\n");
if (internalClaude) {
  const child = Bun.spawn([process.execPath, ${JSON.stringify(cliPath)}, ...args, "--claude-bin", ${JSON.stringify(claude.bin)}], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} else {
  const report = { summary: "codex continued", changes: [], checks: [], for_coordinator: [], open: [] };
  process.stdout.write(JSON.stringify({ report, vendor_session: "codex-thread" }) + "\\n");
}
`,
  );
  const ticket = join(root, "credits.md");
  writeFileSync(
    ticket,
    '+++\nschema = 2\nname = "credits"\ntimeout_s = 600\nwrites = []\ncapabilities = []\noutcome = "test credits reroute"\nverify = ["true"]\n[proposition]\nid = "CREDITS"\nclaim = "credits failure moves to codex"\nrefuted_by = "a second claude attempt"\n+++\nWork.\n',
  );
  const policy = await policyKeeping(
    root,
    ["haiku-medium", "astra-medium"],
    undefined,
  );
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: {
          worker: { choice: "mechanical", probabilities: { mechanical: 1 } },
        },
      }),
  });
  servers.push(server);
  chmodSync(worker, 0o755);
  const child = Bun.spawn(
    [
      process.execPath,
      cliPath,
      "run",
      ticket,
      "--cd",
      root,
      "--sandbox",
      "none",
    ],
    {
      env: {
        ...subprocessEnvironment(),
        AGX_CONFIG: policy,
        AGX_STATE_DIR: join(root, "state"),
        AGX_WORKER_COMMAND: worker,
        AGX_DISPATCHER_SESSION: "test-dispatcher",
        ANTHROPIC_API_KEY: "inline-test-secret",
        HOME: root,
        JEV_URL: `http://127.0.0.1:${server.port}/`,
        TYPESAFE_API_KEY: "test-key",
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "tmp"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 40_000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  const lines = readFileSync(invocations, "utf8").trim().split("\n");
  const routes = lines.map(
    (line) => decodedJson(z.looseObject({ route: z.string() }), line).route,
  );
  // First attempt on the claude row, then exactly one continuation on a codex row.
  expect(routes[0]).toBe("claude");
  expect(routes.slice(1)).toHaveLength(1);
  expect(routes[1]).not.toBe("claude");
  expect(claude.calls()).toEqual([{ key: true, token: false }]);
  expect(
    readFileSync(join(root, "state", "claude-credits-unavailable"), "utf8"),
  ).toContain("credits unavailable");
  const receipt = decodedJson(Receipt, stdout.trim().split("\n").at(-1) ?? "");
  expect(receipt.rows).toEqual(["haiku-medium", "astra-medium"]);
  expect(receipt.row).toBe("astra-medium");
});

test("an unknown on_credits_unavailable value is rejected by the policy loader", async () => {
  const root = tempRoot();
  const path = join(root, "agx.toml");
  writeFileSync(
    path,
    'schema = 1\n[claude_run]\non_credits_unavailable = "continue"\n',
  );
  const loaded = await loadRoster({ policyPath: path, repoRoot: root });
  expect(loaded.ok).toBe(false);
});
