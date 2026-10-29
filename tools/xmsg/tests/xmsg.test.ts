const extra = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((part) => extra(part));
  const object = z.record(z.string(), z.unknown()).safeParse(value);
  if (!object.success) return value;
  return {
    ...Object.fromEntries(
      Object.entries(object.data).map(([key, part]) => [key, extra(part)]),
    ),
    future_field: { version: 42 },
  };
};

import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { jsonOf, z } from "../../shared/src/zod.ts";
import {
  resolveCallingThreadIdentity,
  resolveNearestVendorIdentity,
  unknownSender,
} from "../src/caller-identity.ts";
import {
  BOUND_CLAUDE_TARGET_ENV,
  encodeBoundClaudeTarget,
} from "../src/claude-target.ts";

const cli = resolve(import.meta.dir, "../src/xmsg.ts");
const roots: string[] = [];
const message = "Literal ' $(touch nope)\n日本語";
const callerIdentity = await resolveCallingThreadIdentity();
const callerSender = callerIdentity.sender ?? unknownSender(callerIdentity);
const envelope = (body: string, sender = callerSender, target?: string) =>
  `from: ${sender}${target === undefined ? "" : `\nto: claude:${target}`}\n\n${body}`;
const msgId = "de2d35d2-4ad8-4bd3-a28d-21184c0218ca";
const relayId = "cc6e829c-128f-4836-a11b-21b83b11bf12";
const use = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "send-1",
        name: "SendMessage",
        input: { to: "peer", message: envelope(message) },
      },
    ],
  },
};
const uuidUse = (target: string) => ({
  ...use,
  message: {
    ...use.message,
    content: [
      {
        ...use.message.content[0],
        input: { to: "peer", message: envelope(message, undefined, target) },
      },
    ],
  },
});
const result = (content: unknown, toolUseId = "send-1", isError = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        is_error: isError,
        content,
      },
    ],
  },
});
const accepted = result([
  { type: "text", text: JSON.stringify({ success: true, msg_id: msgId }) },
]);
const listUse = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "tool_use", id: "list-1", name: "ListAgents", input: {} },
    ],
  },
};
const listResult = result("[]", "list-1");
const nativeMetadata = [
  {
    type: "system",
    subtype: "hook_started",
    hook_event: "SessionStart",
    hook_id: "fake-hook-id",
    hook_name: "fake-hook",
    session_id: "fake-session",
    uuid: "fake-hook-start",
  },
  {
    type: "system",
    subtype: "hook_response",
    exit_code: 0,
    hook_event: "SessionStart",
    hook_id: "fake-hook-id",
    hook_name: "fake-hook",
    outcome: "success",
    output: "",
    session_id: "fake-session",
    stderr: "",
    stdout: "",
    uuid: "fake-hook-response",
  },
  {
    type: "system",
    subtype: "init",
    session_id: "fake-session",
    uuid: "fake-init",
  },
  {
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: 12,
    estimated_tokens_delta: 4,
    session_id: "fake-session",
    uuid: "fake-thinking-tokens",
  },
  {
    type: "system",
    subtype: "informational",
    content: "fake metadata",
    level: "info",
    session_id: "fake-session",
    uuid: "fake-info",
  },
  {
    type: "rate_limit_event",
    rate_limit_info: {},
    session_id: "fake-session",
    uuid: "fake-rate-limit",
  },
];
const nativeThinking = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", signature: "fake-signature", thinking: "fake" },
    ],
  },
};
const successfulEnd = {
  type: "result",
  subtype: "success",
  result: "fake completion",
  api_error_status: null,
  duration_api_ms: 1,
  duration_ms: 2,
  fast_mode_disabled_reason: "",
  fast_mode_state: "off",
  first_content_frame_ms: 1,
  is_error: false,
  modelUsage: {},
  num_turns: 1,
  permission_denials: [],
  queued_turn_count: 0,
  result_index: 0,
  safety_stops: 0,
  session_id: "fake-session",
  stop_reason: "end_turn",
  subagent_stats: {},
  terminal_reason: "completed",
  time_to_request_ms: 1,
  total_cost_usd: 0,
  ttft_ms: 1,
  ttft_stream_ms: 1,
  usage: {},
  uuid: "fake-result",
};
const errorEnd = { ...successfulEnd, subtype: "error", is_error: true };
const stream = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const completeStream = (...events: unknown[]) =>
  stream(...events, successfulEnd);

