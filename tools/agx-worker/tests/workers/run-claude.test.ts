import { expect, test } from "bun:test";
import {
  chmodSync,
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
import { claudeCredential } from "../../src/workers/claude-credential.ts";
import { workerEnvironment } from "../../src/workers/environment.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const Call = z.object({
  key: z.boolean(),
  token: z.boolean(),
  fileKey: z.boolean().optional(),
});
const resolveCredential = (env: NodeJS.ProcessEnv) =>
  claudeCredential(workerEnvironment(env));

test("file, inherited credentials, cooldown and one fallback stay confined to the child", async () => {
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
  writeFileSync(join(root, "fnox"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
  process.env.HOME = root;
  process.env.AGX_STATE_DIR = join(root, "state");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const bin = join(root, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.cwd() + "/calls", JSON.stringify({ key: !!process.env.ANTHROPIC_API_KEY, token: !!process.env.ANTHROPIC_AUTH_TOKEN, argv: process.argv.slice(2) }) + "\\n");\nif (process.env.ANTHROPIC_API_KEY && process.env.AGX_TEST_FAIL === "1") { process.stderr.write("Credit balance too low\\n"); process.exit(1); }\nprocess.stdout.write(JSON.stringify({result: process.env.AGX_TEST_ECHO === "1" ? process.env.ANTHROPIC_API_KEY : "OK"}));\n`,
  );
  writeFileSync(
    bin,
    readFileSync(bin, "utf8").replace(
      "key: !!process.env.ANTHROPIC_API_KEY,",
      'key: !!process.env.ANTHROPIC_API_KEY, fileKey: process.env.ANTHROPIC_API_KEY === "file-secret",',
    ),
  );
  chmodSync(bin, 0o700);
  const config = {
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 5000,
    safeMode: false,
    bare: false,
    claudeBin: bin,
  };
  const keyPath = join(root, ".config", "agx", "anthropic-api-key");
  mkdirSync(join(root, ".config", "agx"), { recursive: true });
  let run = await runClaude(config);
  expect(run.credential).toBe("subscription");
  process.env.ANTHROPIC_API_KEY = "inherited-secret";
  run = await runClaude(config);
  expect(run.credential).toBe("api_key");
  delete process.env.ANTHROPIC_API_KEY;
  writeFileSync(keyPath, "file-secret\n", { mode: 0o600 });
  process.env.ANTHROPIC_AUTH_TOKEN = "token-secret";
  process.env.AGX_TEST_ECHO = "1";
  run = await runClaude(config);
  expect(JSON.stringify(toRelay(run))).not.toContain("file-secret");
  expect(run.credential).toBe("api_key");
  expect(toRelay(run).result).toBe("[REDACTED]");
  process.env.ANTHROPIC_API_KEY = "inherited-secret";
  run = await runClaude(config);
  expect(toRelay(run).result).toBe("[REDACTED]");
  process.env.AGX_TEST_FAIL = "1";
  run = await runClaude(config);
  expect(run.credential).toBe("subscription");
  expect(run.exitCode).toBe(0);
  const marker = join(root, "state", "claude-credits-unavailable");
  expect(Bun.file(marker).size).toBeGreaterThan(0);
  const calls = () =>
    readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => {
        const parsed = jsonOf(Call).safeParse(line);
        expect(parsed.success).toBe(true);
        return parsed.success ? [parsed.data] : [];
      });
  const observedCalls = calls();
  expect(observedCalls).toHaveLength(6);
  const [initialCall, inheritedCall, tokenCall, fileCall] = observedCalls;
  expect(initialCall).toBeDefined();
  expect(inheritedCall).toBeDefined();
  expect(tokenCall).toBeDefined();
  expect(fileCall).toBeDefined();
  if (
    initialCall === undefined ||
    inheritedCall === undefined ||
    tokenCall === undefined ||
    fileCall === undefined
  ) {
    expect(initialCall, "expected six parsed claude calls").toBeDefined();
    return;
  }
  expect([initialCall.key, initialCall.token]).toEqual([false, false]);
  expect(inheritedCall.key).toBe(true);
  expect(tokenCall.key).toBe(true);
  expect(fileCall.fileKey).toBe(false);
  expect(
    calls()
      .slice(-2)
      .map((call) => [call.key, call.token]),
  ).toEqual([
    [true, false],
    [false, false],
  ]);
  run = await runClaude(config);
  expect(run.credential).toBe("subscription");
  const lastCall = calls().at(-1);
  expect(lastCall).toBeDefined();
  if (lastCall === undefined) {
    expect(lastCall, "expected a final claude call").toBeDefined();
    return;
  }
  expect(lastCall.token).toBe(false);
  const oldTimestamp =
    Temporal.Now.instant().subtract({ hours: 25 }).epochMilliseconds / 1000;
  utimesSync(marker, oldTimestamp, oldTimestamp);
  delete process.env.AGX_TEST_FAIL;
  run = await runClaude(config);
  expect(run.credential).toBe("api_key");
  expect(readFileSync(join(root, "calls"), "utf8")).not.toContain(
    "file-secret",
  );
  chmodSync(keyPath, 0o644);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  run = await runClaude(config);
  expect(run.credential).toBe("subscription");
});

test("shared credential resolution covers file and inherited credentials until cooldown", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-credential-pick-"));
  const oldHome = process.env.HOME;
  const oldState = process.env.AGX_STATE_DIR;
  const oldPath = process.env.PATH;
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
  });
  process.env.HOME = root;
  process.env.AGX_STATE_DIR = join(root, "state");
  expect(resolveCredential({})).toBe("subscription");
  expect(resolveCredential({ ANTHROPIC_API_KEY: "inherited" })).toBe("api_key");
  expect(resolveCredential({ ANTHROPIC_AUTH_TOKEN: "inherited" })).toBe(
    "api_key",
  );
  mkdirSync(join(root, ".config", "agx"), { recursive: true });
  writeFileSync(
    join(root, ".config", "agx", "anthropic-api-key"),
    "file-secret",
    { mode: 0o600 },
  );
  expect(resolveCredential({})).toBe("api_key");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "claude-credits-unavailable"),
    "unavailable",
  );
  expect(resolveCredential({})).toBe("subscription");
  expect(resolveCredential({ ANTHROPIC_API_KEY: "inherited" })).toBe(
    "subscription",
  );
  expect(resolveCredential({ ANTHROPIC_AUTH_TOKEN: "inherited" })).toBe(
    "subscription",
  );
});
