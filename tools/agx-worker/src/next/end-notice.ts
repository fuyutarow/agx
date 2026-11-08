import {
  lookupAddress,
  parseProse,
} from "../../../reason-transport/src/index.ts";
import { z } from "../../../shared/src/zod.ts";
import { fromThrowable } from "neverthrow";
import { stableSelfCommand } from "../self-command.ts";
import { append, flushRunPublications, now } from "./store.ts";
import { EndNoticeResult } from "./run-state.ts";
import { VerifyRound, verifyText } from "./verify.ts";

export type EndNotice = z.output<typeof EndNoticeResult>;

const NOTICE_DEADLINE_MS = 120_000;

export const EndNoticeRequest = z.object({
  runDirSize: z
    .object({
      bytes: z.number(),
      largest: z
        .object({ name: z.string(), bytes: z.number(), directory: z.boolean() })
        .optional(),
    })
    .optional(),
  id: z.string(),
  ticket: z.string(),
  dispatcher: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: z.string(),
  exit: z.number().int().nullable().default(null),
  resultPath: z.string().nullable(),
  verifyExits: z.array(z.number()),
  verifyRound: VerifyRound.optional(),
  verifyDetails: z.string().optional(),
  parentPid: z.number().int().positive(),
  deadlineMs: z.number().int().positive().default(NOTICE_DEADLINE_MS),
});

export type EndNoticeRequest = z.output<typeof EndNoticeRequest>;

/** The whole notice process exits by deadline + this slack. */
const hardExitSlackMs = 2_000;
const pipeDrainMs = 500;
const parentWaitLimitMs = 3_000;
const receiptLimit = 4_000;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const pending: EndNotice = {
  status: "pending",
  exit: null,
  receipt: "scheduled after run completion",
};

function targetFor(input: Pick<EndNoticeRequest, "dispatcher">) {
  return input.dispatcher === null || input.dispatcher.trim() === ""
    ? null
    : input.dispatcher;
}

/** Queue the notice worker without keeping this run alive. */
export function scheduleEndNotice(
  input: Omit<EndNoticeRequest, "parentPid" | "deadlineMs"> & {
    deadlineMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Run the notice in its own transient unit so the run's unit ends with the run. */
    detachUnit?: boolean;
  },
  workerCommand: string[] = stableSelfCommand(),
): EndNotice {
  const {
    env,
    deadlineMs = NOTICE_DEADLINE_MS,
    detachUnit = false,
    ...request
  } = input;
  if (targetFor(input) === null)
    return {
      status: "skipped",
      exit: null,
      receipt: "skipped: no dispatcher session",
    };
  const noticeCommand = [
    ...workerCommand,
    "--internal-end-notice",
    JSON.stringify({ ...request, deadlineMs, parentPid: process.pid }),
  ];
  const noticeEnv = { ...process.env, ...env, AGX_RUN_ID: input.id };
  if (
    detachUnit &&
    startOutsideUnit(noticeCommand, noticeEnv, request.id, deadlineMs)
  )
    return pending;
  const spawned = fromThrowable(
    () =>
      Bun.spawn(noticeCommand, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: noticeEnv,
      }),
    (error) => error,
  )();
  if (spawned.isErr())
    return {
      status: "unreachable",
      exit: 127,
      receipt: `could not start notice worker: ${String(spawned.error).slice(0, receiptLimit)}`,
    };
  spawned.value.unref();
  return pending;
}

/**
 * Start the notice as its own transient user unit. A child left in the run's
 * unit keeps that unit active after the run ends, and `agx worker dispatch`
 * refuses the unit name until it is gone. `RuntimeMaxSec` is systemd's own
 * hard stop for the notice. Returns false when the unit could not be created,
 * so the caller falls back to a plain detached child.
 */
