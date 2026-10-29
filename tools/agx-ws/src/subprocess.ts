// Child completion and pipe EOF are different events: descendants can retain the pipes.
import { attempt, type Attempt } from "../../shared/src/attempt.ts";
import { enterStep, watchChild } from "./deadline.ts";
import { timing } from "./timing.ts";
import { requireJjTemplateVersion } from "../../shared/src/jj-version.ts";

export class StepFailure extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export const STEP_TIMEOUT_MS = timing.stepTimeoutMs;
type StepResult = { code: number; out: Buffer; err: string };

export async function runStep(
  cmd: string[],
  cwd: string,
  options: {
    env?: Record<string, string> | undefined;
    output?: "capture" | "inherit" | "json";
    timeoutMs?: number;
    input?: string;
  } = {},
): Promise<Attempt<StepResult>> {
  requireJjTemplateVersion(cmd, { ...process.env, ...options.env });
  const spawned = await attempt(() => {
    const timeoutMs = options.timeoutMs ?? STEP_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const capture = (options.output ?? "capture") === "capture";
    const child = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, ...options.env },
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal,
      killSignal: "SIGKILL",
    });
    return { child, signal, timeoutMs, capture };
  });
  if (!spawned.ok) return spawned;
  const { child, signal, timeoutMs, capture } = spawned.value;
  const leaveStep = enterStep(cmd.join(" "));
  const unwatch = watchChild(() => {
    child.kill("SIGKILL");
  });
  const deadline = Promise.withResolvers<never>();
  let waitingFor = "child.exited";
  const expired = (): void => {
    deadline.reject(
      new StepFailure(
        `${cmd.join(" ")}: deadline exceeded after ${timeoutMs}ms waiting for ${waitingFor}`,
        124,
      ),
    );
  };
  signal.addEventListener("abort", expired, { once: true });
  if (signal.aborted) expired();
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const chunks: Buffer[][] = [[], []];
  const drains = Promise.all(
    readers.map(async (reader, index) => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        if (capture) chunks[index]?.push(Buffer.from(next.value));
        else if (index === 0 && options.output !== "json")
          process.stdout.write(next.value);
        else process.stderr.write(next.value);
      }
    }),
  );
  if (
    options.input !== undefined &&
    child.stdin !== null &&
    child.stdin !== undefined
  ) {
    const stdin = child.stdin;
    const input = options.input;
    void (async () => {
      await stdin.write(input);
      await stdin.end();
    })().catch(() => {});
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await attempt(async () => {
    const code = await Promise.race([child.exited, deadline.promise]);
    waitingFor = "stdout/stderr drain";
    // Native process timeouts stop at exit; descendants may still hold pipes open.
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timing.drainGraceMs);
    });
    await Promise.race([drains, grace, deadline.promise]);
    return {
      code,
      out: Buffer.concat(chunks[0] ?? []),
      err: Buffer.concat(chunks[1] ?? []).toString(),
    };
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", expired);
  // Never await cleanup on the same possibly stuck handle that caused the deadline.
  for (const reader of readers) void reader?.cancel().catch(() => {});
  void drains.catch(() => {});
  if (!result.ok) child.kill("SIGKILL");
  child.unref();
  unwatch();
  leaveStep();
  if (signal.aborted)
    return {
      ok: false,
      error: new StepFailure(
        `${cmd.join(" ")}: deadline exceeded after ${timeoutMs}ms waiting for ${waitingFor}`,
        124,
      ),
    };
  return result;
}
