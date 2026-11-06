import { Session, lookupAddress, type Failure } from "../../../reason-transport/src/index.ts";
import { z } from "../../../shared/src/zod.ts";
import { fromThrowable } from "neverthrow";
import { stableSelfCommand } from "../self-command.ts";
import { append, flushRunPublications, now } from "./store.ts";
import { EndNoticeResult } from "./run-state.ts";
import { VerifyRound, verifyText } from "./verify.ts";

export type EndNotice = z.output<typeof EndNoticeResult>;

const NOTICE_DEADLINE_MS = 120_000;

export const EndNoticeRequest = z.object({
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
  return input.dispatcher === null || input.dispatcher.trim() === "" ? null : input.dispatcher;
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
    `verify: ${input.verifyDetails ?? verifyText(input.verifyExits, input.verifyRound)}; ` +
    "\nNo reply needed; read: agx worker ls --json";
  const executable = env.PATH === undefined ? Bun.which("reason-network") : Bun.which("reason-network", { PATH: env.PATH });
  if (executable === null) return { status: "unreachable", exit: 127, receipt: "reason-network executable not found on PATH" };
  const remaining = () => Math.max(1, Math.floor(deadlineAt - performance.now()));
  const expired = () => performance.now() >= deadlineAt;
  const deadline = (): EndNotice => ({ status: "deadline", exit: 4, receipt: `notice deadline exceeded after ${input.deadlineMs} ms` });
  const failure = (outcome: Failure, lookup = false): EndNotice => {
    if (expired()) return deadline();
    if (lookup && outcome.kind === "refused") return { status: "unreachable", exit: 1, receipt: "dispatcher session is not registered with Reason Network or not live" };
    return { status: outcome.kind === "unknown" ? "unknown" : "unreachable", exit: 1, receipt: outcome.text.slice(0, receiptLimit) };
  };
  const separator = target.indexOf(":");
  const vendor = separator < 0 ? "" : target.slice(0, separator);
  const dispatcherSession = separator < 0 ? "" : target.slice(separator + 1);
  if (expired()) return deadline();
  const address = await lookupAddress({ binary: executable, vendor, session: dispatcherSession, deadlineMs: remaining() });
  if (address.kind !== "accepted") return failure(address, true);
  if (expired()) return deadline();
  const opened = await Session.open({ binary: executable, session: "agx-manager", deadlineMs: remaining() });
  if (opened.kind !== "accepted") return failure(opened);
  return deliverOpened(opened.value, executable, env, address.value, input.id, message, remaining, expired, deadline, failure).finally(() => { opened.value.close(); });
}

async function renameManager(executable: string, env: NodeJS.ProcessEnv, remaining: () => number): Promise<string> {
  const renamed = fromThrowable(() => Bun.spawn([executable, "status", "--name", "agx-manager"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, ...env, REASON_NETWORK_AGENT: "reason", REASON_NETWORK_SESSION: "agx-manager" },
  }), String)();
  if (renamed.isErr()) return `rename failed: ${renamed.error}`;
  const child = renamed.value;
  const kill = () => { fromThrowable(() => process.kill(-child.pid, "SIGKILL"), String)(); child.kill("SIGKILL"); };
  const timer = setTimeout(kill, remaining());
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  kill();
  clearTimeout(timer);
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([output, new Promise<[string, string]>((resolve) => { drainTimer = setTimeout(() => { resolve(["", ""]); }, pipeDrainMs); })]);
  clearTimeout(drainTimer);
  const [out, err] = drained;
  const detail = (out + err).trim();
  if (code === 0) return "";
  return `rename failed: ${detail === "" ? `exit ${code}` : detail}`;
}

async function deliverOpened(
  session: Session, executable: string, env: NodeJS.ProcessEnv, to: string, id: string,
  message: string, remaining: () => number, expired: () => boolean, deadline: () => EndNotice,
  failure: (outcome: Failure) => EndNotice,
): Promise<EndNotice> {
  if (expired()) return deadline();
  const renameReceipt = await renameManager(executable, env, remaining);
  if (expired()) {
    const result = deadline();
    return { ...result, receipt: [result.receipt, renameReceipt].filter(Boolean).join("; ").slice(0, receiptLimit) };
  }
  const sent = await session.send({ to, message, idempotencyKey: `${id}:end`, deadlineMs: remaining() });
  if (sent.kind !== "accepted") {
    const result = failure(sent);
    return { ...result, receipt: [result.receipt, renameReceipt].filter(Boolean).join("; ").slice(0, receiptLimit) };
  }
  return { status: "accepted", exit: 0, receipt: [`message id ${sent.value.join(", ")}`, renameReceipt].filter(Boolean).join("; ").slice(0, receiptLimit) };
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
