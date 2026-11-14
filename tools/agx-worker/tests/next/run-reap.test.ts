import { jsonOf, z } from "../../../shared/src/zod.ts";
import { ReapResult } from "../../src/next/reap.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapRun } from "../../src/next/reap.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.if(process.platform === "linux")(
  "reaps an escaped marked process without signalling an unmarked process",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agx-reap-test-"));
    roots.push(root);
    const runDir = join(root, "run");
    const marked = Bun.spawn(["setsid", "sleep", "60"], {
      env: { ...subprocessEnvironment(), AGX_RUN_DIR: runDir },
      stdout: "ignore",
      stderr: "ignore",
    });
    const unmarked = Bun.spawn(["sleep", "60"], {
      env: { ...subprocessEnvironment(), AGX_RUN_DIR: `${runDir}-different` },
      stdout: "ignore",
      stderr: "ignore",
    });
    children.push(marked, unmarked);
    await Bun.sleep(100);
    const result = await reapRun(runDir);
    expect(result.reaped.count).toBe(1);
    expect(result.reaped.processes).toEqual([
      { pid: marked.pid, argv0: "sleep" },
    ]);
    expect(result.survivors).toEqual([]);
    expect(result.reap_status).toBe("complete");
    expect(await marked.exited).not.toBe(0);
    expect(unmarked.exitCode).toBeNull();
    expect(await reapRun(runDir)).toEqual({
      reaped: { count: 0, processes: [] },
      survivors: [],
      reap_status: "complete",
    });
  },
);

test.if(process.platform === "linux")(
  "timeout reaps a setsid worker child and persists the result and notice",
  async () => {
    const { mkdir, chmod, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { prepareTicketRepo } = await import("../ticket-repo.ts");
    const root = await mkdtemp(join(tmpdir(), "agx-reap-run-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    const home = join(root, "reason");
    await mkdir(workspace);
    await mkdir(home);
    await prepareTicketRepo(workspace);
    const log = join(root, "notice.jsonl");
    await Bun.write(
      join(home, "fake.json"),
      JSON.stringify({ log, mode: "ok" }),
    );
    const binary = join(root, "reason-network");
    await Bun.write(
      binary,
      `#!${process.execPath}\nimport ${JSON.stringify(resolve("tools/agx-worker/tests/fixtures/reason-notice.ts"))};\n`,
    );
    await chmod(binary, 0o755);
    const worker = join(root, "worker.ts");
    await Bun.write(
      worker,
      `const child = Bun.spawn(["setsid", "sleep", "120"], { stdout: "ignore", stderr: "ignore" }); await Bun.write(process.env.AGX_RUN_DIR + "/child.pid", String(child.pid)); await Bun.sleep(120000);\n`,
    );
    const ticket = join(workspace, "ticket.md");
    await Bun.write(
      ticket,
      '+++\nschema = 2\ntimeout_s = 60\nname = "reap"\nwrites = ["work.txt"]\noutcome = "fixture"\nverify = ["true"]\n[proposition]\nid = "REAP"\nclaim = "reap"\nrefuted_by = "child alive"\n+++\nFixture.\n',
    );
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ answers: { worker: { choice: "mechanical" } } }),
    });
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        await server.stop(true);
      },
    };
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "run",
        ticket,
        "--cd",
        workspace,
        "--session",
        "codex:reap-test",
      ],
      {
        env: {
          ...subprocessEnvironment(),
          AGX_STATE_DIR: state,
          XDG_STATE_HOME: join(root, "xdg"),
          AGX_CODEX_HOST_FILE: join(root, "absent"),
          JEV_URL: `http://127.0.0.1:${server.port}/choice`,
          AGX_WORKER_BIN: worker,
          TYPESAFE_API_KEY: "test-key",
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
          PATH: `${root}:${process.env.PATH ?? ""}`,
          REASON_NETWORK_HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 75000,
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).toBe(143);
    const records = (await readFile(join(state, "records.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .flatMap((line) => {
        const row = jsonOf(
          z.looseObject({
            kind: z.string(),
            id: z.string(),
            outcome: z.string().optional(),
            reaped: ReapResult.shape.reaped.optional(),
          }),
        ).safeParse(line);
        return row.success ? [row.data] : [];
      });
    const ended = records.findLast((row) => row.kind === "ended");
    expect(ended?.outcome).toBe("timeout");
    const runDir = join(state, "runs", ended?.id ?? "missing");
    const pid = Number(await readFile(join(runDir, "child.pid"), "utf8"));
    const reportParsed = jsonOf(ReapResult).safeParse(
      await readFile(join(runDir, "report.json"), "utf8"),
    );
    expect(reportParsed.success).toBe(true);
    if (!reportParsed.success) return;
    const report = reportParsed.data;
    expect(report.reaped).toEqual({
      count: 1,
      processes: [{ pid, argv0: "sleep" }],
    });
    expect(ended?.reaped).toEqual(report.reaped);
    expect(report.survivors).toEqual([]);
    for (let i = 0; i < 100; i++) {
      const text = await Bun.file(log)
        .text()
        .catch(() => "");
      if (text.includes("reaped 1 processes")) break;
      await Bun.sleep(50);
    }
    expect(await readFile(log, "utf8")).toContain("reaped 1 processes");
    expect(
      await Bun.file(`/proc/${pid}/environ`)
        .text()
        .catch(() => ""),
    ).not.toContain(`AGX_RUN_DIR=${runDir}`);
  },
  90000,
);
