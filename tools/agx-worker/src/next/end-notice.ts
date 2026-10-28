import { z } from "../../../shared/src/zod.ts";
import { fromThrowable } from "neverthrow";
import { selfCommand } from "../self-command.ts";
import { append, flushRunPublications, now } from "./store.ts";
import { EndNoticeResult } from "./run-state.ts";

export type EndNotice = z.output<typeof EndNoticeResult>;

export const EndNoticeRequest = z.object({
  id: z.string(),
  ticket: z.string(),
  dispatcher: z.string().nullable(),
  address: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: z.string(),
  resultPath: z.string().nullable(),
  verifyExits: z.array(z.number()),
  parentPid: z.number().int().positive(),
});

export type EndNoticeRequest = z.output<typeof EndNoticeRequest>;

const noticeDeadlineMs = 1_200;
const noticeGuardMs = 1_600;
const parentWaitLimitMs = 3_000;
const receiptLimit = 4_000;

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
  input: Omit<EndNoticeRequest, "parentPid"> & { env?: NodeJS.ProcessEnv },
  workerCommand: string[] = selfCommand(),
): EndNotice {
  const { env, ...request } = input;
  if (targetFor(input) === null)
    return {
      status: "skipped",
      exit: null,
      receipt: "skipped: no dispatcher session",
    };
  const spawned = fromThrowable(
    () =>
      Bun.spawn(
        [
          ...workerCommand,
          "--internal-end-notice",
          JSON.stringify({ ...request, parentPid: process.pid }),
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
          env: {
            ...process.env,
            ...env,
            AGX_RUN_ID: input.id,
          },
        },
      ),
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
    `agx run ${input.id.slice(0, 8)} ${input.ticket} ended ${input.outcome} ` +
    `after ${(elapsedMs / 60_000).toFixed(1)} min; result: ${input.resultPath ?? "none"}; ` +
    `verify: ${input.verifyExits.length === 0 ? "not run" : input.verifyExits.join(",")}`;
  const path = env.PATH;
  const executable =
    path === undefined ? Bun.which("agx") : Bun.which("agx", { PATH: path });
  if (executable === null)
    return {
      status: "unreachable",
      exit: 127,
      receipt: "agx executable not found on PATH",
    };

  const signal = AbortSignal.timeout(noticeGuardMs);
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
          "--message",
          message,
          "--timeout-ms",
          String(noticeDeadlineMs),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...env, AGX_RUN_ID: input.id },
          signal,
          killSignal: "SIGKILL",
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
  {
    const child = spawned.value;
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout === null
        ? Promise.resolve("")
        : new Response(child.stdout).text(),
      child.stderr === null
        ? Promise.resolve("")
        : new Response(child.stderr).text(),
    ]);
    const output = `${stdout}${stderr}`.trim().slice(-receiptLimit);
    if (signal.aborted || exit === 4)
      return {
        status: "deadline",
        exit: exit === 4 ? exit : 4,
        receipt:
          output !== ""
            ? output
            : `notice deadline exceeded after ${noticeDeadlineMs} ms`,
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
}

/** Internal detached worker: deliver only after the run process has exited. */
export async function completeEndNotice(
  input: EndNoticeRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndNotice> {
  await waitForParentExit(input.parentPid);
  const notice = await sendEndNotice(input, env);
  append({ kind: "end-notice", id: input.id, at: now(), notice });
  await flushRunPublications();
  return notice;
}
