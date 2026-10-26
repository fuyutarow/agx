export type EndNotice = {
  exit: number | null;
  receipt: string;
};

const receiptLimit = 4_000;

export async function sendEndNotice(input: {
  id: string;
  ticket: string;
  dispatcher: string | null;
  startedAt: string;
  endedAt: string;
  outcome: string;
  resultPath: string | null;
  verifyExits: number[];
  env?: NodeJS.ProcessEnv;
}): Promise<EndNotice> {
  if (input.dispatcher === null || input.dispatcher.trim() === "")
    return { exit: null, receipt: "skipped: no dispatcher session" };
  const dispatcher = input.dispatcher;
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
  const path = input.env?.PATH ?? process.env.PATH;
  const executable =
    path === undefined ? Bun.which("agx") : Bun.which("agx", { PATH: path });
  if (executable === null)
    return { exit: 127, receipt: "agx executable not found on PATH" };

  return Promise.try(async () => {
    const child = Bun.spawn(
      [executable, "msg", "send", "--to", dispatcher, "--message", message],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...input.env, AGX_RUN_ID: input.id },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const stdout =
      child.stdout === null
        ? Promise.resolve("")
        : new Response(child.stdout).text();
    const stderr =
      child.stderr === null
        ? Promise.resolve("")
        : new Response(child.stderr).text();
    const processExit = await child.exited;
    const output = `${await stdout}${await stderr}`.trim();
    return {
      exit: child.exitCode ?? (child.signalCode === null ? processExit : 128),
      receipt:
        output === ""
          ? `agx msg send exited ${processExit}`
          : output.slice(-receiptLimit),
    };
  }).then(
    (notice) => notice,
    (error: unknown) => ({
      exit: 1,
      receipt: `agx msg send failed: ${String(error).slice(0, receiptLimit)}`,
    }),
  );
}
