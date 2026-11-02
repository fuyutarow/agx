import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { decodedJson } from "./decode.ts";
import { prepareTicketRepo } from "./ticket-repo.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const Receipt = z.looseObject({
  outcome: z.string(),
  report_path: z.string(),
  id: z.string(),
});
const Result = z.looseObject({
  cmd: z.string(),
  exit: z.number(),
  kind: z.string(),
  log_path: z.string(),
});
const Report = z.looseObject({ verify_rounds: z.array(z.array(Result)) });

async function exercise(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "agx-feedback-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const worker = join(root, "worker.ts");
  await writeFile(
    worker,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const resume = args.includes("--resume");
const runDir = process.env.AGX_RUN_DIR;
appendFileSync(runDir + "/calls.jsonl", JSON.stringify({args, prompt: readFileSync(runDir + "/brief.md", "utf8")}) + "\\n");
writeFileSync("changed.txt", "changed");
if (["pass", "long"].includes(process.env.FEEDBACK_MODE) || (process.env.FEEDBACK_MODE === "fix" && resume)) writeFileSync("fixed", "yes");
process.stdout.write(JSON.stringify({report: {summary: "done", changes: [], checks: [], for_coordinator: [], open: []}, vendor_session: "test-session", ...(process.env.FEEDBACK_MODE === "refused-outcome" ? {outcome: "refused"} : {}), ...(process.env.FEEDBACK_MODE === "capacity-refused" ? {outcome: "capacity"} : {}), ...(process.env.FEEDBACK_MODE === "refused-receipt" ? {exit_code: 1} : {})}) + "\\n");
if (process.env.FEEDBACK_MODE === "refused-exit") process.exitCode = 1;
if (process.env.FEEDBACK_MODE === "capacity-refused") process.exitCode = 75;
`,
  );
  const ticket = join(root, "ticket.md");
  const command = mode === "long" ? "sleep 3; test -f fixed" : "test -f fixed";
  const preload = join(root, "deadline-preload.ts");
  await writeFile(
    preload,
    `import { writeFileSync } from "node:fs";
const original = AbortSignal.timeout;
AbortSignal.timeout = (ms) => {
  const signal = original(ms === 60000 ? 2000 : ms);
  if (ms === 60000) signal.addEventListener("abort", () => writeFileSync(process.env.FEEDBACK_DEADLINE_MARKER, "expired"));
  return signal;
};
`,
  );
  await writeFile(
    ticket,
    `+++\nschema = 2\nname = "feedback"\ntimeout_s = 60\nwrites = ["changed.txt", "fixed"]\ncapabilities = ["long-tool-loop"]\noutcome = "test feedback"\nverify = [${JSON.stringify(command)}]\n[proposition]\nid = "FEEDBACK"\nclaim = "resume after verify"\nrefuted_by = "no feedback"\n+++\nWork.\n`,
  );
  let routeCalls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      routeCalls += 1;
      return Response.json({
        answers: {
          worker:
            mode === "capacity-refused" && routeCalls > 1
              ? { choice: "contradiction", reason_code: "fixture refusal" }
              : { choice: "sol-medium", probabilities: { "sol-medium": 1 } },
        },
      });
    },
  });
  await using _server = {
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
    },
  };
  const child = Bun.spawn(
    [
      process.execPath,
      ...(mode === "long" ? ["--preload", preload] : []),
      "tools/agx-worker/src/next/cli.ts",
      "run",
      ticket,
      "--cd",
      root,
      "--sandbox",
      "none",
    ],
    {
      env: {
        ...subprocessEnvironment(),
        HOME: root,
        AGX_STATE_DIR: join(root, "state"),
        AGX_TMP_ROOT: join(root, "tmp"),
        AGX_CONFIG: new URL(
          "../src/roster/policy.example.toml",
          import.meta.url,
        ).pathname,
        JEV_URL: `http://127.0.0.1:${server.port}/`,
        TYPESAFE_API_KEY: "test-key",
        AGX_WORKER_BIN: worker,
        FEEDBACK_MODE: mode,
        FEEDBACK_DEADLINE_MARKER: join(root, "deadline-expired"),
        AGX_DISPATCHER_SESSION: "test-dispatcher",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let expectedExit = 0;
  if (mode === "refused-exit") expectedExit = 1;
  if (mode === "capacity-refused") expectedExit = 2;
  expect(exit, stderr).toBe(expectedExit);
  const receipt = decodedJson(Receipt, stdout);
  const report = decodedJson(
    Report,
    await readFile(receipt.report_path, "utf8"),
  );
  const calls = (
    await readFile(
      join(root, "state", "runs", receipt.id, "calls.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) =>
      decodedJson(
        z.object({ args: z.array(z.string()), prompt: z.string() }),
        line,
      ),
    );
  const records = (await readFile(join(root, "state", "records.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) =>
      decodedJson(
        z.looseObject({
          kind: z.string(),
          id: z.string().optional(),
          verify: z.array(Result).optional(),
        }),
        line,
      ),
    );
  const ended = records.findLast(
    (record) => record.kind === "ended" && record.id === receipt.id,
  );
  if (mode === "long")
    expect(await readFile(join(root, "deadline-expired"), "utf8")).toBe(
      "expired",
    );
  const runFiles = await readdir(join(root, "state", "runs", receipt.id));
  return { receipt, report, calls, command, ended, routeCalls, runFiles };
}

test("failed verification feeds the same session and succeeds", async () => {
  const { receipt, report, calls, command } = await exercise("fix");
  expect(receipt.outcome).toBe("ok");
  expect(report.verify_rounds).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.args).toContain("--resume");
  expect(calls[1]?.args).toContain("test-session");
  expect(calls[1]?.prompt).toContain(command);
  expect(calls[1]?.prompt).toContain(
    report.verify_rounds[0]?.[0]?.log_path ?? "missing",
  );
});

test("persistent failures stop after two feedback rounds and retain both logs", async () => {
  const { receipt, report, calls } = await exercise("fail");
  expect(receipt.outcome).toBe("verify-failed");
  expect(calls).toHaveLength(3);
  expect(report.verify_rounds).toHaveLength(2);
  const paths = report.verify_rounds.map((round) => round[0]?.log_path);
  expect(new Set(paths).size).toBe(2);
  for (const round of report.verify_rounds) {
    expect(round[0]).toMatchObject({ exit: 1, kind: "failed" });
    expect(await readFile(round[0]?.log_path ?? "missing", "utf8")).toBe("");
  }
});

test("passing verification does not resume", async () => {
  const { receipt, report, calls } = await exercise("pass");
  expect(receipt.outcome).toBe("ok");
  expect(calls).toHaveLength(1);
  expect(report.verify_rounds).toHaveLength(0);
});

test.each(["refused-exit", "refused-outcome", "refused-receipt"])(
  "%s runs verify without feedback",
  async (mode) => {
    const { receipt, report, calls, ended } = await exercise(mode);
    expect(receipt.outcome).toBe("refused");
    expect(calls).toHaveLength(1);
    expect(report.verify_rounds).toHaveLength(0);
    expect(ended?.verify).toMatchObject([{ exit: 1, kind: "failed" }]);
  },
);

test("first verify completes after the deadline", async () => {
  const { receipt, report, calls, ended } = await exercise("long");
  expect(receipt.outcome).toBe("ok");
  expect(calls).toHaveLength(1);
  expect(report.verify_rounds).toHaveLength(0);
  expect(ended?.verify).toMatchObject([{ exit: 0, kind: "passed" }]);
}, 15000);

test("refused capacity reroute does not verify or resume", async () => {
  const { receipt, report, calls, ended, routeCalls, runFiles } =
    await exercise("capacity-refused");
  expect(routeCalls).toBe(2);
  expect(receipt.outcome).toBe("refused");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).not.toContain("--resume");
  expect(report.verify_rounds).toHaveLength(0);
  expect(ended?.verify).toEqual([]);
  expect(runFiles.filter((name) => /^verify-.*\.log$/u.test(name))).toEqual([]);
});