afterAll(async () => {
  await Promise.all(
    roots.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function run(
  options: {
    args?: string[];
    kind?: "claude" | "codex";
    output?: string;
    exit?: number;
    delay?: number;
    missing?: boolean;
    threads?: Array<{
      id: string;
      name?: string;
      cwd?: string;
      status: { type: string };
      turns?: Array<{
        items: Array<{
          id: string;
          type: string;
          content: Array<{ type: string; text: string }>;
        }>;
      }>;
    }>;
    codexError?: boolean;
    codexDelivery?: "active" | "idle";
    noTurnListing?: boolean;
    replyAfterReads?: number;
    inventory?: string;
    inventorySequence?: string[];
    inventoryDelay?: number;
    discoveryDelay?: number;
    env?: Record<string, string | undefined>;
    runRecord?: {
      route?: string | undefined;
      session: string | null;
      progress?: string;
      pid?: number;
    };
    transcript?: string | undefined;
    registry?: ReadonlyArray<{
      sessionId: string;
      name?: string;
      status: string;
    }>;
    relayPeer?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "xmsg-test-"));
  roots.push(root);
  if (options.runRecord !== undefined) {
    const state = join(root, "agx-state");
    await Bun.write(
      join(state, "records.jsonl"),
      JSON.stringify({
        kind: "started",
        id: "worker-run",
        at: Temporal.Now.instant().toString(),
        ticket: "sender-fixture",
        writes: [],
        cwd: root,
        workspace: root,
        row: "fixture",
        route: options.runRecord.route,
        dispatcher_session: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vendor_session: options.runRecord.session,
        pid: options.runRecord.pid ?? process.pid,
      }) + "\n",
    );
    if (options.runRecord.progress !== undefined)
      await Bun.write(
        join(state, "runs", "worker-run", "worker-progress.jsonl"),
        JSON.stringify({
          schema: 1,
          at: Temporal.Now.instant().toString(),
          last: "thread started",
          commands: 0,
          files: 0,
          session: options.runRecord.progress,
        }),
      );
  }
  if (options.registry !== undefined) {
    await mkdir(join(root, ".claude", "sessions"), { recursive: true });
    for (const [index, record] of options.registry.entries())
      await Bun.write(
        join(root, ".claude", "sessions", `${index + 100}.json`),
        JSON.stringify(record),
      );
  }
  if (options.transcript !== undefined) {
    await mkdir(join(root, ".claude", "projects", "fixture"), {
      recursive: true,
    });
    await Bun.write(
      join(root, ".claude", "projects", "fixture", `${relayId}.jsonl`),
      options.transcript,
    );
  }
  let server: ReturnType<typeof Bun.serve> | undefined;
  let readCount = 0;
  let sawLoadedList = false;
  let deliveryUnavailable = false;
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  if (
    options.threads !== undefined ||
    options.codexError === true ||
    options.codexDelivery !== undefined
  ) {
    await mkdir(join(root, "app-server-control"));
    server = Bun.serve({
      unix: join(root, "app-server-control", "app-server-control.sock"),
      fetch(request, endpoint) {
        if (deliveryUnavailable) {
          void endpoint.stop(true);
          return;
        }
        if (!endpoint.upgrade(request, { data: undefined }))
          void endpoint.stop(true);
      },
      websocket: {
        async message(ws, raw) {
          const parsedRequest = jsonOf(
            z.object({
              id: z.number(),
              method: z.string(),
              params: z
                .object({
                  threadId: z.string().optional(),
                  includeTurns: z.boolean().optional(),
                })
                .loose(),
            }),
          ).safeParse(String(raw));
          if (!parsedRequest.success) return;
          const request = parsedRequest.data;
          rpcCalls.push({ method: request.method, params: request.params });
          const methods = [
            "initialize",
            "thread/loaded/list",
            "thread/read",
            "turn/steer",
            "turn/start",
          ];
          expect(methods).toContain(request.method);
          if (options.codexError === true) {
            ws.send(
              JSON.stringify({
                id: request.id,
                error: { message: "fixture backend failure" },
              }),
            );
            return;
          }
          let response: unknown = {};
          if (request.method === "thread/loaded/list") {
            sawLoadedList = true;
            response = {
              data: options.threads?.map((t) => t.id),
              nextCursor: null,
            };
          }
          if (request.method === "thread/read") {
            if (
              options.noTurnListing === true &&
              request.params.includeTurns === true
            ) {
              ws.send(
                JSON.stringify({
                  id: request.id,
                  error: {
                    code: -32601,
                    message: "list_turns is not supported yet",
                  },
                }),
              );
              return;
            }
            readCount++;
            const selectedThread = options.threads?.find(
              (t) => t.id === request.params.threadId,
            );
            const statusType =
              options.codexDelivery ?? selectedThread?.status.type;
            let turns: unknown[] = [];
            const shouldLoadReadTurns = request.params.includeTurns === true;
            if (options.codexDelivery === "active")
              turns = [{ id: "turn-active", status: "inProgress" }];
            else if (shouldLoadReadTurns)
              turns =
                readCount < (options.replyAfterReads ?? 0)
                  ? []
                  : (selectedThread?.turns ?? []);
            const activeTurnMissing =
              shouldLoadReadTurns &&
              turns.length === 0 &&
              selectedThread?.status.type === "active";
            if (activeTurnMissing)
              turns = [{ id: "turn-fixture", status: "inProgress" }];
            let thread: unknown;
            if (selectedThread !== undefined) {
              thread = {
                ...selectedThread,
                status: { type: statusType ?? selectedThread.status.type },
                ...(request.params.includeTurns === true ? { turns } : {}),
              };
            }
            response = { thread };
          }
          if (request.method === "turn/steer")
            response = { turnId: "turn-active" };
          if (request.method === "turn/start")
            response = { turn: { id: "turn-started" } };
          await Bun.sleep(options.discoveryDelay ?? 0);
          ws.send(JSON.stringify({ id: request.id, result: response }));
          if (
            options.codexDelivery === undefined &&
            options.replyAfterReads === undefined &&
            sawLoadedList &&
            request.method === "thread/read" &&
            request.params.includeTurns !== true &&
            readCount >= (options.threads?.length ?? 0)
          )
            deliveryUnavailable = true;
        },
      },
    });
  }
  const kind = options.kind ?? "claude";
  if (
    (options.kind === "codex" && options.missing !== true) ||
    options.threads !== undefined ||
    options.codexError === true ||
    options.codexDelivery !== undefined
  ) {
    const codex = join(root, "codex");
    await Bun.write(
      codex,
      `#!${process.execPath}
const file = Bun.file(process.env.XMSG_FAKE_ARGS);
const previous = await file.exists() ? await file.text() : "";
await Bun.write(file, previous + JSON.stringify(Bun.argv.slice(2)) + "\\n");
process.exit(0);
`,
    );
    await chmod(codex, 0o755);
  }
  const argsFile = join(root, "argv.json");
  if (options.missing !== true) {
    const fake = join(root, kind);
    await Bun.write(
      fake,
      `#!${process.execPath}
const args = Bun.argv.slice(2);
const previous = await Bun.file(process.env.XMSG_FAKE_ARGS).exists() ? await Bun.file(process.env.XMSG_FAKE_ARGS).text() : "";
await Bun.write(process.env.XMSG_FAKE_ARGS, previous + JSON.stringify(args) + "\\n");
const inventory = args[0] === "agents";
let output = process.env.XMSG_FAKE_INVENTORY ?? process.env.XMSG_FAKE_OUTPUT ?? "";
if (inventory && process.env.XMSG_FAKE_INVENTORY_SEQUENCE !== undefined) {
  const sequence = JSON.parse(process.env.XMSG_FAKE_INVENTORY_SEQUENCE);
  const reads = previous.trim().split("\\n").filter(Boolean).filter((line) => JSON.parse(line)[0] === "agents").length;
  output = sequence[Math.min(reads, sequence.length - 1)] ?? "";
}
if (inventory && process.env.XMSG_FAKE_REGISTRY === "1") {
  const records = [];
  for await (const file of new Bun.Glob("*.json").scan(process.env.HOME + "/.claude/sessions"))
    records.push(await Bun.file(process.env.HOME + "/.claude/sessions/" + file).json());
  output = JSON.stringify(records);
}
if (!inventory) {
  output = process.env.XMSG_FAKE_OUTPUT ?? "";
  const peer = process.env.XMSG_FAKE_PEER;
  if (peer !== undefined && !args.at(-1)?.includes("Target: " + JSON.stringify(peer)))
    output = ${JSON.stringify(completeStream(listUse, listResult))};
}
process.stdout.write(output);
await Bun.sleep(Number(inventory ? process.env.XMSG_FAKE_INVENTORY_DELAY : (process.env.XMSG_FAKE_DELAY ?? 0)));
process.exit(Number(process.env.XMSG_FAKE_EXIT ?? 0));
`,
    );
    await chmod(fake, 0o755);
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      cli,
      ...(options.args ?? [
        "send",
        "--to",
        `${kind}:peer`,
        "--message",
        message,
      ]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: root,
        HOME: root,
        AGX_STATE_DIR: join(root, "agx-state"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        CODEX_HOME: root,
        CODEX_THREAD_ID: undefined,
        CODEX_SESSION_ID: undefined,
        CLAUDE_CODE_SESSION_ID: undefined,
        CLAUDE_SESSION_ID: undefined,
        CLAUDE_CONFIG_DIR: undefined,
        AGX_MSG_FROM: undefined,
        AGX_RUN_ID: undefined,
        XMSG_RELAY_CAPTURE: undefined,
        ...options.env,
        XMSG_FAKE_INVENTORY: options.inventory,
        XMSG_FAKE_INVENTORY_SEQUENCE:
          options.inventorySequence === undefined
            ? undefined
            : JSON.stringify(options.inventorySequence),
        XMSG_FAKE_REGISTRY: options.registry === undefined ? undefined : "1",
        XMSG_FAKE_PEER: options.relayPeer,
        XMSG_FAKE_INVENTORY_DELAY: String(
          options.inventoryDelay ?? options.delay ?? 0,
        ),
        XMSG_FAKE_ARGS: argsFile,
        XMSG_FAKE_OUTPUT: options.output ?? "",
        XMSG_FAKE_EXIT: String(options.exit ?? 0),
        XMSG_FAKE_DELAY: String(options.delay ?? 0),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  await server?.stop(true);
  const called = await Bun.file(argsFile).exists();
  const parsed = called
    ? z
        .array(jsonOf(z.array(z.string())))
        .safeParse((await Bun.file(argsFile).text()).trim().split("\n"))
    : undefined;
  return {
    stdout,
    stderr,
    exit,
    called,
    calls: parsed?.success === true ? parsed.data : [],
    argv: parsed?.success === true ? (parsed.data.at(-1) ?? []) : [],
    rpcCalls,
  };
}

test("Claude acceptance requires a correlated tool result and hard tool restriction", async () => {
  const r = await run({ output: completeStream(use, accepted) });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain(msgId);
  expect(r.argv).toContain("--tools=ListAgents,SendMessage");
  expect(r.argv).toContain("--allowedTools=ListAgents,SendMessage");
  expect(r.argv).toContain("stream-json");
  expect(r.argv).toContain("--verbose");
  expect(r.argv[r.argv.indexOf("--name") + 1]).toBe(
    `agx msg relay from ${callerSender}`,
  );
  expect(r.argv.at(-1)).toContain(JSON.stringify(envelope(message)));
});

test("a complete clean relay with zero SendMessage calls is unavailable, not unknown", async () => {
  const r = await run({ output: completeStream() });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("no SendMessage attempted");
  expect(r.stderr).toContain("step failed: ListAgents invocation");
  expect(r.stderr).toContain("zero ListAgents calls");
  expect(r.stderr).toContain("tool availability and permissions");
  expect(r.stderr).not.toContain("completed without delivery");
  expect(r.stderr).not.toContain("acceptance unknown");
  expect(r.stdout).not.toContain("accepted for");
});

test("msg contract: claude to claude is refused before any delivery and names the native messenger", async () => {
  for (const args of [
    sendArgs(`claude:${uuidB}`),
    [...sendArgs("claude:peer"), "--exact"],
  ]) {
    const r = await run({ args: [...args, "--from", `claude:${uuidA}`] });
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("SendMessage");
    expect(r.called).toBe(false);
    expect(r.rpcCalls).toHaveLength(0);
  }
  const recorded = await run({
    args: sendArgs(`claude:${uuidB}`),
    runRecord: { route: "claude", session: uuidA },
    env: { AGX_RUN_ID: "worker-run" },
  });
  expect(recorded.exit).toBe(2);
  expect(recorded.stderr).toContain("SendMessage");
  expect(recorded.called).toBe(false);
});

test("msg contract: a codex or unknown sender still reaches a claude target", async () => {
  for (const sender of [`codex:${uuidA}`, undefined]) {
    const effective = sender ?? callerSender;
    const sentUse = {
      ...use,
      message: {
        ...use.message,
        content: [
          {
            ...use.message.content[0],
            input: { to: "peer", message: envelope(message, effective) },
          },
        ],
      },
    };
    const r = await run({
      args: [
        ...sendArgs("claude:peer"),
        ...(sender === undefined ? [] : ["--from", sender]),
      ],
      output: completeStream(sentUse, accepted),
    });
    expect(r.exit).toBe(0);
    expect(r.calls).toHaveLength(1);
  }
});

test("msg contract: claude to codex is still carried", async () => {
  const r = await run({
    kind: "codex",
    args: [...sendArgs(`codex:${uuidB}`), "--from", `claude:${uuidA}`],
  });
  expect(r.exit).toBe(0);
  expect(r.argv.at(-1)).toBe(envelope(message, `claude:${uuidA}`));
});

test.each(["full", "prefix"])(
  "codex sender gets target-resolution evidence for a %s UUID absent from relay peers",
  async (shape) => {
    const target = "deadbeef-1234-4abc-8def-0123456789ab";
    const selector = shape === "full" ? target : "deadbeef";
    const listing =
      "Peer sessions (1):\n  intended-peer [a80909] · interactive · busy";
    const r = await run({
      args: [
        "send",
        "--to",
        `claude:${selector}`,
        "--from",
        `codex:${target}`,
        "--message",
        message,
      ],
      inventory: JSON.stringify([
        { sessionId: target, name: "intended-peer", status: "busy" },
      ]),
      output: completeStream(listUse, result(listing, "list-1")),
    });
    expect(r.exit).toBe(3);
    expect(r.stderr).toContain(
      "step failed: target resolution / SendMessage invocation",
    );
    expect(r.stderr).toContain(target);
    expect(r.stderr).toContain("process exit 0");
    expect(r.stderr).toContain('tool_use_id="list-1" is_error=false');
    expect(r.stderr).toContain("intended-peer [a80909]");
    expect(r.stderr).toContain("exact-native-name");
    expect(r.stderr).toContain("Do not guess");
    expect(r.stderr).not.toContain("completed without delivery");
    expect(r.stdout).toBe("");
    expect(r.calls).toHaveLength(2);
    expect(r.argv.at(-1)).toContain('Target: "intended-peer"');
    expect(r.argv.at(-1)).toContain(`to: claude:${target}`);
  },
);

test("failed ListAgents names the tool-result step and escapes bounded evidence", async () => {
  const r = await run({
    output: completeStream(
      listUse,
      result(
        "permission denied\n\u001B[31m" + "x".repeat(2000),
        "list-1",
        true,
      ),
    ),
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("step failed: ListAgents result");
  expect(r.stderr).toContain("is_error=true");
  expect(r.stderr).toContain("permission denied\\n\\u001b[31m");
  expect(r.stderr).toContain("(truncated)");
  expect(r.stderr).not.toContain("x".repeat(1201));
  expect(r.stderr).not.toContain("\u001B");
  expect(r.stderr).toContain("tool availability and permissions");
  expect(r.calls).toHaveLength(1);
});

test.each([
  ["orphan tool_result", result("orphan", "unseen-call")],
  [
    "wrong-role SendMessage event",
    { ...use, message: { ...use.message, role: "user" } },
  ],
  [
    "malformed possible tool_use",
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "send-malformed", input: { message } },
        ],
      },
    },
  ],
])("Claude %s cannot prove zero sends", async (_name, event) => {
  const r = await run({ output: completeStream(event) });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).not.toContain("no SendMessage attempted");
});

test("a correlated ListAgents use/result permits a complete no-send result", async () => {
  const r = await run({
    output: completeStream(
      ...nativeMetadata,
      listUse,
      listResult,
      nativeThinking,
    ),
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("no SendMessage attempted");
  expect(r.stderr).not.toContain("acceptance unknown");
});

test("an unpaired ListAgents use prevents complete no-send classification", async () => {
  const r = await run({ output: completeStream(listUse) });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).not.toContain("no SendMessage attempted");
});

test("terminal relay prose is not a receipt and does not imply a send", async () => {
  const r = await run({ output: stream(successfulEnd) });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("no SendMessage attempted");
  expect(r.stdout).not.toContain("accepted for");
});

test("contradictory native result envelope cannot prove no-send", async () => {
  const r = await run({ output: stream(errorEnd) });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).not.toContain("no SendMessage attempted");
});

test("one called SendMessage without a receipt remains unknown after clean completion", async () => {
  const r = await run({ output: completeStream(use) });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).not.toContain("no SendMessage attempted");
  expect(r.stderr).toContain("do not resend without checking");
});

test.each([
  ["malformed line", "not JSON\n"],
  ["malformed result frame", stream({ type: "result" })],
  ["missing successful terminal record", stream()],
])("Claude %s cannot prove no-send", async (_name, output) => {
  const r = await run({ output });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).not.toContain("no SendMessage attempted");
});

