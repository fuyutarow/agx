import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude, toRelay } from "../src/workers/run-claude.ts";
import { claudeCredentialDetails } from "../src/workers/claude-credential.ts";

test("fnox precedence, fallback and actual credential receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-fnox-"));
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
  process.env.PATH = `${root}:${old.PATH ?? ""}`;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const fnox = join(root, "fnox");
  writeFileSync(fnox, '#!/bin/sh\nprintf "fnox-secret\\n"\n', { mode: 0o755 });
  const dir = join(root, ".config", "agx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "anthropic-api-key"), "file-secret", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "env-secret" };
  expect(claudeCredentialDetails(env)).toEqual({
    credential: "api_key",
    credential_source: "env",
  });
  expect(env.ANTHROPIC_API_KEY).toBe("env-secret");
  const fromFnox: NodeJS.ProcessEnv = {};
  expect(claudeCredentialDetails(fromFnox).credential_source).toBe("fnox");
  expect(fromFnox.ANTHROPIC_API_KEY).toBe("fnox-secret");
  writeFileSync(fnox, "#!/bin/sh\nexit 1\n");
  const fromFile: NodeJS.ProcessEnv = {};
  expect(claudeCredentialDetails(fromFile).credential_source).toBe("file");
  expect(fromFile.ANTHROPIC_API_KEY).toBe("file-secret");
  writeFileSync(fnox, '#!/bin/sh\nprintf "fnox-secret\\n"\n');
  const claude = join(root, "claude");
  writeFileSync(
    claude,
    '#!/bin/sh\nif [ "$AGX_FAKE_FAIL" = 1 ] && [ -n "$ANTHROPIC_API_KEY" ]; then echo "Credit balance too low" >&2; exit 1; fi\nprintf \'{"result":"ok"}\\n\'\n',
  );
  chmodSync(claude, 0o755);
  const config = {
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 5000,
    safeMode: false,
    bare: false,
    claudeBin: claude,
  };
  let result = await runClaude(config);
  expect(toRelay(result)).toMatchObject({
    credential: "api_key",
    credential_source: "fnox",
  });
  expect(JSON.stringify(toRelay(result))).not.toContain("fnox-secret");
  process.env.AGX_FAKE_FAIL = "1";
  result = await runClaude(config);
  expect(toRelay(result).credential).toBe("subscription");
  expect(toRelay(result).credential_source).toBeUndefined();
  expect(
    readFileSync(join(root, "state", "claude-credits-unavailable"), "utf8"),
  ).toContain("credits unavailable");
});

test("credential fields survive record folding", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-fnox-record-"));
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const at = "2026-11-10T00:00:00Z";
  const started = {
    kind: "started",
    id: "fixture",
    at,
    ticket: "fixture",
    writes: [],
    cwd: root,
    workspace: root,
    row: "claude",
    dispatcher_session: null,
    vendor_session: null,
    pid: 0,
  };
  const ended = {
    kind: "ended",
    id: "fixture",
    at,
    exit: 0,
    outcome: "ok",
    report_path: null,
    vendor_session: null,
    credential: "api_key",
    credential_source: "fnox",
  };
  writeFileSync(
    join(root, "records.jsonl"),
    [started, ended].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const { foldedRuns } = await import("../src/next/store.ts");
  expect((await foldedRuns(root))[0]).toMatchObject({
    credential: "api_key",
    credential_source: "fnox",
  });
});
