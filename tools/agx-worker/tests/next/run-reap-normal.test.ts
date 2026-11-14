import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { ReapResult } from "../../src/next/reap.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";

test.if(process.platform === "linux")(
  "normal end records empty reap lists and no notice clause",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agx-reap-normal-"));
    await using _root = {
      [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    };
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
      'console.log(JSON.stringify({report:{summary:"done",changes:[],checks:[],for_coordinator:[],open:[]}}));\n',
    );
    const ticket = join(workspace, "ticket.md");
    await Bun.write(
      ticket,
      '+++\nschema = 2\ntimeout_s = 60\nname = "reap-normal"\nwrites = ["work.txt"]\noutcome = "fixture"\nverify = ["true"]\n[proposition]\nid = "REAP-NORMAL"\nclaim = "reap"\nrefuted_by = "wrong report"\n+++\nFixture.\n',
    );
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ answers: { worker: { choice: "mechanical" } } }),
    });
    await using _server = {
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
        timeout: 15000,
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).toBe(0);
    const records = (await Bun.file(join(state, "records.jsonl")).text())
      .trim()
      .split("\n")
      .flatMap((line) => {
        const parsed = jsonOf(
          z.looseObject({
            kind: z.string(),
            id: z.string(),
            reaped: ReapResult.shape.reaped.optional(),
            survivors: ReapResult.shape.survivors.optional(),
          }),
        ).safeParse(line);
        return parsed.success ? [parsed.data] : [];
      });
    const ended = records.findLast((row) => row.kind === "ended");
    expect(ended?.reaped).toEqual({ count: 0, processes: [] });
    expect(ended?.survivors).toEqual([]);
    const report = jsonOf(ReapResult).safeParse(
      await Bun.file(
        join(state, "runs", ended?.id ?? "missing", "report.json"),
      ).text(),
    );
    expect(report.success && report.data.reaped).toEqual({
      count: 0,
      processes: [],
    });
    expect(report.success && report.data.survivors).toEqual([]);
    let notice = "";
    for (let i = 0; i < 100; i++) {
      notice = await Bun.file(log)
        .text()
        .catch(() => "");
      if (notice.includes('"command":"send"')) break;
      await Bun.sleep(50);
    }
    expect(notice).toContain('"command":"send"');
    expect(notice).not.toContain("reaped ");
    expect(notice).not.toContain("could not stop pids");
  },
  30000,
);