test("multiple top-level SendMessage calls remain unknown", async () => {
  const secondUse = {
    ...use,
    message: {
      ...use.message,
      content: [
        {
          type: "tool_use",
          id: "send-2",
          name: "SendMessage",
          input: { to: "peer", message: envelope(message) },
        },
      ],
    },
  };
  const r = await run({ output: completeStream(use, secondUse, accepted) });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).not.toContain("no SendMessage attempted");
});

test.each([
  ["missing tool_result", stream(use)],
  ["missing tool_use", stream(accepted)],
  [
    "unrelated result id",
    stream(
      use,
      result(JSON.stringify({ success: true, msg_id: msgId }), "other"),
    ),
  ],
  [
    "different tool",
    stream(
      {
        ...use,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "send-1",
              name: "ListAgents",
              input: { message },
            },
          ],
        },
      },
      accepted,
    ),
  ],
  [
    "different message",
    stream(
      {
        ...use,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "send-1",
              name: "SendMessage",
              input: { message: "changed" },
            },
          ],
        },
      },
      accepted,
    ),
  ],
  ["missing msg_id", stream(use, result(JSON.stringify({ success: true })))],
  ["malformed output", "not JSON\n"],
  ["nested relay", stream({ ...use, parent_tool_use_id: "nested" }, accepted)],
])("Claude %s leaves acceptance unknown", async (_name, output) => {
  const r = await run({ output });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("acceptance unknown");
  expect(r.stderr).toContain("do not resend without checking");
  expect(r.stdout).not.toContain("accepted for");
});

test.each([
  result("permission denied", "send-1", true),
  result(JSON.stringify({ success: false })),
])("Claude tool rejection exits 1", async (rejected) => {
  expect((await run({ output: stream(use, rejected) })).exit).toBe(1);
});

test("a child failure cannot turn a tool receipt into success", async () => {
  const r = await run({ output: completeStream(use, accepted), exit: 1 });
  expect(r.exit).toBe(4);
  expect(r.stdout).not.toContain("accepted for");
});

test.each(["claude", "codex"] satisfies Array<"claude" | "codex">)(
  "%s timeout has unknown acceptance",
  async (kind) => {
    const r = await run({
      kind,
      args: [
        "send",
        "--to",
        `${kind}:peer`,
        "--message",
        message,
        "--timeout-ms",
        "300",
      ],
      output: stream(use, accepted),
      delay: 5_000,
    });
    expect(r.exit).toBe(4);
    expect(r.stderr).toContain("timed out");
    expect(r.stderr).toContain("do not resend without checking");
  },
);

test("Codex needs only its selected CLI and preserves literal arguments", async () => {
  const r = await run({
    kind: "codex",
    output: "Queued message for thread peer\n",
  });
  expect(r.exit).toBe(0);
  expect(r.argv).toEqual([
    "queue",
    "--thread",
    "peer",
    "--message",
    envelope(message),
  ]);
  expect(r.stdout).toContain("Queued message");
});
test("Codex failure exits 1", async () => {
  expect((await run({ kind: "codex", exit: 7 })).exit).toBe(1);
});
test.each(["claude", "codex"] satisfies Array<"claude" | "codex">)(
  "missing %s is unreachable",
  async (kind) => {
    expect((await run({ kind, missing: true })).exit).toBe(3);
  },
);
test.each(
  [
    [],
    ["send"],
    ["other"],
    ["--unknown"],
    ["--__proto__"],
    ["--constructor"],
    ["send", "--to"],
    ["send", "--to", "unknown:peer", "--message", "hi"],
    ["send", "extra", "--to", "codex:peer", "--message", "hi"],
    ["send", "--to", "codex:peer", "--message", "hi", "--timeout-ms", "0"],
  ].map((args) => ({ args })),
)("usage errors exit 2 without sending: %j", async ({ args }) => {
  const r = await run({ args });
  expect(r.exit).toBe(2);
  expect(r.called).toBe(false);
  expect(r.stderr).toStartWith("agx msg:");
});
test("help and both version aliases need no transport", async () => {
  const help = await run({ args: ["--help"], missing: true });
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain("agx msg");
  expect(help.stdout).not.toContain("xmsg");
  for (const flag of ["-V", "--version"]) {
    const r = await run({ args: [flag], missing: true });
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/^agx msg \d+\.\d+\.\d+\n$/u);
  }
});

test("Claude relay explicitly selects Haiku and low effort", async () => {
  const r = await run({ output: stream(use, accepted) });
  expect(r.exit).toBe(0);
  const modelIndex = r.argv.indexOf("--model");
  const effortIndex = r.argv.indexOf("--effort");
  expect(r.argv.slice(modelIndex, modelIndex + 2)).toEqual([
    "--model",
    "haiku",
  ]);
  expect(r.argv.slice(effortIndex, effortIndex + 2)).toEqual([
    "--effort",
    "low",
  ]);
});

const listArgs = ["list", "--json", "--timeout-ms", "1000"];
const threads = [
  {
    id: "desktop-id",
    name: "same",
    cwd: "/desktop",
    status: { type: "active" },
  },
  { id: "other-id", name: "same", cwd: "/desktop", status: { type: "idle" } },
];
const agents = [
  { sessionId: "claude-id", name: "same", cwd: "/claude", status: "idle" },
  { sessionId: "claude-id", name: "same", cwd: "/claude", status: "idle" },
  { sessionId: "other-claude", status: "busy" },
];
const Inventory = jsonOf(
  z.object({
    count: z.number(),
    recipients: z.array(
      z.object({
        address: z.string(),
        name: z.string().nullable(),
        cwd: z.string().nullable(),
        state: z.string(),
        availability: z.string(),
        source: z.string(),
        observedAt: z.string(),
      }),
    ),
    backends: z.array(z.object({ availability: z.string() })),
  }),
);

function readInventory(output: string) {
  const parsed = Inventory.safeParse(output);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return { count: -1, recipients: [], backends: [] };
  return parsed.data;
}

test("list covers both native inventories, deduplicates exact IDs and preserves duplicate names", async () => {
  const r = await run({
    args: listArgs,
    threads,
    output: JSON.stringify(agents),
  });
  expect(r.exit).toBe(0);
  expect(r.argv).toEqual(["agents", "--json"]);
  expect(r.argv.join(" ")).not.toContain("SendMessage");
  const inventory = readInventory(r.stdout);
  expect(inventory.count).toBe(4);
  expect(inventory.recipients.map((v) => v.address)).toEqual([
    "claude:claude-id",
    "claude:other-claude",
    "codex:desktop-id",
    "codex:other-id",
  ]);
  expect(inventory.recipients[1]?.name).toBeNull();
  expect(inventory.recipients[2]?.state).toBe("active");
  for (const recipient of inventory.recipients) {
    expect(recipient.source).not.toBe("");
    expect(recipient.observedAt).toMatch(/^\d{4}-/u);
    const kind = recipient.address.startsWith("claude:") ? "claude" : "codex";
    const sent = await run({
      kind,
      output: kind === "claude" ? stream(use, accepted) : "",
      args: ["send", "--to", recipient.address, "--message", message],
    });
    expect(sent.exit).toBe(0);
    if (kind === "codex") expect(sent.argv[2]).toBe(recipient.address.slice(6));
    else
      expect(sent.argv.at(-1)).toContain(
        JSON.stringify(recipient.address.slice(7)),
      );
  }
});

