import assert from "node:assert/strict";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fromThrowable } from "neverthrow";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const Schema = jsonOf(
  z.object({
    schema: z.literal(1),
    vendor: z.literal("codex"),
    sandbox_requested: z.string().nullable(),
    sandbox_effective: z.string().nullable(),
    unsandboxed_reason: z.string().nullable(),
    executable: z.string().nullable(),
    cwd: z.string().nullable(),
    captured_at: z.iso.datetime(),
    started_at: z.iso.datetime().nullable(),
    startup_at: z.iso.datetime().nullable(),
    result_at: z.iso.datetime().nullable(),
    ended_at: z.iso.datetime(),
    start_ms: z.number().nullable(),
    startup_ms: z.number().nullable(),
    result_ms: z.number().nullable(),
    elapsed_ms: z.number(),
    timeout_ms: z.number().nullable(),
    timed_out: z.boolean(),
    exit_code: z.number().nullable(),
    signal: z.string().nullable(),
    outcome: z.enum([
      "success",
      "timeout",
      "failed",
      "refused",
      "unavailable",
      "invalid_output",
    ]),
    reason: z.string().min(1),
    stderr: z.string(),
  }),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-probe-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "target"));
  symlinkSync(
    resolve("tools/agx-worker/src/next/cli.ts"),
    join(root, "bin/agx-worker"),
  );
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg"),
    AGX_CODEX_HOST_FILE: join(root, "host.toml"),
    AGX_CODEX_BIN: resolve(
      "tools/agx-worker/tests/next/fixtures/probe-codex.ts",
    ),
    PROBE_CAPTURE: join(root, "capture.json"),
    PROBE_PID: join(root, "pid"),
    PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  const args = [
    "--vendor",
    "codex",
    "--sandbox",
    "workspace-write",
    "--cd",
    join(root, "target"),
    "--timeout-ms",
    "1000",
    "--json",
  ];
  const invoke = (extraEnv = {}, argv = args) => {
    const result = Bun.spawnSync(
      [process.execPath, "tools/agx/src/agx.ts", "worker", "probe", ...argv],
      { env: { ...env, ...extraEnv }, timeout: 10_000 },
    );
    expect(existsSync(env.AGX_STATE_DIR)).toBe(false);
    expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
    expect(readdirSync(join(root, "target"))).toEqual([]);
    const parsed = Schema.safeParse(result.stdout.toString());
    assert.ok(
      parsed.success,
      `${result.stdout.toString()} ${result.stderr.toString()}`,
    );
    return { result, report: parsed.data };
  };
  return { root, env, args, invoke };
}
test("umbrella probe publishes real JSON and launches only the fixed diagnostic", () => {
  const { root, env, invoke } = fixture();
  const { result, report } = invoke();
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(report.outcome).toBe("success");
  expect(report.timed_out).toBe(false);
  expect(report.sandbox_requested).toBe("workspace-write");
  expect(report.sandbox_effective).toBe("workspace-write");
  expect(report.exit_code).toBe(0);
  expect(report.start_ms).toBeNumber();
  expect(report.startup_ms).toBeNumber();
  expect(report.result_ms).toBeNumber();
  expect(report.elapsed_ms).toBeGreaterThanOrEqual(
    report.result_ms ?? Infinity,
  );
  const captured = jsonOf(
    z.object({ args: z.array(z.string()), cwd: z.string() }),
  ).safeParse(readFileSync(env.PROBE_CAPTURE, "utf8"));
  assert.ok(captured.success);
  const capture = captured.data;
  expect(capture.cwd).toBe(join(root, "target"));
  expect(capture.args.slice(0, 4)).toEqual([
    "exec",
    "--sandbox",
    "workspace-write",
    "-C",
  ]);
  expect(capture.args.at(-1)).toContain("printf 'AGX_PROBE_OK");
  expect(capture.args).not.toContain("resume");
  expect(capture.args).not.toContain("--internal-codex");
});
test("host override distinguishes requested and effective sandbox; invalid declaration never launches", () => {
  const { root, env, invoke } = fixture();
  writeFileSync(
    env.AGX_CODEX_HOST_FILE,
    'schema = 1\nunsandboxed_reason = "isolated host"\n',
  );
  const { report } = invoke();
  expect(report.outcome).toBe("success");
  expect(report.sandbox_requested).toBe("workspace-write");
  expect(report.sandbox_effective).toBe("danger-full-access");
  expect(report.unsandboxed_reason).toBe("isolated host");
  rmSync(env.PROBE_CAPTURE);
  writeFileSync(env.AGX_CODEX_HOST_FILE, "schema = 9\n");
  const refused = invoke();
  expect(refused.result.exitCode).toBe(2);
  expect(refused.report.outcome).toBe("refused");
  expect(refused.report.started_at).toBeNull();
  expect(existsSync(env.PROBE_CAPTURE)).toBe(false);
  expect(readdirSync(join(root, "target"))).toEqual([]);
});
test("timeouts before startup and after a result never succeed", () => {
  for (const mode of ["hang", "late-hang"]) {
    const { invoke } = fixture();
    const { result, report } = invoke({ PROBE_MODE: mode });
    expect(result.exitCode).toBe(1);
    expect(report.outcome).toBe("timeout");
    expect(report.timed_out).toBe(true);
    expect(report.elapsed_ms).toBeLessThan(4000);
    if (mode === "hang") expect(report.startup_at).toBeNull();
    else expect(report.result_at).not.toBeNull();
  }
});
test("vendor errors, malformed/missing diagnostics and output overflow fail", () => {
  for (const mode of ["exit", "bad", "missing-command", "flood"]) {
    const { invoke } = fixture();
    const { result, report } = invoke({ PROBE_MODE: mode });
    expect(result.exitCode).toBe(1);
    expect(report.outcome).toBe(mode === "exit" ? "failed" : "invalid_output");
    if (mode === "exit") {
      expect(report.exit_code).toBe(7);
      expect(report.stderr).toContain("vendor unavailable");
    }
  }
});
test("missing and unstartable executable are unavailable", () => {
  const { root, invoke } = fixture();
  const missing = invoke({ AGX_CODEX_BIN: join(root, "missing") });
  expect(missing.result.exitCode).toBe(2);
  expect(missing.report.outcome).toBe("unavailable");
  const bad = join(root, "bad-exec");
  writeFileSync(bad, "#!/no/such/interpreter\n");
  chmodSync(bad, 0o700);
  const refused = invoke({ AGX_CODEX_BIN: bad });
  expect(refused.result.exitCode).toBe(2);
  expect(refused.report.outcome).toBe("unavailable");
});
test("usage refuses unsupported vendor, sandbox, timeout, directory and positionals", () => {
  const { root, args, invoke } = fixture();
  for (const [flag, value] of [
    ["--vendor", "claude"],
    ["--sandbox", "danger-full-access"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "1.5"],
    ["--timeout-ms", "300001"],
    ["--cd", join(root, "absent")],
  ]) {
    const argv = [...args];
    argv[argv.indexOf(flag ?? "") + 1] = value ?? "";
    const { result, report } = invoke({}, argv);
    expect(result.exitCode).toBe(2);
    expect(report.outcome).toBe("refused");
  }
  expect(invoke({}, [...args, "ticket.md"]).result.exitCode).toBe(2);
});
test("timeout kills a fake vendor descendant holding output pipes", async () => {
  const { env, invoke } = fixture();
  const { result, report } = invoke({ PROBE_MODE: "descendant" });
  expect(result.exitCode).toBe(1);
  expect(report.outcome).toBe("timeout");
  const pid = Number(readFileSync(env.PROBE_PID, "utf8"));
  // A killed child can briefly remain a zombie until its parent is reaped.
  let dead = false;
  for (let i = 0; i < 20; i++) {
    const state = fromThrowable(() =>
      readFileSync(`/proc/${pid}/stat`, "utf8"),
    )();
    if (state.isErr() || state.value.includes(") Z ")) {
      dead = true;
      break;
    }
    await Bun.sleep(10);
  }
  expect(dead).toBe(true);
});
