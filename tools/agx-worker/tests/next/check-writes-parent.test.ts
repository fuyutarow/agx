import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("check requires the literal prefix parent in the --cd tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-writes-parent-"));
  roots.push(root);
  await prepareTicketRepo(root);
  await mkdir(join(root, "tools", "existing"), { recursive: true });
  await writeFile(join(root, "tools", "existing", "file.ts"), "");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mise"),
    '#!/usr/bin/env bun\nconsole.log("{}");\n',
    { mode: 0o755 },
  );
  const ticket = join(root, "ticket.md");
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
  servers.push(server);
  for (const [entry, expected] of [
    ["tools/existing/file.ts", 0],
    ["tools/existing/new.ts", 0],
    ["tools/new/**", 0],
    ["tools/new/src/a.ts", 2],
    ["tools/new/src/*.ts", 2],
  ] as const) {
    await writeFile(
      ticket,
      `+++\nschema = 2\nname = "writes-parent"\noutcome = "fixture"\nwrites = [${JSON.stringify(entry)}]\n[proposition]\nid = "PARENT"\nclaim = "parent exists"\nrefuted_by = "missing parent passes"\n+++\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "check",
        ticket,
        "--cd",
        root,
      ],
      {
        env: {
          ...subprocessEnvironment(),
          PATH: `${bin}:${process.env.PATH}`,
          AGX_STATE_DIR: join(root, "state"),
          XDG_CONFIG_HOME: join(root, "config"),
          MISE_GLOBAL_CONFIG_FILE: join(root, "mise.toml"),
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
          JEV_URL: `http://127.0.0.1:${server.port}/choice`,
          TYPESAFE_API_KEY: "fixture-only",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(expected);
    if (expected === 2) {
      expect(stderr).toContain(entry);
      expect(stderr).toContain("repair:");
      expect(stderr).toContain("deepest existing directory");
    }
  }
}, 30000);