test("empty native inventories are complete, not unavailable", async () => {
  const r = await run({ args: listArgs, threads: [], output: "[]" });
  expect(r.exit).toBe(0);
  expect(readInventory(r.stdout).count).toBe(0);
});

test("missing backends cannot masquerade as empty success", async () => {
  const r = await run({ args: listArgs, missing: true });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("codex discovery unavailable");
  expect(r.stderr).toContain("claude discovery unavailable");
  expect(
    readInventory(r.stdout).backends.every(
      (b) => b.availability === "unavailable",
    ),
  ).toBe(true);
});

test.each([
  { codexError: true, output: JSON.stringify(agents), count: 2 },
  { threads, output: "model prose is not an inventory", count: 2 },
  { threads, output: "[]", exit: 7, count: 2 },
])(
  "partial failure retains the other vendor and exits 3: %j",
  async (options) => {
    const r = await run({ ...options, args: listArgs });
    expect(r.exit).toBe(3);
    expect(readInventory(r.stdout).count).toBe(options.count);
    expect(r.stderr).toContain("discovery unavailable");
  },
);

test("human inventory shows concise rows and availability once per vendor", async () => {
  const r = await run({
    args: ["list"],
    threads: [],
    output: JSON.stringify(agents),
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("claude:other-claude");
  expect(r.stdout).toContain('name="unavailable"');
  expect(r.stdout).toContain("state=");
  expect(r.stdout).not.toContain("source=");
  expect(r.stdout).not.toContain("availability=");
  expect(r.stdout).not.toContain("thread/loaded/list");
  expect(r.stdout).not.toContain("claude agents --json");
  expect(
    r.stdout.split("\n").filter((line) => line === "codex: available"),
  ).toHaveLength(1);
  expect(
    r.stdout.split("\n").filter((line) => line === "claude: available"),
  ).toHaveLength(1);
  expect(r.stdout.split("\n").filter((line) => line.includes("\t"))).toEqual([
    'claude:claude-id\tname="same"\tcwd="/claude"\tstate="idle"',
    'claude:other-claude\tname="unavailable"\tcwd="unavailable"\tstate="busy"',
  ]);
});

test.each(
  [
    ["list", "--to", "codex:peer"],
    ["list", "--message", "hi"],
    ["list", "extra"],
    ["list", "--timeout-ms", "0"],
    ["send", "--json", "--to", "codex:peer", "--message", "hi"],
  ].map((args) => ({ args })),
)(
  "unsupported list/send combinations fail before discovery: %j",
  async ({ args }) => {
    const r = await run({ args });
    expect(r.exit).toBe(2);
    expect(r.called).toBe(false);
  },
);

test("list bounds a stalled native process", async () => {
  const r = await run({
    args: ["list", "--json", "--timeout-ms", "50"],
    threads: [],
    output: "[]",
    delay: 5000,
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("discovery unavailable");
});

test("send accepts a literal message equal to the new list flag", async () => {
  const r = await run({
    kind: "codex",
    args: ["send", "--to", "codex:literal-id", "--message=--json"],
  });
  expect(r.exit).toBe(0);
  expect(r.argv).toEqual([
    "queue",
    "--thread",
    "literal-id",
    "--message",
    envelope("--json"),
  ]);
});

test("listing rejects record overflow without inventing a partial vendor inventory", async () => {
  const output = JSON.stringify(
    Array.from({ length: 1001 }, (_, i) => ({
      sessionId: String(i),
      status: "idle",
    })),
  );
  const r = await run({ args: listArgs, threads: [], output });
  expect(r.exit).toBe(3);
  expect(readInventory(r.stdout).count).toBe(0);
});

const uuidA = "deadbeef-1234-4abc-8def-0123456789ab";
const uuidB = "deadbeef-2234-4abc-8def-0123456789ab";
const codexDeliveryArgs = (id: string) => [
  "send",
  "--to",
  `codex:${id}`,
  "--message",
  message,
];

test("Codex active turn is delivered with turn/steer", async () => {
  const r = await run({
    kind: "codex",
    codexDelivery: "active",
    threads: [{ id: uuidA, status: { type: "active" } }],
    args: codexDeliveryArgs(uuidA),
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("path=steered");
  expect(r.rpcCalls.map((call) => call.method)).toEqual([
    "initialize",
    "thread/read",
    "turn/steer",
  ]);
  expect(r.rpcCalls.at(-1)?.params).toEqual({
    threadId: uuidA,
    expectedTurnId: "turn-active",
    input: [{ type: "text", text: envelope(message) }],
  });
});

test("Codex immediate turn start delivers to an idle thread", async () => {
  const r = await run({
    kind: "codex",
    codexDelivery: "idle",
    threads: [{ id: uuidA, status: { type: "idle" } }],
    args: codexDeliveryArgs(uuidA),
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("path=started");
  expect(r.rpcCalls.map((call) => call.method)).toEqual([
    "initialize",
    "thread/read",
    "turn/start",
  ]);
  expect(r.rpcCalls.at(-1)?.params).toEqual({
    threadId: uuidA,
    input: [{ type: "text", text: envelope(message) }],
  });
});

test("msg contract: a Codex app-server without turn listing still receives the message", async () => {
  const r = await run({
    kind: "codex",
    codexDelivery: "idle",
    noTurnListing: true,
    threads: [{ id: uuidA, status: { type: "idle" } }],
    args: codexDeliveryArgs(uuidA),
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("path=started");
  expect(r.rpcCalls.map((call) => call.method)).toEqual([
    "initialize",
    "thread/read",
    "thread/read",
    "turn/start",
  ]);
  expect(r.rpcCalls.at(-1)?.params).toEqual({
    threadId: uuidA,
    input: [{ type: "text", text: envelope(message) }],
  });
});

test("Codex active thread without turn listing stops before sending", async () => {
  const r = await run({
    kind: "codex",
    codexDelivery: "active",
    noTurnListing: true,
    threads: [{ id: uuidA, status: { type: "active" } }],
    args: codexDeliveryArgs(uuidA),
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("thread/read includeTurns is unsupported");
  expect(r.rpcCalls.map((call) => call.method)).toEqual([
    "initialize",
    "thread/read",
    "thread/read",
  ]);
});

test("Codex resolves an opaque thread ID before immediate turn start", async () => {
  const id = "desktop-thread-1026";
  const r = await run({
    kind: "codex",
    codexDelivery: "idle",
    threads: [{ id, name: "worker", status: { type: "idle" } }],
    args: codexDeliveryArgs(id),
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("path=started");
  expect(r.rpcCalls.map((call) => call.method)).toEqual([
    "initialize",
    "thread/loaded/list",
    "thread/read",
    "initialize",
    "thread/read",
    "turn/start",
  ]);
  expect(r.rpcCalls.at(-1)?.params).toEqual({
    threadId: id,
    input: [{ type: "text", text: envelope(message) }],
  });
});

test("Codex queue fallback runs only when the app-server socket is absent", async () => {
  const r = await run({
    kind: "codex",
    args: codexDeliveryArgs(uuidA),
    output: "Queued message for thread\n",
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("path=queued");
  expect(r.rpcCalls).toEqual([]);
  expect(r.argv).toEqual([
    "queue",
    "--thread",
    uuidA,
    "--message",
    envelope(message),
  ]);
});

const firstUuidThread = {
  id: uuidA,
  name: "first",
  status: { type: "active" },
};
const uuidThreads = [
  firstUuidThread,
  { id: uuidB, name: "second", status: { type: "idle" } },
];
const sendArgs = (to: string, timeout = "1000") => [
  "send",
  "--to",
  to,
  "--message",
  message,
  "--timeout-ms",
  timeout,
];

test("human list short address resolves through the CLI to one exact native send", async () => {
  const listed = await run({
    args: ["list"],
    threads: uuidThreads,
    output: "[]",
  });
  expect(listed.exit).toBe(0);
  expect(listed.calls).toEqual([["agents", "--json"]]);
  const address = listed.stdout
    .split("\n")
    .find((line) => line.startsWith("codex:deadbeef1"))
    ?.split("\t")[0];
  expect(address).toBe("codex:deadbeef1");
  const sent = await run({
    kind: "codex",
    threads: uuidThreads,
    args: sendArgs(address ?? ""),
  });
  expect(sent.exit).toBe(0);
  expect(sent.calls).toEqual([
    ["queue", "--thread", uuidA, "--message", envelope(message)],
  ]);
  const json = await run({
    args: listArgs,
    threads: uuidThreads,
    output: "[]",
  });
  expect(json.stdout).toContain(`"address":"codex:${uuidA}"`);
  expect(json.stdout).toContain('"shortAddress":"codex:deadbeef1"');
});

test.each([
  { selector: "deadbeef", reason: "matches 2" },
  { selector: "ffff", reason: "No codex recipient" },
  { selector: "dead-beef", reason: "canonical hyphens" },
  { selector: "dea", reason: "4–32" },
])("prefix refusal makes zero sends: %j", async ({ selector, reason }) => {
  const r = await run({
    kind: "codex",
    threads: uuidThreads,
    args: sendArgs(`codex:${selector}`),
  });
  expect(r.exit).toBe(2);
  expect(r.stderr).toContain(reason);
  expect(r.calls).toEqual([]);
  if (selector === "deadbeef") {
    expect(r.stderr).toContain(`codex:${uuidA}\tname="first"`);
    expect(r.stderr.indexOf(uuidA)).toBeLessThan(r.stderr.indexOf(uuidB));
  }
});

test("failed selected inventory cannot authorize a prefix send", async () => {
  const r = await run({
    kind: "codex",
    codexError: true,
    args: sendArgs("codex:dead"),
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("Cannot prove");
  expect(r.calls).toEqual([]);
});

test("Claude prefix queries only Claude, then relays to its native name once", async () => {
  const r = await run({
    inventory: JSON.stringify([
      { sessionId: uuidA, name: "peer", status: "idle" },
    ]),
    output: stream(uuidUse(uuidA), accepted),
    args: sendArgs("claude:DEADBEEF-12"),
  });
  expect(r.exit).toBe(0);
  expect(r.calls).toHaveLength(2);
  expect(r.calls[0]).toEqual(["agents", "--json"]);
  expect(r.calls[1]?.at(-1)).toContain('Target: "peer"');
  expect(r.calls[1]?.at(-1)).toContain(
    `Send this exact text once using SendMessage: ${JSON.stringify(envelope(message, undefined, uuidA))}`,
  );
});

test("Claude inventory skips one malformed row and resolves a valid target", async () => {
  const r = await run({
    inventory: JSON.stringify([
      { sessionId: uuidA, name: "peer", status: "idle" },
      { sessionId: uuidB, name: "broken", status: 42 },
    ]),
    output: stream(uuidUse(uuidA), accepted),
    args: sendArgs(`claude:${uuidA}`),
  });
  expect(r.exit).toBe(0);
  expect(r.calls).toHaveLength(2);
  expect(r.calls[0]).toEqual(["agents", "--json"]);
  expect(r.calls[1]?.at(-1)).toContain('Target: "peer"');
  expect(r.stderr).toContain("row 1; field status");
  expect(r.stderr).toContain("skipped 1 malformed Claude inventory row(s)");
});

test("Claude inventory retries one empty read and resolves a valid target", async () => {
  const r = await run({
    inventorySequence: ["", globalAgents(uuidA, "peer")],
    output: stream(uuidUse(uuidA), accepted),
    args: sendArgs(`claude:${uuidA}`),
  });
  expect(r.exit).toBe(0);
  expect(r.calls).toHaveLength(3);
  expect(r.calls.slice(0, 2)).toEqual([
    ["agents", "--json"],
    ["agents", "--json"],
  ]);
  expect(r.calls.at(-1)?.at(-1)).toContain('Target: "peer"');
});

test.each([
  uuidA.toUpperCase(),
  uuidA.replaceAll("-", "").toUpperCase(),
  "opaque-Native",
])(
  "full UUID and opaque native names bypass unavailable discovery: %s",
  async (selector) => {
    const r = await run({ kind: "codex", args: sendArgs(`codex:${selector}`) });
    expect(r.exit).toBe(0);
    expect(r.calls).toEqual([
      [
        "queue",
        "--thread",
        selector === "opaque-Native" ? selector : uuidA,
        "--message",
        envelope(message),
      ],
    ]);
  },
);

test("a registered UUID-shaped exact name wins before UUID validation", async () => {
  const r = await run({
    kind: "codex",
    threads: [{ ...firstUuidThread, name: "dead-beef" }],
    args: sendArgs("codex:dead-beef"),
  });
  expect(r.exit).toBe(0);
  expect(r.calls).toEqual([
    ["queue", "--thread", uuidA, "--message", envelope(message)],
  ]);
});

test.each(
  [
    [...sendArgs("codex:dead"), "--invalid"],
    [...sendArgs("codex:dead"), "--json"],
  ].map((args) => ({ args })),
)(
  "malformed prefix flags reject before starting any CLI: %j",
  async ({ args }) => {
    const r = await run({ args });
    expect(r.exit).toBe(2);
    expect(r.calls).toEqual([]);
  },
);

test.each(["review (v2)", "dead*", "^dead[beef]$", "review? | {v2} \\ done"])(
  "opaque native name resolves exactly before delivery: %s",
  async (name) => {
    const r = await run({
      kind: "codex",
      threads: [{ id: uuidA, name, status: { type: "idle" } }],
      args: sendArgs(`codex:${name}`),
    });
    expect(r.exit).toBe(0);
    expect(r.calls).toEqual([
      ["queue", "--thread", uuidA, "--message", envelope(message)],
    ]);
  },
);

test("prefix discovery and send share one timeout budget with no retry", async () => {
  const r = await run({
    inventory: JSON.stringify([
      { sessionId: uuidA, name: "peer", status: "idle" },
    ]),
    inventoryDelay: 550,
    delay: 550,
    output: stream(use, accepted),
    args: sendArgs("claude:dead", "900"),
  });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain("timed out");
  expect(r.calls).toHaveLength(2);
  expect(r.calls[0]).toEqual(["agents", "--json"]);
});

test("prefix discovery timeout sends nothing", async () => {
  const r = await run({
    inventory: "[]",
    inventoryDelay: 5000,
    args: sendArgs("claude:dead", "300"),
  });
  expect(r.exit).toBe(3);
  expect(r.calls).toEqual([["agents", "--json"]]);
});

// Calls count native CLI invocations; agents --json is discovery, all others send.
const sends = (calls: string[][]) =>
  calls.filter((args) => args[0] !== "agents");
const globalAgents = (id = uuidB, name = "Claude peer") =>
  JSON.stringify([{ sessionId: id, name, status: "idle" }]);

test.each([
  uuidB,
  uuidB.toUpperCase(),
  uuidB.replaceAll("-", "").toUpperCase(),
])(
  "live Claude UUID %s resolves from fixture registry before relay and retains its destination envelope",
  async (selector) => {
    const name = "fixture peer (v2)";
    const r = await run({
      registry: [{ sessionId: uuidB, name, status: "busy" }],
      relayPeer: name,
      output: completeStream(listUse, listResult, uuidUse(uuidB), accepted),
      args: sendArgs(`claude:${selector}`),
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain(`accepted for claude:${uuidB}`);
    expect(r.stdout).toContain(msgId);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toEqual(["agents", "--json"]);
    expect(r.argv.at(-1)).toContain(`Target: ${JSON.stringify(name)}`);
    expect(r.argv.at(-1)).toContain(
      JSON.stringify(envelope(message, undefined, uuidB)),
    );
  },
);

test("xmsg contract: a bound target is delivered without reading the session registry", async () => {
  const bound = encodeBoundClaudeTarget({
    selector: `claude:${uuidB}`,
    address: "claude:bound peer",
  });
  const r = await run({
    output: completeStream(uuidUse(uuidB), accepted),
    args: sendArgs(`claude:${uuidB}`),
    env: { [BOUND_CLAUDE_TARGET_ENV]: bound },
  });
  expect(r.exit).toBe(0);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]?.[0]).toBe("--print");
  expect(r.argv.at(-1)).toContain('Target: "bound peer"');
  expect(r.argv.at(-1)).toContain(
    JSON.stringify(envelope(message, undefined, uuidB)),
  );
});

test("xmsg contract: an unbound claude target still resolves through the registry", async () => {
  const name = "unbound peer";
  const r = await run({
    registry: [{ sessionId: uuidB, name, status: "busy" }],
    relayPeer: name,
    output: completeStream(listUse, listResult, uuidUse(uuidB), accepted),
    args: sendArgs(`claude:${uuidB}`),
  });
  expect(r.exit).toBe(0);
  expect(r.calls[0]).toEqual(["agents", "--json"]);
  expect(r.calls).toHaveLength(2);
  expect(r.argv.at(-1)).toContain(`Target: ${JSON.stringify(name)}`);
});

test.each([
  {
    records: [{ sessionId: uuidB, name: "peer", status: "completed" }],
    reason: "found 0 live registrations",
  },
  { records: [{ sessionId: uuidB, status: "idle" }], reason: "no native name" },
  {
    records: [
      { sessionId: uuidB, name: "peer", status: "idle" },
      { sessionId: uuidA, name: "peer", status: "busy" },
    ],
    reason: "not unique",
  },
])(
  "Claude UUID resolution refuses before relay: $reason",
  async ({ records, reason }) => {
    const r = await run({
      registry: records,
      args: sendArgs(`claude:${uuidB}`),
    });
    expect(r.exit).toBe(3);
    expect(r.calls).toEqual([["agents", "--json"]]);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain(
      `Claude target resolution failed for claude:${uuidB}`,
    );
    expect(r.stderr).toContain(reason);
    expect(r.stderr).toContain("searched claude agents --json");
    expect(r.stderr).toContain("/.claude/sessions");
    expect(r.stderr).not.toContain("relay step failed");
  },
);

test("msg contract: a uuid target with an empty sender inventory is handed to the child unchanged", async () => {
  const r = await run({
    inventory: "[]",
    args: sendArgs(`claude:${uuidB}`),
    output: completeStream(listUse, listResult),
  });
  expect(r.exit).toBe(3);
  expect(r.calls).toHaveLength(2);
  expect(r.argv.at(-1)).toContain(`Target: ${JSON.stringify(uuidB)}`);
  expect(r.stderr).toContain("ListAgents tool_use_id");
  expect(r.stderr).not.toContain("inventory schema");
});

test("deferred UUID relay reports a SendMessage refusal", async () => {
  const r = await run({
    inventory: "[]",
    args: sendArgs(`claude:${uuidB}`),
    output: completeStream(uuidUse(uuidB), result("recipient not found", "send-1", true)),
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("recipient not found");
});

test("msg contract: an unknown uuid with a visible inventory is refused with its reason", async () => {
  const r = await run({ inventory: globalAgents(uuidA), args: sendArgs(`claude:${uuidB}`) });
  expect(r.exit).toBe(3);
  expect(r.calls).toEqual([["agents", "--json"]]);
  expect(r.stderr).toContain("found 0 live registrations");
});

test("msg contract: claude uuid target resolves against the current inventory shape", async () => {
  const fixture = await Bun.file(resolve(import.meta.dir, "./host-inventory.sanitized.json")).text();
  const inventory = fixture.replace('"uuid-5"', JSON.stringify(uuidB));
  const r = await run({ inventory, args: sendArgs(`claude:${uuidB}`), output: completeStream(uuidUse(uuidB), accepted) });
  expect(r.exit).toBe(0);
  expect(r.argv.at(-1)).toContain('Target: "agx-agt_df65"');
  expect(r.stderr).not.toContain("inventory schema");
});

test("unavailable Claude UUID inventory defers to the relay", async () => {
  const r = await run({
    inventory: "invalid",
    args: sendArgs(`claude:${uuidB}`),
    output: completeStream(listUse, listResult),
  });
  expect(r.exit).toBe(3);
  expect(r.calls.slice(0, 2)).toEqual([
    ["agents", "--json"],
    ["agents", "--json"],
  ]);
  expect(r.calls[2]?.[0]).toBe("--print");
  expect(r.stderr).toContain(uuidB);
  expect(r.stderr).toContain("relay step failed");
  expect(r.stderr).not.toContain("Invalid Claude inventory schema");
});

test.each([
  uuidA,
  uuidA.replaceAll("-", "").toUpperCase(),
  "DEADBEEF-12",
  "first",
])(
  "unqualified Codex %s resolves globally and sends exact argv once",
  async (selector) => {
    const r = await run({
      threads: [firstUuidThread],
      inventory: globalAgents(),
      args: sendArgs(selector),
    });
    expect(r.exit).toBe(0);
    expect(r.calls[0]).toEqual(["agents", "--json"]);
    expect(sends(r.calls)).toEqual([
      ["queue", "--thread", uuidA, "--message", envelope(message)],
    ]);
  },
);

test.each([
  uuidB,
  "DEADBEEF-22",
  "Claude peer",
  "review (v2)",
  "^dead[beef]$",
  "review? | {v2} \\ done",
])(
  "unqualified Claude %s resolves literally and sends once",
  async (selector) => {
    const name =
      selector.startsWith("review") || selector.startsWith("^")
        ? selector
        : "Claude peer";
    const r = await run({
      threads: [firstUuidThread],
      inventory: globalAgents(uuidB, name),
      output: stream(uuidUse(uuidB), accepted),
      args: sendArgs(selector),
    });
    expect(r.exit).toBe(0);
    expect(sends(r.calls)).toHaveLength(1);
    expect(r.argv.at(-1)).toContain(`Target: ${JSON.stringify(name)}`);
    expect(r.argv.at(-1)).toContain(
      `Send this exact text once using SendMessage: ${JSON.stringify(envelope(message, undefined, uuidB))}`,
    );
  },
);

test.each([
  { selector: "deadbeef", id: uuidB, name: "second" },
  { selector: uuidA, id: uuidA, name: "duplicate identity" },
  { selector: "first", id: uuidB, name: "first" },
])(
  "global collision refuses every native send: %j",
  async ({ selector, id, name }) => {
    const r = await run({
      threads: [firstUuidThread],
      inventory: globalAgents(id, name),
      args: sendArgs(selector),
    });
    expect(r.exit).toBe(2);
    expect(sends(r.calls)).toEqual([]);
    expect(r.stderr).toContain(`claude:${id}\tname=${JSON.stringify(name)}`);
    expect(r.stderr).toContain(`codex:${uuidA}\tname="first"`);
    expect(r.stderr.indexOf(`claude:${id}`)).toBeLessThan(
      r.stderr.indexOf(`codex:${uuidA}`),
    );
    expect(r.stderr).toContain("qualify");
  },
);

test("global full identity precedes another vendor's exact name", async () => {
  const r = await run({
    threads: [firstUuidThread],
    inventory: globalAgents(uuidB, uuidA),
    args: sendArgs(uuidA),
  });
  expect(r.exit).toBe(0);
  expect(sends(r.calls)).toEqual([
    ["queue", "--thread", uuidA, "--message", envelope(message)],
  ]);
});

test.each(["deadbeef", "dead-beef", "dea"])(
  "global exact name precedes prefix or format rejection: %s",
  async (name) => {
    const r = await run({
      threads: [firstUuidThread],
      inventory: globalAgents(uuidB, name),
      output: stream(uuidUse(uuidB), accepted),
      args: sendArgs(name),
    });
    expect(r.exit).toBe(0);
    expect(sends(r.calls)).toHaveLength(1);
    expect(r.argv.at(-1)).toContain(`Target: ${JSON.stringify(name)}`);
  },
);

test.each([uuidA, "deadbeef1", "first"])(
  "partial Claude inventory blocks even an apparent Codex match: %s",
  async (selector) => {
    const r = await run({
      threads: [firstUuidThread],
      inventory: "invalid schema",
      args: sendArgs(selector),
    });
    expect(r.exit).toBe(3);
    expect(sends(r.calls)).toEqual([]);
    expect(r.stderr).toContain("claude discovery unavailable");
    expect(r.stderr).toContain("codex: or claude:");
  },
);

test("partial Codex inventory blocks an apparent Claude match", async () => {
  const r = await run({
    codexError: true,
    inventory: globalAgents(),
    args: sendArgs(uuidB),
  });
  expect(r.exit).toBe(3);
  expect(sends(r.calls)).toEqual([]);
  expect(r.stderr).toContain("codex discovery unavailable");
});

test.each(["dea", "dead-beef", "f".repeat(33), "absent", "dead*", "[first]"])(
  "global malformed or missing selector refuses: %s",
  async (selector) => {
    const r = await run({
      threads: [firstUuidThread],
      inventory: globalAgents(),
      args: sendArgs(selector),
    });
    expect(r.exit).toBe(2);
    expect(sends(r.calls)).toEqual([]);
  },
);

test.each(["", " leading", "trailing ", "other:dead", "codex:"])(
  "invalid syntax rejects before inventory: %s",
  async (selector) => {
    const r = await run({ args: sendArgs(selector) });
    expect(r.exit).toBe(2);
    expect(r.calls).toEqual([]);
  },
);

test("unqualified discovery timeout sends nothing", async () => {
  const r = await run({
    threads: [firstUuidThread],
    inventory: globalAgents(),
    inventoryDelay: 5000,
    args: sendArgs(uuidA, "100"),
  });
  expect(r.exit).toBe(3);
  expect(sends(r.calls)).toEqual([]);
});

test("both inventories run concurrently and the send receives only the remaining budget", async () => {
  const r = await run({
    threads: [],
    discoveryDelay: 250,
    inventory: globalAgents(),
    inventoryDelay: 550,
    output: stream(use, accepted),
    delay: 550,
    args: sendArgs(uuidB, "950"),
  });
  // Sequential discovery would exhaust this budget before send; a fresh send budget would succeed.
  expect(r.exit).toBe(4);
  expect(sends(r.calls)).toHaveLength(1);
  expect(r.stderr).toContain("do not resend");
});

test("global binding preserves the discovered full native UUID spelling", async () => {
  const id = uuidA.toUpperCase();
  const r = await run({
    threads: [{ id, status: { type: "active" } }],
    inventory: "[]",
    args: sendArgs(uuidA),
  });
  expect(r.exit).toBe(0);
  expect(sends(r.calls)).toEqual([
    ["queue", "--thread", id, "--message", envelope(message)],
  ]);
});

test("missing Codex endpoint blocks a globally unqualified Claude target", async () => {
  const r = await run({ inventory: globalAgents(), args: sendArgs(uuidB) });
  expect(r.exit).toBe(3);
  expect(sends(r.calls)).toEqual([]);
  expect(r.stderr).toContain("codex discovery unavailable");
});

test.each(["codex", "claude"])(
  "explicit %s sender is full and independent of recipient backend",
  async (backend) => {
    const sender = `${backend}:${uuidA}`;
    for (const kind of ["codex", "claude"] satisfies Array<
      "codex" | "claude"
    >) {
      const sentUse = {
        ...use,
        message: {
          ...use.message,
          content: [
            {
              type: "tool_use",
              id: "send-1",
              name: "SendMessage",
              input: { to: "peer", message: envelope(message, sender) },
            },
          ],
        },
      };
      const r = await run({
        kind,
        args: [...sendArgs(`${kind}:peer`), "--from", sender],
        output: stream(sentUse, accepted),
        env: {
          AGX_MSG_FROM: "invalid-parent-declaration",
          CODEX_THREAD_ID: uuidB,
          CODEX_SESSION_ID: uuidB,
          CLAUDE_CODE_SESSION_ID: uuidB,
          AGX_WORKER: "1",
        },
      });
      if (backend === "claude" && kind === "claude") {
        expect(r.exit).toBe(2);
        expect(r.called).toBe(false);
        expect(r.stderr).toContain("SendMessage");
        continue;
      }
      expect(r.exit).toBe(0);
      expect(r.calls).toHaveLength(1);
      if (kind === "codex")
        expect(r.argv.at(-1)).toBe(envelope(message, sender));
      else {
        expect(r.argv[r.argv.indexOf("--name") + 1]).toBe(
          `agx msg relay from ${sender}`,
        );
        expect(r.argv.at(-1)).toContain(
          JSON.stringify(envelope(message, sender)),
        );
      }
    }
  },
);

test.each(["codex", "claude"])(
  "recorded %s worker sender reaches the envelope",
  async (route) => {
    const r = await run({
      kind: "codex",
      args: sendArgs(`codex:${uuidB}`),
      runRecord: { route, session: uuidA },
      env: { AGX_RUN_ID: "worker-run" },
    });
    expect(r.exit).toBe(0);
    expect(r.argv.at(-1)).toBe(envelope(message, `${route}:${uuidA}`));
  },
);

test("fresh Codex sender uses its recorded live progress session", async () => {
  const r = await run({
    kind: "codex",
    args: sendArgs(`codex:${uuidB}`),
    runRecord: { route: "codex", session: null, progress: uuidA },
    env: { AGX_RUN_ID: "worker-run" },
  });
  expect(r.exit).toBe(0);
  expect(r.argv.at(-1)).toBe(envelope(message, `codex:${uuidA}`));
});

test.each([uuidA, undefined])(
  "sandbox-invisible owner uses only the named run's recorded progress session: %s",
  async (progress) => {
    const r = await run({
      kind: "codex",
      args: sendArgs(`codex:${uuidB}`),
      runRecord: {
        route: "codex",
        session: null,
        ...(progress === undefined ? {} : { progress }),
        pid: 0,
      },
      env: { AGX_RUN_ID: "worker-run", CODEX_THREAD_ID: uuidB },
    });
    expect(r.exit).toBe(0);
    expect(r.argv.at(-1)).toBe(
      envelope(
        message,
        progress === undefined ? undefined : `codex:${progress}`,
      ),
    );
  },
);

test.each([
  { route: "codex", session: null, id: "worker-run" },
  { route: "codex", session: uuidA, id: "unknown-run" },
  { route: "codex", session: "native-name", id: "worker-run" },
  { route: "unsupported", session: uuidA, id: "worker-run" },
  { route: undefined, session: uuidA, id: "worker-run" },
])(
  "unproven run sender falls through to the caller thread: %j",
  async ({ route, session, id }) => {
    const r = await run({
      kind: "codex",
      args: sendArgs(`codex:${uuidB}`),
      runRecord: { route, session },
      env: { AGX_RUN_ID: id, CODEX_THREAD_ID: uuidA },
    });
    expect(r.exit).toBe(0);
    expect(r.argv.at(-1)).toBe(envelope(message));
  },
);

test("nearest Codex process's own thread ID proves caller identity", () => {
  const identity = resolveNearestVendorIdentity([
    {
      pid: 30,
      ppid: 20,
      comm: "bun",
      argv: ["bun", "tools/xmsg/src/xmsg.ts"],
      environment: new Map([["CODEX_THREAD_ID", uuidB]]),
    },
    {
      pid: 20,
      ppid: 10,
      comm: "codex",
      argv: ["codex"],
      environment: new Map([["CODEX_THREAD_ID", uuidA]]),
    },
    {
      pid: 10,
      ppid: 1,
      comm: "claude",
      argv: ["claude"],
      environment: new Map([["CLAUDE_CODE_SESSION_ID", uuidB]]),
    },
  ]);
  expect(identity.sender).toBe(`codex:${uuidA}`);
  expect(identity.missing).toEqual([]);
});

test("a shell argument naming Codex is not itself a vendor process", () => {
  const identity = resolveNearestVendorIdentity([
    {
      pid: 30,
      ppid: 20,
      comm: "bash",
      argv: ["bash", "-c", "codex"],
      environment: new Map([["CODEX_THREAD_ID", uuidB]]),
    },
    {
      pid: 20,
      ppid: 1,
      comm: "codex",
      argv: ["codex"],
      environment: new Map([["CODEX_THREAD_ID", uuidA]]),
    },
  ]);
  expect(identity.sender).toBe(`codex:${uuidA}`);
});

test("nearest Claude process blocks an inherited outer Codex thread ID", () => {
  const identity = resolveNearestVendorIdentity([
    {
      pid: 30,
      ppid: 20,
      comm: "bun",
      argv: ["bun", "tools/xmsg/src/xmsg.ts"],
      environment: new Map([["CODEX_THREAD_ID", uuidA]]),
    },
    {
      pid: 20,
      ppid: 10,
      comm: "claude",
      argv: ["claude"],
      environment: new Map([["CLAUDE_CODE_SESSION_ID", uuidB]]),
    },
    {
      pid: 10,
      ppid: 1,
      comm: "codex",
      argv: ["codex"],
      environment: new Map([["CODEX_THREAD_ID", uuidA]]),
    },
  ]);
  expect(identity.sender).toBeUndefined();
  const diagnostic = unknownSender(identity);
  expect(diagnostic).toContain("nearest vendor process is not codex");
  expect(diagnostic).toContain(
    "checked: caller parent chain, nearest vendor process",
  );
});

test("missing nearest vendor proof names checked and missing sources", () => {
  const identity = resolveNearestVendorIdentity([
    {
      pid: 30,
      ppid: 1,
      comm: "bun",
      argv: ["bun", "tools/xmsg/src/xmsg.ts"],
    },
  ]);
  const diagnostic = unknownSender(identity);
  expect(diagnostic).toContain(
    "checked: caller parent chain, nearest vendor process",
  );
  expect(diagnostic).toContain(
    "missing: nearest codex/claude process in caller ancestry",
  );
});

test.each([false, true])(
  "explicit sender overrides recorded run (flag=%s)",
  async (flag) => {
    const sender = `claude:${uuidB}`;
    const r = await run({
      kind: "codex",
      args: [
        ...sendArgs(`codex:${uuidB}`),
        ...(flag ? ["--from", sender] : []),
      ],
      runRecord: { route: "codex", session: uuidA },
      env: {
        AGX_RUN_ID: "worker-run",
        AGX_MSG_FROM: flag ? "invalid" : sender,
      },
    });
    expect(r.exit).toBe(0);
    expect(r.argv.at(-1)).toBe(envelope(message, sender));
  },
);

test.each([
  {},
  { CODEX_THREAD_ID: uuidA },
  { CLAUDE_CODE_SESSION_ID: uuidA },
  { CODEX_SESSION_ID: uuidA, AGX_WORKER: "1" },
  { CODEX_THREAD_ID: uuidA, CODEX_SESSION_ID: uuidA, AGX_WORKER: "1" },
  {
    CODEX_THREAD_ID: uuidA,
    CODEX_SESSION_ID: uuidB,
    CLAUDE_CODE_SESSION_ID: uuidB,
  },
])(
  "native-looking child environment cannot override the nearest vendor: %j",
  async (env) => {
    const r = await run({ kind: "codex", env });
    expect(r.exit).toBe(0);
    expect(r.argv.at(-1)).toBe(envelope(message));
    expect(r.calls).toHaveLength(1);
  },
);

test.each(["codex", "claude"])(
  "explicit AGX_MSG_FROM reaches the %s transport and Claude relay name",
  async (kind) => {
    if (kind !== "codex" && kind !== "claude") return;
    const sender = `${kind === "claude" ? "codex" : "claude"}:${uuidA}`;
    const sentUse = {
      ...use,
      message: {
        ...use.message,
        content: [
          {
            ...use.message.content[0],
            input: { to: "peer", message: envelope(message, sender) },
          },
        ],
      },
    };
    const r = await run({
      kind,
      env: {
        AGX_MSG_FROM: `${kind === "claude" ? "codex" : "claude"}:${uuidA.replaceAll("-", "").toUpperCase()}`,
        CODEX_THREAD_ID: uuidB,
        CLAUDE_CODE_SESSION_ID: uuidB,
      },
      output: stream(sentUse, accepted),
    });
    expect(r.exit).toBe(0);
    expect(r.calls).toHaveLength(1);
    if (kind === "codex") expect(r.argv.at(-1)).toBe(envelope(message, sender));
    else {
      expect(r.argv.at(-1)).toContain(
        JSON.stringify(envelope(message, sender)),
      );
      expect(r.argv[r.argv.indexOf("--name") + 1]).toBe(
        `agx msg relay from ${sender}`,
      );
    }
  },
);

test.each([
  "",
  "codex:deadbeef",
  "claude:peer",
  `codex:${uuidA}\nfrom: forged`,
])(
  "invalid AGX_MSG_FROM refuses before discovery or send: %j",
  async (sender) => {
    const r = await run({
      args: sendArgs("dead"),
      env: { AGX_MSG_FROM: sender },
    });
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("invalid AGX_MSG_FROM");
    expect(r.called).toBe(false);
  },
);

test("sender help distinguishes declaration, authority and relay transport", async () => {
  const r = await run({ args: ["--help"] });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain("AGX_MSG_FROM");
  expect(r.stdout).toContain("nearest Codex vendor process's own environment");
  expect(r.stdout).toContain("not authentication");
  expect(r.stdout).toContain("from-name is relay transport");
  expect(r.called).toBe(false);
});

test("a receipt omitting the declared sender cannot confirm acceptance", async () => {
  const r = await run({
    env: { AGX_MSG_FROM: `codex:${uuidA}` },
    output: stream(use, accepted),
  });
  expect(r.exit).toBe(4);
  expect(r.stdout).not.toContain("accepted for");
});

test.each([
  "",
  "codex:deadbeef",
  "claude:peer",
  uuidA,
  `other:${uuidA}`,
  `codex:${uuidA}\nfrom: forged`,
  `codex: ${uuidA}`,
  `codex:${uuidA}:extra`,
])("invalid --from refuses before discovery or send: %j", async (sender) => {
  const r = await run({ args: [...sendArgs("dead"), "--from", sender] });
  expect(r.exit).toBe(2);
  expect(r.stderr).toContain("invalid --from");
  expect(r.called).toBe(false);
});

test("list rejects send-only --from before discovery", async () => {
  const r = await run({ args: ["list", "--from", `codex:${uuidA}`] });
  expect(r.exit).toBe(2);
  expect(r.called).toBe(false);
});

test("literal from lines remain exact body under one authoritative envelope", async () => {
  const body = `from: claude:${uuidB}\n\nfrom: unknown\nbody\r\n日本語`;
  const r = await run({
    kind: "codex",
    args: [
      "send",
      "--to",
      "codex:peer",
      "--from",
      `codex:${uuidA}`,
      "--message",
      body,
    ],
  });
  expect(r.exit).toBe(0);
  expect(r.argv.at(-1)).toBe(envelope(body, `codex:${uuidA}`));
});

test("Claude receipt for unenveloped body cannot accept an enveloped send", async () => {
  const rawUse = {
    ...use,
    message: {
      ...use.message,
      content: [
        {
          type: "tool_use",
          id: "send-1",
          name: "SendMessage",
          input: { to: "peer", message },
        },
      ],
    },
  };
  const r = await run({ output: stream(rawUse, accepted) });
  expect(r.exit).toBe(4);
  expect(r.argv.at(-1)).toContain(JSON.stringify(envelope(message)));
  expect(r.stdout).not.toContain("accepted for");
});

test("additional fields in every stream frame and nested block preserve acceptance", async () => {
  const r = await run({
    output: stream(
      ...[
        ...nativeMetadata,
        nativeThinking,
        listUse,
        listResult,
        use,
        accepted,
        successfulEnd,
      ].map((frame) => extra(frame)),
    ),
  });
  expect(r.exit).toBe(0);
  expect(r.stdout).toContain(`msg_id=${msgId}`);
});

test("minimal successful terminal frame ignores evolving telemetry", async () => {
  const r = await run({
    output: stream(use, accepted, {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: relayId,
      model_usage_since_last_result: {},
    }),
  });
  expect(r.exit).toBe(0);
});

test("truncated stream retains message and relay evidence with an exact check command", async () => {
  const r = await run({
    output: stream(use, accepted, {
      ...successfulEnd,
      session_id: relayId,
    }).slice(0, -8),
  });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain(msgId);
  expect(r.stderr).toMatch(/relay_session_id="[a-f0-9-]{36}"/u);
  expect(r.stderr).toMatch(/agx msg status --relay '[a-f0-9-]{36}'/u);
});

test("unknown final result retains its session ID and observed message ID", async () => {
  const r = await run({
    output: stream(use, accepted, { ...errorEnd, session_id: relayId }),
  });
  expect(r.exit).toBe(4);
  expect(r.stderr).toContain(`relay_session_id="${relayId}"`);
  expect(r.stderr).toContain(msgId);
  expect(r.stderr).toContain(`agx msg status --relay '${relayId}'`);
});

test.each([
  { name: "accepted", frames: [use, accepted], exit: 0 },
  {
    name: "rejected",
    frames: [use, result("denied", "send-1", true)],
    exit: 1,
  },
  { name: "unknown", frames: [use], exit: 4 },
])(
  "status reads native transcript: $name without invoking a transport",
  async ({ frames, exit }) => {
    const transcript = stream(
      {
        type: "user",
        sessionId: relayId,
        message: { role: "user", content: "relay prompt" },
      },
      { type: "progress", sessionId: relayId, data: { arbitrary: true } },
      ...frames.map((frame) => ({ ...frame, sessionId: relayId })),
    );
    const r = await run({ args: ["status", "--relay", relayId], transcript });
    expect(r.exit).toBe(exit);
    expect(r.called).toBe(false);
    expect(r.stdout + r.stderr).toContain(`relay_session_id=${relayId}`);
    if (exit === 0) expect(r.stdout).toContain(msgId);
  },
);

test("status cannot infer delivery from missing or truncated transcript", async () => {
  for (const transcript of [undefined, stream(use, accepted) + '{"type":']) {
    const r = await run({ args: ["status", "--relay", relayId], transcript });
    expect(r.exit).toBe(4);
    expect(r.called).toBe(false);
    expect(r.stderr).toContain("acceptance unknown");
  }
});

test.each(
  [
    ["status"],
    ["status", "--relay", "../escape"],
    ["status", "--relay", relayId, "--to", "claude:peer"],
    ["send", "--to", "claude:peer", "--message", "hello", "--relay", relayId],
    ["list", "--relay", relayId],
  ].map((args) => ({ args })),
)(
  "status/send flag boundaries reject without a transport: %j",
  async ({ args }) => {
    const r = await run({ args });
    expect(r.exit).toBe(2);
    expect(r.called).toBe(false);
  },
);

test("additional metadata and final-result fields preserve a complete no-send result", async () => {
  const r = await run({
    output: stream(
      ...[...nativeMetadata, listUse, listResult, successfulEnd].map((frame) =>
        extra(frame),
      ),
    ),
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("no SendMessage attempted");
});

const replySender = "codex:aaaaaaaa-1234-4abc-8def-0123456789ab";
const replyTarget = "bbbbbbbb-1234-4abc-8def-0123456789ab";
test.each([replyTarget, "peer"])(
  "Codex sender replies to Claude %s with a correlated acceptance",
  async (target) => {
    const text = envelope(
      message,
      replySender,
      target === "peer" ? undefined : target,
    );
    const event = {
      ...use,
      message: {
        ...use.message,
        content: [
          { ...use.message.content[0], input: { to: "peer", message: text } },
        ],
      },
    };
    const r = await run({
      args: [
        "send",
        "--to",
        "claude:" + target,
        "--from",
        replySender,
        "--message",
        message,
      ],
      inventory: JSON.stringify([
        { sessionId: replyTarget, name: "peer", status: "busy" },
      ]),
      output: completeStream(event, accepted),
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain(msgId);
    expect(r.argv.at(-1)).toContain(JSON.stringify(text));
    expect(r.argv.at(-1)).toContain('Target: "peer"');
  },
);
const waitArgs = [
  "wait",
  "--to",
  "codex:" + replyTarget,
  "--from",
  replySender,
  "--message",
  "reply nonce-1024",
  "--timeout-ms",
  "150",
];
const input = (text: string, type = "userMessage") => ({
  id: "input-1024",
  type,
  content: [{ type: "text", text }],
});
const replyThread = (items: ReturnType<typeof input>[]) => [
  { id: replyTarget, status: { type: "idle" }, turns: [{ items }] },
];
test("wait succeeds only with exact addressed native user input evidence", async () => {
  const r = await run({
    args: waitArgs,
    threads: replyThread([input(envelope("reply nonce-1024", replySender))]),
  });
  expect(r.exit).toBe(0);
  const parsed = jsonOf(z.object({ itemId: z.string() })).safeParse(r.stdout);
  expect(parsed.success && parsed.data.itemId).toBe("input-1024");
  expect(r.stderr).toContain("waiting up to");
  expect(r.called).toBe(false);
});
test.each([
  input(envelope("wrong body", replySender)),
  input(envelope("reply nonce-1024", "claude:" + replyTarget)),
  input(envelope("reply nonce-1024", replySender), "agentMessage"),
  input("accepted for codex:" + replyTarget),
])("wait cannot turn non-reply evidence into success: %j", async (item) => {
  const r = await run({ args: waitArgs, threads: replyThread([item]) });
  expect(r.exit).toBe(4);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("no matching native thread input");
});
test("wait refuses Claude inbox observation without calling a vendor", async () => {
  const r = await run({
    args: [
      "wait",
      "--to",
      "claude:" + replyTarget,
      "--from",
      replySender,
      "--message",
      "nonce",
    ],
  });
  expect(r.exit).toBe(3);
  expect(r.stderr).toContain("no inbox read API");
  expect(r.called).toBe(false);
});
test("wait reports absent Codex endpoint as unavailable", async () => {
  const r = await run({ args: waitArgs });
  expect(r.exit).toBe(3);
  expect(r.stdout).toBe("");
});
test("wait rejects names, missing sender and invalid deadlines", async () => {
  for (const args of [
    ["wait"],
    [...waitArgs, "--to", "codex:peer"],
    [...waitArgs, "--timeout-ms", "0"],
  ]) {
    const r = await run({ args });
    expect(r.exit).toBe(2);
    expect(r.called).toBe(false);
  }
});

test("send timing measures discovery separately from the one-shot Claude relay", async () => {
  const r = await run({
    args: ["send", "--to", "claude:peer", "--message", message, "--timing"],
    output: completeStream(use, accepted),
    delay: 80,
  });
  expect(r.exit).toBe(0);
  const parsed = jsonOf(
    z.object({
      transport: z.string(),
      transportMs: z.number(),
      totalMs: z.number(),
      discoveryMs: z.number(),
    }),
  ).safeParse(r.stderr.trim());
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const timing = parsed.data;
  expect(timing.transport).toBe("one-shot claude --print model relay");
  expect(timing.transportMs).toBeGreaterThanOrEqual(70);
  expect(timing.totalMs).toBeGreaterThanOrEqual(timing.transportMs);
  expect(timing.discoveryMs).toBeLessThan(timing.transportMs);
  process.stdout.write(
    `Fixture latency measurement: ${JSON.stringify(timing)}\n`,
  );
});

test("wait deadline covers a backend that never answers before expiry", async () => {
  const r = await run({
    args: waitArgs,
    threads: replyThread([]),
    discoveryDelay: 300,
  });
  expect(r.exit).toBe(4);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("reply deadline exceeded");
});

test("wait polls until a reply becomes native thread input", async () => {
  const r = await run({
    args: [...waitArgs, "--timeout-ms", "1500"],
    threads: replyThread([input(envelope("reply nonce-1024", replySender))]),
    replyAfterReads: 2,
  });
  expect(r.exit).toBe(0);
  const parsed = jsonOf(z.object({ elapsedMs: z.number() })).safeParse(
    r.stdout,
  );
  expect(parsed.success && parsed.data.elapsedMs >= 200).toBe(true);
});
