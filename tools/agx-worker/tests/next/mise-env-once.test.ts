import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodedJson } from "../decode.ts";
import { z } from "../../../shared/src/zod.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

test.each([false, true])(
  "dispatch counts mise and preserves refusal (failure=%s)",
  async (fail) => {
    const root = await mkdtemp(join(tmpdir(), "agx-mise-once-"));
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          answers: {
            worker: {
              choice: "sol-medium",
              probabilities: { "sol-medium": 1 },
            },
          },
        }),
    });
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        await server.stop(true);
        await rm(root, { recursive: true, force: true });
      },
    };
    {
      await prepareTicketRepo(root);
      const bin = join(root, "bin");
      await mkdir(bin);
      const count = join(root, "mise-count");
      const mise = join(bin, "mise");
      await writeFile(
        mise,
        `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(count)}, "call\\n");\n${fail ? 'process.stderr.write("fixture mise failure\\n"); process.exit(1);' : 'process.stdout.write(JSON.stringify({AGX_MISE_FIXTURE: "from-mise", TMPDIR: "from-mise"}));'}\n`,
      );
      await chmod(mise, 0o755);
      const worker = join(root, "worker.ts");
      await writeFile(
        worker,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "worker-env"))}, JSON.stringify({value: process.env.AGX_MISE_FIXTURE, tmp: process.env.TMPDIR}));\nprocess.stdout.write(JSON.stringify({report: {summary: "done", changes: [], checks: [], for_coordinator: [], open: []}, vendor_session: "fixture"}) + "\\n");\n`,
      );
      const ticket = join(root, "ticket.md");
      await writeFile(
        ticket,
        '+++\nschema = 2\nname = "mise-once"\ntimeout_s = 60\nwrites = []\ncapabilities = ["long-tool-loop"]\noutcome = "test dispatch"\nverify = []\n[proposition]\nid = "MISE-ONCE"\nclaim = "one invocation"\nrefuted_by = "two invocations"\n+++\nWork.\n',
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
            PATH: `${bin}:${process.env.PATH}`,
            HOME: root,
            XDG_CONFIG_HOME: join(root, "config"),
            AGX_STATE_DIR: join(root, "state"),
            AGX_TMP_ROOT: join(root, "tmp"),
            AGX_WORKER_BIN: worker,
            AGX_CONFIG: new URL(
              "../../src/roster/policy.example.toml",
              import.meta.url,
            ).pathname,
            JEV_URL: `http://127.0.0.1:${server.port}/`,
            TYPESAFE_API_KEY: "test-key",
            AGX_DISPATCHER_SESSION: "test-dispatcher",
            AGX_WORKER_PATH_SOURCE: undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20000,
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const calls = (await readFile(count, "utf8")).trim().split("\n").length;
      expect(calls).toBe(1);
      if (fail) {
        expect(exit).toBe(2);
        expect(stderr).toContain(
          `cannot assemble repository mise environment: fixture mise failure; repair: inspect the target configuration, then run mise trust in ${root}`,
        );
      } else {
        expect(exit, stderr + stdout).toBe(0);
        const env = decodedJson(
          z.object({ value: z.string(), tmp: z.string() }),
          await readFile(join(root, "worker-env"), "utf8"),
        );
        expect(env.value).toBe("from-mise");
        expect(env.tmp).toStartWith(join(root, "tmp"));
      }
    }
  },
);