function startOutsideUnit(
  command: string[],
  env: NodeJS.ProcessEnv,
  id: string,
  deadlineMs: number,
): boolean {
  const systemdRun = Bun.which(
    "systemd-run",
    env.PATH === undefined ? {} : { PATH: env.PATH },
  );
  if (systemdRun === null) return false;
  const runtimeMaxSec = Math.ceil(
    (parentWaitLimitMs + deadlineMs + hardExitSlackMs) / 1_000,
  );
  const started = fromThrowable(
    () =>
      Bun.spawnSync(
        [
          systemdRun,
          "--user",
          "--quiet",
          "--collect",
          `--unit=agx-end-notice-${id}`,
          "-p",
          `RuntimeMaxSec=${runtimeMaxSec}`,
          `--working-directory=${process.cwd()}`,
          ...Object.entries(env).flatMap(([name, value]) =>
            value === undefined || !environmentName.test(name)
              ? []
              : [`--setenv=${name}=${value}`],
          ),
          "--",
          ...command,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5_000 },
      ),
    (error) => error,
  )();
  return started.isOk() && started.value.exitCode === 0;
}

async function waitForParentExit(parentPid: number): Promise<void> {
  const deadline = performance.now() + parentWaitLimitMs;
  while (performance.now() < deadline) {
    const alive = fromThrowable(
      () => process.kill(parentPid, 0),
      (error) => error,
    )();
    if (alive.isErr()) return;
    await Bun.sleep(20);
  }
}

/**
 * The environment of the `reason-network send` call is an allowlist: PATH, HOME and REASON_NETWORK_HOME (when set).
 * Reason Network decides that a process is an agent session from many variables (agent.rs:12-35 `detect_env`,
 * :98-118 `env_session_id`, :305-333 `CLAUDE_PID`/`CLAUDE_CODE_SESSION_ID`; paths.rs:19-29 legacy `TINCAN_*` spellings;
 * main.rs:792-808 `agent_vars`), and a denylist misses the ones it does not name: `CLAUDECODE` alone selects claude-code
 * and then the session comes from the ancestor registry. With any of them set, the sender is the dispatcher and Reason Network
 * leaves the sender out of the recipients (daemon/directory.rs:417-418). With none, it sends as the terminal, `cli:terminal`
 * (main.rs:466-498).
 */
const allowedVariables = ["PATH", "HOME", "REASON_NETWORK_HOME"] as const;

/** The environment for the Reason Network CLI call: only the allowlisted variables that are set. */
export function terminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    allowedVariables.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
}

export function sizeNotice(size: EndNoticeRequest["runDirSize"]): string {
  if (size === undefined || size.bytes <= 256 * 1024 * 1024) return "";
  return `\nRun directory: ${(size.bytes / 1024 / 1024).toFixed(1)} MiB; largest subdirectory: ${size.largest?.name ?? "none"}`;
}

async function sendEndNotice(
  input: EndNoticeRequest,
  env: NodeJS.ProcessEnv,
  /** performance.now() value at which the sender's own deadline falls. */
  deadlineAt: number,
): Promise<EndNotice> {
  const target = targetFor(input);
  if (target === null)
    return {
      status: "skipped",
      exit: null,
      receipt: "skipped: no dispatcher session",
    };
  const elapsedMs = Math.max(
    0,
    Temporal.Instant.from(input.endedAt)
      .since(Temporal.Instant.from(input.startedAt))
      .total("milliseconds"),
  );
  const message =
    `agx end-notice run ${input.id}\n` +
    `agx run ${input.id} ${input.ticket} ended ${input.outcome} ` +
    `exit ${input.exit ?? "none"} after ${(elapsedMs / 60_000).toFixed(1)} min; result: ${input.resultPath ?? "none"}; ` +
    `verify: ${input.verifyDetails ?? verifyText(input.verifyExits, input.verifyRound)}; ` +
    sizeNotice(input.runDirSize) +
    "\nNo reply needed; read: agx worker ls --json";
  const executable =
    env.PATH === undefined
      ? Bun.which("reason-network")
      : Bun.which("reason-network", { PATH: env.PATH });
  if (executable === null)
    return {
      status: "unreachable",
      exit: 127,
      receipt: "reason-network executable not found on PATH",
    };
  const remaining = () =>
    Math.max(1, Math.floor(deadlineAt - performance.now()));
  const expired = () => performance.now() >= deadlineAt;
  const deadline = (): EndNotice => ({
    status: "deadline",
    exit: 4,
    receipt: `notice deadline exceeded after ${input.deadlineMs} ms`,
  });
  const separator = target.indexOf(":");
  const vendor = separator < 0 ? "" : target.slice(0, separator);
  const dispatcherSession = separator < 0 ? "" : target.slice(separator + 1);
  if (expired()) return deadline();
  const address = await lookupAddress({
    binary: executable,
    vendor,
    session: dispatcherSession,
    deadlineMs: remaining(),
  });
  if (address.kind !== "accepted") {
    if (expired()) return deadline();
    if (address.kind === "refused")
      return {
        status: "unreachable",
        exit: 1,
        receipt:
          "dispatcher session is not registered with Reason Network or not live",
      };
    return {
      status: address.kind === "unknown" ? "unknown" : "unreachable",
      exit: 1,
      receipt: address.text.slice(0, receiptLimit),
    };
  }
  if (expired()) return deadline();
  return sendOnce(
    executable,
    terminalEnvironment(env),
    address.value,
    message,
    remaining,
    deadline,
  );
}

