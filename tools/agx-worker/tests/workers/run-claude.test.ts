import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude, toRelay } from "../../src/workers/run-claude.ts";
import {
  claudeCredential,
  claudeCredentialDetails,
  creditsMarkerStatus,
} from "../../src/workers/claude-credential.ts";
import { workerEnvironment } from "../../src/workers/environment.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const Call = z.object({
  key: z.boolean(),
  token: z.boolean(),
  fileKey: z.boolean().optional(),
});
const resolveCredential = (env: NodeJS.ProcessEnv) =>
  claudeCredential(workerEnvironment(env));

test("claude-session never passes a key; claude-api file, inherited and redacted keys stay confined to the child and a credits failure ends as capacity without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-credit-test-"));
  // In-process snapshot for restoring process.env below; no subprocess inherits it.
  const old = Object.assign({}, process.env);
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  cleanup.defer(() => {
    for (const key of Object.keys(process.env))
      if (!Object.hasOwn(old, key)) delete process.env[key];
    Object.assign(process.env, old);
  });
  // The fnox stub logs each call so a route that consults fnox is observable; it always fails.
  writeFileSync(
    join(root, "fnox"),
    `#!/bin/sh\necho called >> '${root}/fnox.log'\nexit 1\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
  process.env.HOME = root;
  process.env.AGX_STATE_DIR = join(root, "state");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const bin = join(root, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.cwd() + "/calls", JSON.stringify({ key: !!process.env.ANTHROPIC_API_KEY, fileKey: process.env.ANTHROPIC_API_KEY === "file-secret", token: !!process.env.ANTHROPIC_AUTH_TOKEN, argv: process.argv.slice(2) }) + "\\n");\nif (process.env.ANTHROPIC_API_KEY && process.env.AGX_TEST_FAIL === "1") { process.stderr.write("Credit balance too low\\n"); process.exit(1); }\nprocess.stdout.write(JSON.stringify({result: process.env.AGX_TEST_ECHO === "1" ? process.env.ANTHROPIC_API_KEY : "OK"}));\n`,
  );
  chmodSync(bin, 0o700);
  const session = {
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 5000,
    safeMode: false,
    bare: false,
    claudeBin: bin,
    route: "claude-session" as const,
  };
  const api = { ...session, route: "claude-api" as const };
  const keyPath = join(root, ".config", "agx", "anthropic-api-key");
  mkdirSync(join(root, ".config", "agx"), { recursive: true });
  const calls = () => {
    if (!existsSync(join(root, "calls"))) return [];
    return readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => {
        const parsed = jsonOf(Call).safeParse(line);
        expect(parsed.success).toBe(true);
        return parsed.success ? [parsed.data] : [];
      });
  };
  const shape = () =>
    calls().map((call) => [call.key, call.fileKey === true, call.token]);

  // claude-session: even with an inherited key set, no key or token reaches the child and fnox is never consulted.
  let run = await runClaude(session);
  expect(run.credential).toBe("subscription");
  expect(run.credential_source).toBeUndefined();
  process.env.ANTHROPIC_API_KEY = "inherited-secret";
  run = await runClaude(session);
  expect(run.credential).toBe("subscription");
  expect(run.exitCode).toBe(0);
  expect(shape()).toEqual([
    [false, false, false],
    [false, false, false],
  ]);
  expect(existsSync(join(root, "fnox.log"))).toBe(false);

  // claude-api: the inherited key is used, redacted in the relay.
  run = await runClaude(api);
  expect(run.credential).toBe("api_key");
  expect(run.credential_source).toBe("env");
  // No env key: fnox is consulted (and fails), then the file key is used; the token is dropped.
  delete process.env.ANTHROPIC_API_KEY;
  writeFileSync(keyPath, "file-secret\n", { mode: 0o600 });
  process.env.ANTHROPIC_AUTH_TOKEN = "token-secret";
  process.env.AGX_TEST_ECHO = "1";
  run = await runClaude(api);
  expect(JSON.stringify(toRelay(run))).not.toContain("file-secret");
  expect(run.credential).toBe("api_key");
  expect(run.credential_source).toBe("file");
  expect(existsSync(join(root, "fnox.log"))).toBe(true);
  expect(toRelay(run).result).toBe("[REDACTED]");
  process.env.ANTHROPIC_API_KEY = "inherited-secret";
  run = await runClaude(api);
  expect(toRelay(run).result).toBe("[REDACTED]");

  // A credits failure on claude-api ends the attempt as capacity, writes the marker, and is not retried on subscription.
  process.env.AGX_TEST_FAIL = "1";
  const before = calls().length;
  run = await runClaude(api);
  expect(run.credential).toBe("api_key");
  expect(run.exitCode).toBe(75);
  expect(toRelay(run)).toMatchObject({
    outcome: "capacity",
    cause: "credits_unavailable",
  });
  expect(calls()).toHaveLength(before + 1);
  const marker = join(root, "state", "claude-credits-unavailable");
  expect(Bun.file(marker).size).toBeGreaterThan(0);
  expect(readFileSync(marker, "utf8")).toContain("credits unavailable");
  expect(creditsMarkerStatus()).toMatchObject({ present: true, fresh: true });

  // claude-session is unaffected by the fresh marker: it still runs without a key.
  run = await runClaude(session);
  expect(run.credential).toBe("subscription");
  expect(run.exitCode).toBe(0);
  expect(calls().at(-1)).toMatchObject({ key: false, token: false });

  // The marker is a 24 h cooldown: once older than that it no longer counts as fresh.
  const oldTimestamp =
    Temporal.Now.instant().subtract({ hours: 25 }).epochMilliseconds / 1000;
  utimesSync(marker, oldTimestamp, oldTimestamp);
  expect(creditsMarkerStatus()).toMatchObject({ present: true, fresh: false });

  // No key anywhere: claude-api ends as credential_unavailable without spawning claude.
  delete process.env.AGX_TEST_FAIL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  chmodSync(keyPath, 0o644);
  const spawned = calls().length;
  run = await runClaude(api);
  expect(run.exitCode).toBe(75);
  expect(toRelay(run)).toMatchObject({
    outcome: "capacity",
    cause: "credential_unavailable",
  });
  expect(calls()).toHaveLength(spawned);

  // Full observed call order: session (no key), session (inherited key stripped), api inherited,
  // api file (token dropped), api inherited redacted, api failing (one call, no retry), session after marker.
  expect(shape()).toEqual([
    [false, false, false],
    [false, false, false],
    [true, false, false],
    [true, true, false],
    [true, false, false],
    [true, false, false],
    [false, false, false],
  ]);
});

