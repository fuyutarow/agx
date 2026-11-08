// A run whose worker ends without a final message (killed at the time box) gets a manager-written
// report from what the manager observed; a worker's own report keeps precedence.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { loadRoster } from "../src/roster/index.ts";
import { decodedJson } from "./decode.ts";
import { prepareTicketRepo } from "./ticket-repo.ts";
import { startFakeJev } from "./fake-jev.ts";

// Routed runs call Jev; the loopback fake keeps them hermetic.
const jev = startFakeJev();
afterAll(() => jev.stop());
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const Receipt = z.looseObject({ outcome: z.string(), report_path: z.string() });

/** A fake worker: writes a file, emits one progress record, then either hangs or reports. */
const WORKER = `import { writeFileSync } from "node:fs";
writeFileSync("out.txt", "work in progress\\n");
writeFileSync(
  process.env.AGX_CODEX_PROGRESS_FILE ?? "",
  JSON.stringify({ schema: 1, at: "2026-11-03T00:00:00Z", last: "$ bun test fake", commands: 3, turns: 4, files: 1 }),
);
if (process.env.AGX_FAKE_MODE === "report") {
  const report = { summary: "worker's own report", changes: [], checks: [], for_coordinator: [], open: [] };
  process.stdout.write(JSON.stringify({ report }) + "\\n");
} else if (process.env.AGX_FAKE_MODE === "kill") {
  process.kill(process.pid, "SIGKILL");
} else {
  await Bun.sleep(120_000);
}
`;

const dispatch = async (mode: "hang" | "kill" | "report") => {
  const root = await mkdtemp(
    join(tmpdir(), `agx-test-${process.pid}-timeout-report-`),
  );
  roots.push(root);
  await prepareTicketRepo(root);
  const worker = join(root, "fake-timeout-worker.ts");
  await writeFile(worker, WORKER);
  const ticket = join(root, "timeout-report.md");
  await writeFile(
    ticket,
    '+++\nschema = 2\nname = "timeout-report"\ntimeout_s = 60\nwrites = ["out.txt"]\noutcome = "test manager report"\nverify = ["true"]\n[proposition]\nid = "TIMEOUT-REPORT"\nclaim = "a timed-out run has a report"\nrefuted_by = "empty report"\n+++\nWork.\n',
  );
  const policyExample = new URL(
    "../src/roster/policy.example.toml",
    import.meta.url,
  ).pathname;
  const loaded = await loadRoster({ policyPath: policyExample });
  if (!loaded.ok) expect.unreachable(loaded.error);
  // A 60 s box refuses rows whose published duration exceeds 60% of it (sol-medium: 231 s), so the
  // fixture keeps the one codex row that fits (luna-low: 28 s) and the fake Jev answers with a class.
  // The ticket declares no capability: long-tool-loop would demand TB4 >= 30, which no codex row under 36 s meets.
  const excluded = loaded.value.choice
    .filter((row) => row.id !== "luna-low")
    .map((row) => row.id);
  const policyPath = join(root, "policy.toml");
  await writeFile(
    policyPath,
    (await readFile(policyExample, "utf8"))
      .replace('default = "luna-high"', 'default = "luna-low"')
      .replace("exclude = []", `exclude = ${JSON.stringify(excluded)}`),
  );
  const child = Bun.spawn(
    [
      process.execPath,
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
        AGX_STATE_DIR: join(root, "state"),
        JEV_URL: jev.url,
        TYPESAFE_API_KEY: "test-key",
        AGX_WORKER_BIN: worker,
        AGX_FAKE_MODE: mode,
        XDG_STATE_HOME: join(root, "tmp"),
        AGX_CONFIG: policyPath,
        AGX_DISPATCHER_SESSION: "test-dispatcher",
        HOME: root,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stdout.trim(), `exit ${exit}: ${stderr}`).not.toBe("");
  const receipt = decodedJson(Receipt, stdout.trim().split("\n").at(-1) ?? "");
  const report = decodedJson(
    z.looseObject({}),
    await readFile(receipt.report_path, "utf8"),
  );
  return { exit, stderr, receipt, report };
};

test.each(["hang", "kill"] as const)(
  "a worker that %s leaves a manager-written report",
  async (mode) => {
    const run = await dispatch(mode);
    if (mode === "hang")
      expect(run.receipt.outcome, run.stderr).toBe("timeout");
    const report = decodedJson(
      z.looseObject({
        source: z.string(),
        summary: z.string(),
        changes: z.array(z.object({ path: z.string(), what: z.string() })),
        checks: z.array(z.looseObject({ cmd: z.string(), exit: z.unknown() })),
        observed: z.looseObject({
          worker_error: z.string(),
          last_progress: z.looseObject({
            last: z.string(),
            commands: z.number(),
          }),
        }),
      }),
      JSON.stringify(run.report),
    );
    expect(report.source).toBe("manager");
    expect(report.summary).toContain("manager-written");
    expect(report.changes.map((c) => c.path)).toContain("out.txt");
    expect(report.summary).toContain("$ bun test fake");
    expect(report.observed.last_progress).toMatchObject({
      last: "$ bun test fake",
      commands: 3,
    });
    expect(report.observed.worker_error).toBe(
      "the worker's final message is empty",
    );
    expect(report.checks.map((c) => c.cmd)).toContain("true");
  },
  120_000,
);

test("a worker's own final report is left as it wrote it", async () => {
  const run = await dispatch("report");
  expect(run.report).toMatchObject({ summary: "worker's own report" });
  expect(run.report).not.toHaveProperty("source");
}, 100_000);
