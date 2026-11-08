import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { VerifyResult } from "../../src/next/verify.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

for (const duringVerify of [false, true]) {
  test(`stopped run reports verify ${duringVerify ? "interrupted" : "not run"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agx-stop-verify-"));
    const state = join(root, "state");
    await mkdir(join(root, ".agents", "tickets"), { recursive: true });
    const ticket = join(root, ".agents", "tickets", "ticket.md");
    const ready = join(root, "ready");
    const command = `echo running; touch ${ready}; exec sleep 60`;
    await Bun.write(
      ticket,
      `+++\nschema = 2\nname = "stop-verify"\nwrites = []\noutcome = "verify state"\nverify = ["echo completed", ${JSON.stringify(command)}]\n[proposition]\nid = "STOP-VERIFY"\nclaim = "reports verify"\nrefuted_by = "wrong state"\n+++\nWait.\n`,
    );
    const worker = join(root, "worker.ts");
    await Bun.write(
      worker,
      duringVerify
        ? `process.stdout.write(JSON.stringify({exit:0, report:{summary:"done",changes:[],checks:[],for_coordinator:[],open:[]}})+"\\n");`
        : `await Bun.write(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
    );
    // The end notice is one `reason-network send <address> <message>` (src/next/end-notice.ts sendOnce);
    // `agx msg` is retired (tools/agx/src/agx.ts). The fake answers `who --json` for the dispatcher
    // session and records the message it is asked to send.
    const notice = join(root, "notice");
    const reasonNetwork = join(root, "reason-network");
    await Bun.write(
      reasonNetwork,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === "who") console.log(JSON.stringify({ sessions: [{ address: "fixture@codex", is_me: true }] }));\nelse if (args[0] === "send") { await Bun.write(${JSON.stringify(notice)}, args[2] ?? ""); console.log("message id 01ARZ3NDEKTSV4RRFFQ69G5FAV"); }\nelse process.exit(2);\n`,
    );
    await chmod(reasonNetwork, 0o755);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ answers: { worker: { choice: "localized" } } }),
    });
    const env = {
      ...subprocessEnvironment(),
      PATH: `${root}:${process.env.PATH ?? ""}`,
      AGX_DISPATCHER_SESSION: "codex:fixture",
      AGX_STATE_DIR: state,
      XDG_STATE_HOME: join(root, "xdg"),
      XDG_CONFIG_HOME: join(root, "config"),
      AGX_WORKER_BIN: worker,
      JEV_URL: `http://127.0.0.1:${server.port}`,
      TYPESAFE_API_KEY: "test",
      AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
      AGX_WORKER_PATH_SOURCE: "dispatcher",
    };
    const cli = resolve("tools/agx-worker/src/next/cli.ts");
    const owner = Bun.spawn(
      [process.execPath, cli, "run", ticket, "--cd", root],
      { env, stdout: "ignore", stderr: "pipe", timeout: 15000 },
    );
    const errors = new Response(owner.stderr).text();
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        if (owner.exitCode === null) owner.kill("SIGKILL");
        await server.stop(true);
        await rm(root, { recursive: true, force: true });
      },
    };
    {
      for (
        let i = 0;
        i < 400 && owner.exitCode === null && !(await Bun.file(ready).exists());
        i += 1
      )
        await Bun.sleep(25);
      expect(
        await Bun.file(ready).exists(),
        owner.exitCode === null ? "timed out" : await errors,
      ).toBe(true);
      owner.kill("SIGTERM");
      expect(await owner.exited, await errors).toBe(143);
      const eventSchema = z.object({
        kind: z.literal("ended"),
        id: z.string(),
        report_path: z.string(),
        verify: z.array(VerifyResult),
      });
      const records = (await Bun.file(join(state, "records.jsonl")).text())
        .trim()
        .split("\n")
        .flatMap((line) => {
          const parsed = jsonOf(eventSchema).safeParse(line);
          return parsed.success ? [parsed.data] : [];
        });
      const ended = records.at(-1);
      if (ended === undefined) expect.unreachable("missing ended record");
      const parsedReport = jsonOf(
        z.object({ outcome: z.string(), verify: z.array(VerifyResult) }),
      ).safeParse(await Bun.file(ended.report_path).text());
      if (!parsedReport.success) expect.unreachable("invalid report");
      const report = parsedReport.data;
      expect(report.outcome).toBe("stopped");
      expect(ended.verify.map((entry: { kind: string }) => entry.kind)).toEqual(
        duringVerify ? ["passed", "interrupted"] : [],
      );
      expect(report.verify).toEqual(ended.verify);
      const interrupted = ended.verify[1];
      if (duringVerify && interrupted === undefined)
        expect.unreachable("missing interrupted command");
      if (interrupted !== undefined)
        expect(
          await Bun.file(interrupted?.log_path ?? "missing").text(),
        ).toContain("running");
      for (let i = 0; i < 200 && !(await Bun.file(notice).exists()); i += 1)
        await Bun.sleep(25);
      const noticeText = await Bun.file(notice).text();
      expect(noticeText).toContain(
        duringVerify ? "interrupted:" : "verify: not run",
      );
      expect(noticeText).toContain(ended.report_path);
      if (duringVerify) {
        expect(noticeText).toContain("completed exit=0: echo completed");
        expect(noticeText).toContain(interrupted?.log_path ?? "missing");
      }
      const ls = Bun.spawn([process.execPath, cli, "ls", ended.id, "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      });
      const [exit, output] = await Promise.all([
        ls.exited,
        new Response(ls.stdout).text(),
      ]);
      expect(exit).toBe(0);
      const listed = jsonOf(
        z.array(z.object({ verify: z.array(VerifyResult) })),
      ).safeParse(output);
      if (!listed.success) expect.unreachable("invalid listing");
      expect(listed.data[0]?.verify).toEqual(ended.verify);
    }
  }, 20000);
}
