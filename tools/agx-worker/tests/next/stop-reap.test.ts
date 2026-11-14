import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

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
  "stop reaps marked processes after the run process already recorded ended",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agx-stop-reap-"));
    roots.push(root);
    const state = join(root, "state");
    const runDir = join(state, "runs", "fixture-run");
    await mkdir(runDir, { recursive: true });
    const runMark = `AGX_RUN_DIR=${runDir}`;
    const marked = Bun.spawn(["setsid", "sleep", "60"], {
      env: { ...subprocessEnvironment(), AGX_RUN_DIR: runDir },
      stdout: "ignore",
      stderr: "ignore",
    });
    const unmarked = Bun.spawn(["setsid", "sleep", "60"], {
      env: { ...subprocessEnvironment(), AGX_RUN_DIR: `${runDir}-other` },
      stdout: "ignore",
      stderr: "ignore",
    });
    children.push(marked, unmarked);
    await Bun.sleep(100);
    await Bun.write(
      join(runDir, "report.json"),
      JSON.stringify({
        outcome: "stopped",
        reaped: {
          count: 1,
          processes: [{ pid: 424242, argv0: "prior-worker" }],
        },
        survivors: [],
        reap_status: "complete",
      }),
    );
    await Bun.write(
      join(state, "records.jsonl"),
      [
        {
          kind: "started",
          id: "fixture-run",
          at: "2026-11-15T00:00:00Z",
          ticket: "fixture",
          writes: [],
          cwd: root,
          workspace: root,
          row: "fixture",
          dispatcher_session: null,
          vendor_session: null,
          pid: 1,
        },
        {
          kind: "ended",
          id: "fixture-run",
          at: "2026-11-15T00:00:01Z",
          outcome: "stopped",
          exit: 143,
          vendor_session: null,
          report_path: join(runDir, "report.json"),
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const env = {
      ...subprocessEnvironment(),
      AGX_STATE_DIR: state,
      XDG_STATE_HOME: join(root, "xdg"),
      XDG_CONFIG_HOME: join(root, "config"),
      AGX_DISPATCHER_SESSION: "stop-reap-fixture",
      MISE_TRUSTED_CONFIG_PATHS: process.cwd(),
    };
    const cli = resolve("tools/agx-worker/src/next/cli.ts");
    const runStop = async () => {
      const child = Bun.spawn([process.execPath, cli, "stop", "fixture-run"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      });
      const [exit, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      return { exit, stderr };
    };
    const stopped = await runStop();
    expect(stopped.exit, stopped.stderr).toBe(0);
    expect(stopped.stderr).toContain(`${marked.pid} sleep`);
    expect(await marked.exited).not.toBe(0);
    expect(unmarked.exitCode).toBeNull();
    expect(
      (await Bun.file(`/proc/${unmarked.pid}/environ`).text()).split("\0"),
    ).not.toContain(runMark);
    const report = jsonOf(
      z.object({
        reaped: z.object({
          count: z.number(),
          processes: z.array(z.object({ pid: z.number(), argv0: z.string() })),
        }),
      }),
    ).safeParse(await Bun.file(join(runDir, "report.json")).text());
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.data.reaped.processes).toEqual([
      { pid: 424242, argv0: "prior-worker" },
      { pid: marked.pid, argv0: "sleep" },
    ]);
    expect(report.data.reaped.count).toBe(2);
    const second = await runStop();
    expect(second.exit).toBe(0);
    expect(second.stderr).not.toContain("reaped/surviving processes");
    expect(unmarked.exitCode).toBeNull();
  },
);
