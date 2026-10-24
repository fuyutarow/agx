import { realpathSync, statSync } from "node:fs";
import { fromPromise, fromThrowable } from "neverthrow";
import { errorMessage } from "../../../shared/src/attempt.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import {
  codexHostDeclarationPath,
  readCodexHostDeclaration,
} from "../workers/codex-host.ts";

const Input = z.object({
  vendor: z.literal("codex"),
  sandbox: z.enum(["none", "read-only", "workspace-write"]),
  cd: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(300_000),
  json: z.literal(true),
});
const Event = jsonOf(
  z.looseObject({
    type: z.string(),
    item: z
      .looseObject({
        type: z.string(),
        status: z.string().optional(),
        exit_code: z.number().nullable().optional(),
        aggregated_output: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
  }),
);
const MARKER = "AGX_PROBE_OK";
const PROMPT = `Run exactly one shell command: printf '${MARKER}\\n'. Do not read or change files. Then reply exactly ${MARKER}.`;
const OUTPUT_LIMIT = 1024 * 1024;

type ProbeReport = {
  sandbox_requested: string | null;
  sandbox_effective: string | null;
  unsandboxed_reason: string | null;
  executable: string | null;
  cwd: string | null;
  started_at: string | null;
  startup_at: string | null;
  result_at: string | null;
  start_ms: number | null;
  startup_ms: number | null;
  result_ms: number | null;
  timeout_ms: number | null;
  exit_code: number | null;
  signal: string | null;
  schema: number;
  vendor: string;
  captured_at: string;
  ended_at: string;
  elapsed_ms: number;
  timed_out: boolean;
  outcome: string;
  reason: string;
  stderr: string;
};

/** A separate execution path: no ticket, routing, worker wrapper or store writes. */
export async function probe(
  flags: unknown,
  positionalCount: number,
): Promise<number> {
  const capturedAt = Temporal.Now.instant().toString();
  const clock = performance.now();
  const report: ProbeReport = {
    schema: 1,
    vendor: "codex",
    sandbox_requested: null,
    sandbox_effective: null,
    unsandboxed_reason: null,
    executable: null,
    cwd: null,
    captured_at: capturedAt,
    started_at: null,
    startup_at: null,
    result_at: null,
    ended_at: capturedAt,
    start_ms: null,
    startup_ms: null,
    result_ms: null,
    elapsed_ms: 0,
    timeout_ms: null,
    timed_out: false,
    exit_code: null,
    signal: null,
    outcome: "refused",
    reason: "",
    stderr: "",
  };
  const finish = (outcome: string, reason: string, exit: number) => {
    report.outcome = outcome;
    report.reason = reason;
    report.ended_at = Temporal.Now.instant().toString();
    report.elapsed_ms = performance.now() - clock;
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return exit;
  };
  const input = Input.safeParse(flags);
  if (!input.success || positionalCount !== 0)
    return finish(
      "refused",
      "use --vendor codex --sandbox MODE --cd PATH --timeout-ms N --json; no positionals",
      2,
    );
  const { sandbox, cd, timeoutMs } = input.data;
  report.sandbox_requested = sandbox;
  report.timeout_ms = timeoutMs;
  const directory = fromThrowable(() => {
    const path = realpathSync(cd);
    return statSync(path).isDirectory() ? path : undefined;
  }, errorMessage)();
  if (directory.isErr()) return finish("refused", directory.error, 2);
  if (directory.value === undefined)
    return finish("refused", "--cd must be a directory", 2);
  const cwd = directory.value;
  report.cwd = directory.value;
  const host = readCodexHostDeclaration(codexHostDeclarationPath());
  if (host.kind === "invalid") return finish("refused", host.reason, 2);
  if (host.kind === "valid")
    report.unsandboxed_reason = host.declaration.unsandboxedReason;
  const effective =
    sandbox === "none" || host.kind === "valid"
      ? "danger-full-access"
      : sandbox;
  const executable = Bun.which(process.env.AGX_CODEX_BIN ?? "codex");
  if (executable === null)
    return finish("unavailable", "Codex executable was not found", 2);
  report.executable = executable;
  const deadline = AbortSignal.timeout(timeoutMs);
  const launched = fromThrowable(
    () =>
      Bun.spawn(
        [
          executable,
          "exec",
          "--sandbox",
          effective,
          "-C",
          cwd,
          "--json",
          "--skip-git-repo-check",
          "-c",
          'approval_policy="never"',
          PROMPT,
        ],
        {
          cwd: cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
          signal: deadline,
          killSignal: "SIGKILL",
        },
      ),
    errorMessage,
  )();
  if (launched.isErr()) return finish("unavailable", launched.error, 2);
  const child = launched.value;
  report.sandbox_effective = effective;
  report.started_at = Temporal.Now.instant().toString();
  report.start_ms = performance.now() - clock;
  // Own a process group so descendants cannot retain pipes after timeout/exit.
  const cleanup = () => {
    fromThrowable(() => process.kill(-child.pid, "SIGKILL"), errorMessage)();
  };
  deadline.addEventListener("abort", cleanup, { once: true });
  let invalid = false;
  let commandOk = false;
  let replyOk = false;
  let failed = false;
  const event = (line: string) => {
    if (line.trim() === "") return;
    const parsed = Event.safeParse(line);
    if (!parsed.success) {
      invalid = true;
      return;
    }
    const { type, item } = parsed.data;
    if (type === "thread.started" && report.startup_at === null) {
      report.startup_at = Temporal.Now.instant().toString();
      report.startup_ms = performance.now() - clock;
    }
    if (
      type === "item.completed" &&
      item?.type === "command_execution" &&
      item.status === "completed" &&
      item.exit_code === 0 &&
      item.aggregated_output?.trim() === MARKER
    )
      commandOk = true;
    if (
      type === "item.completed" &&
      item?.type === "agent_message" &&
      item.text?.trim() === MARKER
    )
      replyOk = true;
    if (type === "turn.completed") {
      report.result_at = Temporal.Now.instant().toString();
      report.result_ms = performance.now() - clock;
    }
    if (type === "error" || type === "turn.failed") failed = true;
  };
  const drain = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let pending = "";
    using _reader = {
      [Symbol.dispose]: () => {
        reader.releaseLock();
      },
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > OUTPUT_LIMIT) {
        invalid = true;
        cleanup();
        break;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      if (!stdout) {
        report.stderr = (report.stderr + text).slice(0, 4096);
        continue;
      }
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        event(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    if (stdout) event(pending + decoder.decode());
  };
  const result = await fromPromise(
    Promise.all([
      drain(child.stdout, true),
      drain(child.stderr, false),
      child.exited.then((exit) => {
        cleanup();
        return exit;
      }),
    ]),
    errorMessage,
  );
  cleanup();
  deadline.removeEventListener("abort", cleanup);
  report.timed_out = deadline.aborted;
  report.exit_code = child.exitCode;
  report.signal = child.signalCode;
  if (deadline.aborted)
    return finish("timeout", "execution deadline exceeded", 1);
  if (result.isErr()) return finish("failed", result.error, 1);
  if (invalid)
    return finish("invalid_output", "malformed or excessive vendor output", 1);
  if (child.exitCode !== 0 || failed)
    return finish(
      "failed",
      "vendor exited unsuccessfully or reported an error",
      1,
    );
  if (
    report.startup_at === null ||
    report.result_at === null ||
    !commandOk ||
    !replyOk
  )
    return finish(
      "invalid_output",
      "missing startup, successful diagnostic command, reply or completed turn",
      1,
    );
  return finish("success", "fixed diagnostic completed", 0);
}
