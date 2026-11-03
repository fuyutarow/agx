import { z } from "../../../shared/src/zod.ts";
import { fromThrowable } from "neverthrow";
import { stableSelfCommand } from "../self-command.ts";
import { append, flushRunPublications, now } from "./store.ts";
import { EndNoticeResult } from "./run-state.ts";
import { VerifyRound, verifyText } from "./verify.ts";

export type EndNotice = z.output<typeof EndNoticeResult>;

/**
 * Budget for one `agx msg send` relay to a live Claude dispatcher.
 *
 * The relay is a one-shot `claude --print` model turn (inventory lookup, one
 * SendMessage tool call, receipt check), so acceptance takes seconds to tens of
 * seconds, never ~1 s. The old 1_200 ms budget ended every claude-route notice
 * as `deadline` (1363 recorded `deadline` end-notices, 0 accepted; dotfiles run
 * ffa7ab52: "acceptance unknown (timed out after 1195 ms)").
 *
 * Measurement: this sandbox cannot send to a live Claude session (Claude to
 * Claude is refused, only the completion ACK is authorized), so no acceptance
 * time was measured here; see result.md. 120 s is twice the `agx msg send`
 * default (60 s) and leaves a wide margin over a model turn. The notice worker
 * is detached from the run, so waiting costs the run nothing.
 */
const NOTICE_DEADLINE_MS = 120_000;

export const EndNoticeRequest = z.object({
  id: z.string(),
  ticket: z.string(),
  dispatcher: z.string().nullable(),
  address: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: z.string(),
  exit: z.number().int().nullable().default(null),
  resultPath: z.string().nullable(),
  verifyExits: z.array(z.number()),
  verifyRound: VerifyRound.optional(),
  parentPid: z.number().int().positive(),
  deadlineMs: z.number().int().positive().default(NOTICE_DEADLINE_MS),
});

export type EndNoticeRequest = z.output<typeof EndNoticeRequest>;

/** Kill the sender only after its own deadline has had time to report. */
const noticeGuardSlackMs = 1_000;
/** The whole notice process exits by deadline + this, whatever its transport does. */
const hardExitSlackMs = 2_000;
/** After the sender ended or was killed, wait this long for its pipes to drain. */
const pipeDrainMs = 500;
const parentWaitLimitMs = 3_000;
const receiptLimit = 4_000;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const pending: EndNotice = {
  status: "pending",
  exit: null,
  receipt: "scheduled after run completion",
};

function targetFor(input: Pick<EndNoticeRequest, "dispatcher" | "address">) {
  const target = input.address ?? input.dispatcher;
  return target === null || target.trim() === "" ? null : target;
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

/** Resolve with `fallback` if `work` does not settle within `ms`. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
  });
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
    `agx run ${input.id} ${input.ticket} ended ${input.outcome} ` +
    `exit ${input.exit ?? "none"} after ${(elapsedMs / 60_000).toFixed(1)} min; result: ${input.resultPath ?? "none"}; ` +
    `verify: ${verifyText(input.verifyExits, input.verifyRound)}; ` +
    "read: agx worker ls --json";
  const path = env.PATH;
  const executable =
    path === undefined ? Bun.which("agx") : Bun.which("agx", { PATH: path });
  if (executable === null)
    return {
      status: "unreachable",
      exit: 127,
      receipt: "agx executable not found on PATH",
    };

  const remainingMs = Math.max(1, Math.floor(deadlineAt - performance.now()));
  const spawned = fromThrowable(
    () =>
      Bun.spawn(
        [
          executable,
          "msg",
          "send",
          "--to",
          target,
          ...(input.address === null ? [] : ["--exact"]),
          "--from",
          `agx-manager:${input.id}`,
          "--message",
          message,
          "--timeout-ms",
          String(remainingMs),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          // Own process group: the sender's helpers (a relay model turn, its
          // tools) are killed with it instead of holding our pipes open.
          detached: true,
          env: { ...process.env, ...env, AGX_RUN_ID: input.id },
        },
      ),
    (error) => error,
  )();
  if (spawned.isErr())
    return {
      status: "unreachable",
      exit: 1,
      receipt: `agx msg send failed: ${String(spawned.error).slice(0, receiptLimit)}`,
    };
  const child = spawned.value;
  const killGroup = () => {
    fromThrowable(
      () => process.kill(-child.pid, "SIGKILL"),
      (error) => error,
    )();
    fromThrowable(
      () => {
        child.kill("SIGKILL");
        return true;
      },
      (error) => error,
    )();
  };
  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, remainingMs + noticeGuardSlackMs);
  const stdout =
    child.stdout === null
      ? Promise.resolve("")
      : new Response(child.stdout).text();
  const stderr =
    child.stderr === null
      ? Promise.resolve("")
      : new Response(child.stderr).text();
  const exit = await child.exited;
  clearTimeout(guard);
  killGroup();
  const [out, err] = await Promise.all([
    within(stdout, pipeDrainMs, ""),
    within(stderr, pipeDrainMs, ""),
  ]);
  const output = `${out}${err}`.trim().slice(-receiptLimit);
  if (timedOut || exit === 4)
    return {
      status: "deadline",
      exit: 4,
      receipt:
        output !== ""
          ? output
          : `notice deadline exceeded after ${input.deadlineMs} ms`,
    };
  if (exit === 0)
    return {
      status: "accepted",
      exit,
      receipt: output !== "" ? output : "agx msg send accepted",
    };
  return {
    status: "unreachable",
    exit,
    receipt: output !== "" ? output : `agx msg send exited ${exit}`,
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
