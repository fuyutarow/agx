import { attempt } from "../../shared/src/attempt.ts";
import { cli as cleyeCli } from "cleye";
import { standardCli } from "../../shared/src/cli.ts";
import { DoctorRecord, WorkspaceDoctorSummary } from "../../shared/src/doctor-record.ts";
import { doctorTools } from "../../shared/src/doctor-aggregate.ts";
import { resolveSuiteTool } from "../../shared/src/path-dispatch.ts";
import { checkState } from "../../shared/src/state-dir.ts";
import { jsonOf } from "../../shared/src/zod.ts";
import pkg from "../package.json" with { type: "json" };

import { refreshDoctor, type DoctorAggregate } from "./refresh.ts";

const outputLimit = 1024 * 1024;

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  overflow: () => void,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  using _cleanup = {
    [Symbol.dispose]: () => {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    },
  };
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes <= outputLimit) chunks.push(next.value);
    else overflow();
  }
  return await new Response(new Blob(chunks)).text();
}

async function collect(tool: (typeof doctorTools)[number], timeout: number) {
  const findings: DoctorRecord[] = [];
  const workspaces: WorkspaceDoctorSummary[] = [];
  let exit: number | null = null;
  let complete = true;
  let timedOut = false;
  let signalCode: string | null = null;
  const collected = await attempt(async () => {
    const signal = AbortSignal.timeout(timeout);
    const child = Bun.spawn(
      [await resolveSuiteTool(tool), "doctor", "--quiet"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal,
        killSignal: "SIGKILL",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      readBounded(
        child.stdout,
        () => {
          complete = false;
          child.kill("SIGKILL");
        },
        signal,
      ),
      readBounded(
        child.stderr,
        () => {
          complete = false;
          child.kill("SIGKILL");
        },
        signal,
      ),
      child.exited,
    ]);
    exit = code;
    timedOut = signal.aborted;
    signalCode = child.signalCode;
    if (stderr !== "") process.stderr.write(`${tool}: ${stderr}`);
    if (timedOut) complete = false;
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      const summary = jsonOf(WorkspaceDoctorSummary).safeParse(line);
      if (summary.success && tool === "agx-ws") { workspaces.push(summary.data); continue; }
      const parsed = jsonOf(DoctorRecord).safeParse(line);
      if (!parsed.success || parsed.data.tool !== tool) {
        complete = false;
        continue;
      }
      findings.push(parsed.data);
    }
    if (
      (exit !== 0 && exit !== 1) ||
      (exit === 0 && findings.length > 0) ||
      (exit === 1 && findings.length === 0)
    )
      complete = false;
  });
  if (!collected.ok) {
    complete = false;
    process.stderr.write(`${tool}: ${String(collected.error)}\n`);
  }
  if (!complete)
    process.stderr.write(
      timedOut
        ? `agx doctor: ${tool} exceeded ${timeout} ms (signal ${signalCode}, exit ${exit}); collection incomplete\n`
        : `agx doctor: ${tool} collection incomplete (exit ${exit})\n`,
    );
  return {
    findings,
    workspaces,
    member: {
      tool,
      exit,
      complete,
      timed_out: timedOut,
      deadline_ms: timeout,
      signal: signalCode,
    },
  };
}

export async function doctor(argv: string[]): Promise<void> {
  const cli = standardCli(cleyeCli, pkg, () => argv);
  const args = cli({
    name: "agx doctor",
    parameters: [],
    strictFlags: true,
    ignoreArgv: (type, flag) => {
      if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
    },
    flags: {
      json: {
        type: Boolean,
        description: "Emit one aggregate JSON object (refreshes state)",
      },
      refresh: {
        type: Boolean,
        description: "Explicitly request the default bounded refresh",
      },
      deadlineMs: {
        type: Number,
        default: 125000,
        description:
          "Whole request deadline including queue wait (1..125000 ms)",
      },
      timeoutMs: {
        type: Number,
        default: 60000,
        description:
          "Per-member deadline in milliseconds (1..60000; default 60000)",
      },
    },
    help: {
      description:
        "Refresh and atomically publish worker, ws and ticket doctor findings.",
    },
  });
  if (
    args._.length > 0 ||
    !Number.isInteger(args.flags.deadlineMs) ||
    args.flags.deadlineMs < 1 ||
    args.flags.deadlineMs > 125000 ||
    !Number.isInteger(args.flags.timeoutMs) ||
    args.flags.timeoutMs < 1 ||
    args.flags.timeoutMs > 60000
  ) {
    process.stderr.write(
      "agx doctor: no operands; --timeout-ms must be an integer in 1..60000; --deadline-ms in 1..125000\n",
    );
    process.exitCode = 2;
    return;
  }
  await checkState();
  const response = await refreshDoctor(
    collectAggregate,
    args.flags.timeoutMs,
    args.flags.deadlineMs,
  );
  if (response.error !== null)
    process.stderr.write(`agx doctor: ${response.error}\n`);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode =
    response.error === null && response.complete
      ? Number(response.total > 0)
      : 2;
}

async function collectAggregate(timeout: number): Promise<DoctorAggregate> {
  const results = await Promise.all(
    doctorTools.map((tool) => collect(tool, timeout)),
  );
  const findings = results.flatMap((result) => result.findings);
  const kinds = Object.fromEntries(
    [...new Set(findings.map((row) => row.finding))].map((kind) => [
      kind,
      findings.filter((row) => row.finding === kind).length,
    ]),
  );
  const aggregate: DoctorAggregate = {
    schema: 1,
    findings,
    workspaces: results.flatMap((result) => result.workspaces),
    kinds,
    total: findings.length,
    lost: kinds.lost ?? 0,
    complete: results.every((result) => result.member.complete),
    captured_at: Temporal.Now.instant().epochMilliseconds,
    members: results.map((result) => result.member),
  };
  return aggregate;
}