/**
 * One `reason-network send <address> <message>` with no `--from`: Reason Network attributes it to its terminal
 * sender and owns the delivery. There is no agx-owned session and no MCP process. The call is never repeated:
 * anything but exit 0 with exactly one `message id` line is `unknown`, and a deadline is `deadline`.
 */
async function sendOnce(
  executable: string,
  env: NodeJS.ProcessEnv,
  address: string,
  message: string,
  remaining: () => number,
  deadline: () => EndNotice,
): Promise<EndNotice> {
  const started = fromThrowable(
    () =>
      Bun.spawn([executable, "send", address, message], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env,
      }),
    String,
  )();
  if (started.isErr())
    return {
      status: "unknown",
      exit: 1,
      receipt: `send could not start: ${started.error}`.slice(0, receiptLimit),
    };
  const child = started.value;
  const kill = () => {
    fromThrowable(() => process.kill(-child.pid, "SIGKILL"), String)();
    child.kill("SIGKILL");
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, remaining());
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  // A helper the sender left holding its pipes ends with the sender's process group.
  kill();
  clearTimeout(timer);
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    output,
    new Promise<[string, string]>((resolve) => {
      drainTimer = setTimeout(() => {
        resolve(["", ""]);
      }, pipeDrainMs);
    }),
  ]);
  clearTimeout(drainTimer);
  if (timedOut) return deadline();
  const [out, err] = drained;
  const ids = parseProse("send", out);
  if (code === 0 && ids !== undefined)
    return {
      status: "accepted",
      exit: 0,
      receipt: `message id ${ids.join(", ")}`,
    };
  const detail = (out + err).trim();
  return {
    status: "unknown",
    exit: 1,
    receipt: (detail === "" ? `send exit ${code}` : detail).slice(
      0,
      receiptLimit,
    ),
  };
}

/** Internal detached worker: deliver only after the run process has exited. */
export async function completeEndNotice(
  input: EndNoticeRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndNotice> {
  const deadlineAt = performance.now() + input.deadlineMs;
  let recorded = false;
  // Last resort: whatever the transport does, this process ends by its deadline.
  const hard = setTimeout(() => {
    if (!recorded) {
      recorded = true;
      fromThrowable(
        () => {
          append({
            kind: "end-notice",
            id: input.id,
            at: now(),
            notice: {
              status: "deadline",
              exit: 4,
              receipt: `notice deadline exceeded after ${input.deadlineMs} ms`,
            },
          });
          return true;
        },
        (error) => error,
      )();
    }
    process.exit(4);
  }, input.deadlineMs + hardExitSlackMs);
  await waitForParentExit(input.parentPid);
  const notice = await sendEndNotice(input, env, deadlineAt);
  if (!recorded) {
    recorded = true;
    append({ kind: "end-notice", id: input.id, at: now(), notice });
  }
  await flushRunPublications();
  clearTimeout(hard);
  return notice;
}
