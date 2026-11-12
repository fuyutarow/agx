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
import { jsonText } from "../../shared/src/zod.ts";
import { recordAttemptCredential } from "../src/workers/claude-credential.ts";
import { runClaude } from "../src/workers/run-claude.ts";
import { append, foldedRuns } from "../src/next/store.ts";

const at = "2026-11-10T00:00:00Z";

function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), "agx-credential-timeout-"));
  const runDir = join(root, "runs", id);
  mkdirSync(runDir, { recursive: true });
  append(
    {
      kind: "started",
      id,
      at,
      ticket: "fixture",
      writes: [],
      cwd: root,
      workspace: root,
      row: "claude",
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
    },
    root,
  );
  return { root, runDir };
}

const startOf = (file: string): unknown =>
  jsonText.safeParse(readFileSync(file, "utf8")).data;

const startRecord = (attempt: number) =>
  `${JSON.stringify({ attempt, executable: "bun", argv: ["bun", "worker"] })}\n`;

const ended = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "ended" as const,
  id,
  at,
  exit: 143,
  outcome: "timeout" as const,
  report_path: null,
  vendor_session: null,
  run_dir_bytes: 0,
  ...extra,
});

test("a timed-out run with a start record and no receipt folds to the start record's credential", async () => {
  const { root, runDir } = fixture("timed-out");
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(runDir, "spawn-01.json");
  writeFileSync(file, startRecord(1));
  recordAttemptCredential(
    { credential: "api_key", credential_source: "fnox" },
    file,
  );
  const record = startOf(file);
  expect(record).toMatchObject({
    attempt: 1,
    credential: "api_key",
    credential_source: "fnox",
  });
  append(ended("timed-out"), root);
  expect((await foldedRuns(root))[0]).toMatchObject({
    id: "timed-out",
    outcome: "timeout",
    credential: "api_key",
    credential_source: "fnox",
  });
});

test("the last attempt's start record is the one folded", async () => {
  const { root, runDir } = fixture("two-attempts");
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(runDir, "spawn-01.json"), startRecord(1));
  writeFileSync(join(runDir, "spawn-02.json"), startRecord(2));
  recordAttemptCredential(
    { credential: "api_key", credential_source: "env" },
    join(runDir, "spawn-01.json"),
  );
  recordAttemptCredential(
    { credential: "subscription" },
    join(runDir, "spawn-02.json"),
  );
  append(ended("two-attempts"), root);
  const run = (await foldedRuns(root))[0];
  expect(run?.credential).toBe("subscription");
  expect(run?.credential_source).toBeUndefined();
});

test("a final receipt that fell back to the subscription folds to subscription", async () => {
  const { root, runDir } = fixture("fell-back");
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(runDir, "spawn-01.json");
  writeFileSync(file, startRecord(1));
  recordAttemptCredential(
    { credential: "api_key", credential_source: "env" },
    file,
  );
  append(
    ended("fell-back", { exit: 0, outcome: "ok", credential: "subscription" }),
    root,
  );
  const run = (await foldedRuns(root))[0];
  expect(run?.credential).toBe("subscription");
  expect(run?.credential_source).toBeUndefined();
});

test("a run without a start credential stays without one", async () => {
  const { root, runDir } = fixture("none");
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(runDir, "spawn-01.json"), startRecord(1));
  append(ended("none"), root);
  const run = (await foldedRuns(root))[0];
  expect(run?.credential).toBeUndefined();
  expect(run?.credential_source).toBeUndefined();
});

test("runClaude records the credential in the start record before spawning, never the key", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-credential-spawn-"));
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
  process.env.ANTHROPIC_API_KEY = "env-secret-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const file = join(root, "spawn-01.json");
  writeFileSync(file, startRecord(1));
  process.env.AGX_ATTEMPT_START_FILE = file;
  const claude = join(root, "claude");
  writeFileSync(claude, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(claude, 0o755);
  const result = await runClaude({
    target: root,
    prompt: "hello",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 500,
    safeMode: false,
    bare: false,
    claudeBin: claude,
    route: "claude-session" as const,
  });
  expect(result.timedOut).toBe(true);
  const text = readFileSync(file, "utf8");
  expect(startOf(file)).toMatchObject({
    credential: "api_key",
    credential_source: "env",
  });
  expect(text).not.toContain("env-secret-key");
});
