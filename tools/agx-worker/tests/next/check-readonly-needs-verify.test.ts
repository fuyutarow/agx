import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("preflight requires verify for read-only tickets and accepts a human oracle for writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-readonly-verify-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mise"),
    '#!/usr/bin/env bun\nconsole.log("{}");\n',
    { mode: 0o755 },
  );
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = jsonOf(
        z.object({
          questions: z.object({
            worker: z.object({ criteria: z.record(z.string(), z.unknown()) }),
          }),
        }),
      ).safeParse(await request.text());
      if (!body.success)
        return new Response("invalid request", { status: 400 });
      const choice = Object.keys(body.data.questions.worker.criteria)[0];
      return Response.json({ answers: { worker: { choice } } });
    },
  });
  const path = join(root, "readonly.md");
  const invoke = async (writes: string, verify: string) => {
    await writeFile(
      path,
      `+++\nschema = 2\nname = "readonly"\noutcome = "Produce evidence"\nwrites = ${writes}\n${verify}[proposition]\nid = "P1"\nclaim = "Evidence exists"\nrefuted_by = "Human review finds missing evidence"\n+++\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "check",
        path,
        "--cd",
        root,
        "--json",
      ],
      {
        cwd: root,
        env: {
          ...subprocessEnvironment(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          AGX_NEXT_STATE_DIR: undefined,
          AGX_STATE_DIR: join(root, "state"),
          XDG_STATE_HOME: join(root, "xdg-state"),
          XDG_CONFIG_HOME: join(root, "config"),
          JEV_URL: `http://127.0.0.1:${server.port}/choice`,
          TYPESAFE_API_KEY: "fixture",
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { exit, stderr };
  };
  const refused = await invoke("[]", "");
  expect(refused.exit).toBe(2);
  expect(refused.stderr).toContain("read-only ticket has no verify command");
  expect(refused.stderr).toContain("repair: declare a verify command");
  const verified = await invoke("[]", 'verify = ["test -s result.md"]\n');
  expect(verified.exit, verified.stderr).toBe(0);
  const writable = await invoke('["src/**"]', "");
  expect(writable.exit, writable.stderr).toBe(0);
  await server.stop(true);
}, 60000);