test("claude-api credential resolution reads env, then fnox, then file and ignores the credits marker; claude-session never resolves a key", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-credential-pick-"));
  const oldHome = process.env.HOME;
  const oldState = process.env.AGX_STATE_DIR;
  const oldPath = process.env.PATH;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  const oldToken = process.env.ANTHROPIC_AUTH_TOKEN;
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  cleanup.defer(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldState === undefined) delete process.env.AGX_STATE_DIR;
    else process.env.AGX_STATE_DIR = oldState;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
    if (oldToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = oldToken;
  });
  process.env.HOME = root;
  process.env.AGX_STATE_DIR = join(root, "state");
  // The machine's real fnox must not supply a key: look for it only in the empty temp root.
  process.env.PATH = root;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // Nothing configured: the claude-api resolver finds no key.
  expect(resolveCredential({})).toBe("subscription");

  // The fnox stub is consulted before the file.
  writeFileSync(join(root, "fnox"), "#!/bin/sh\nprintf 'fnox-secret\\n'\n", {
    mode: 0o755,
  });
  expect(claudeCredentialDetails({})).toEqual({
    credential: "api_key",
    credential_source: "fnox",
  });
  rmSync(join(root, "fnox"));

  mkdirSync(join(root, ".config", "agx"), { recursive: true });
  writeFileSync(
    join(root, ".config", "agx", "anthropic-api-key"),
    "file-secret",
    { mode: 0o600 },
  );
  expect(claudeCredentialDetails({})).toEqual({
    credential: "api_key",
    credential_source: "file",
  });
  expect(resolveCredential({ ANTHROPIC_API_KEY: "inherited" })).toBe("api_key");

  // A fresh credits marker does not change claude-api key resolution; routing filters the route instead.
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "claude-credits-unavailable"),
    "unavailable",
  );
  expect(creditsMarkerStatus()).toMatchObject({ present: true, fresh: true });
  expect(resolveCredential({})).toBe("api_key");
  expect(resolveCredential({ ANTHROPIC_AUTH_TOKEN: "inherited" })).toBe(
    "api_key",
  );

  // claude-session never resolves or passes a key, even with one inherited, and does not consult fnox or the file.
  const bin = join(root, "claude-session-bin");
  writeFileSync(bin, '#!/bin/sh\necho \'{"result":"ok"}\'\n', { mode: 0o755 });
  process.env.ANTHROPIC_API_KEY = "inherited";
  process.env.ANTHROPIC_AUTH_TOKEN = "inherited";
  writeFileSync(
    join(root, "fnox"),
    "#!/bin/sh\necho called >> '" + root + "/fnox.log'\nexit 1\n",
    { mode: 0o755 },
  );
  const run = await runClaude({
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 5000,
    safeMode: false,
    bare: false,
    claudeBin: bin,
    route: "claude-session",
  });
  expect(run.credential).toBe("subscription");
  expect(run.credential_source).toBeUndefined();
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(root, "fnox.log"))).toBe(false);
});

test("a Claude result event saying the credit balance is too low ends the attempt as capacity and writes the marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-credit-result-"));
  // In-process snapshot for restoring process.env below; no subprocess inherits it.
  const old = Object.assign({}, process.env);
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  cleanup.defer(() => {
    for (const key of Object.keys(process.env))
      if (!Object.hasOwn(old, key)) delete process.env[key];
    Object.assign(process.env, old);
  });
  process.env.HOME = root;
  process.env.AGX_STATE_DIR = join(root, "state");
  process.env.ANTHROPIC_API_KEY = "inline-test-secret";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const bin = join(root, "claude");
  const log = join(root, "calls.log");
  // Mirrors the attempt-01.json shape: a stream-json result event with is_error true.
  writeFileSync(
    bin,
    `#!/bin/sh\necho call >> ${JSON.stringify(log)}\nif [ -n "$ANTHROPIC_API_KEY" ]; then printf '%s\\n' '{"type":"result","is_error":true,"result":"Credit balance is too low"}'; exit 1; fi\nprintf '{"result":"ok"}\\n'\n`,
  );
  chmodSync(bin, 0o755);
  const run = await runClaude({
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 10_000,
    safeMode: false,
    bare: false,
    claudeBin: bin,
    route: "claude-api",
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  const relay = toRelay(run);
  expect(relay.outcome).toBe("capacity");
  expect(relay.cause).toBe("credits_unavailable");
  expect(relay.credential).toBe("api_key");
  expect(run.exitCode).toBe(75);
  expect(
    readFileSync(join(root, "state", "claude-credits-unavailable"), "utf8"),
  ).toContain("credits unavailable");
});
