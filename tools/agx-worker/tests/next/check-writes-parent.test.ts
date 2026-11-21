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
  // [entry, exit, the exact repair glob named on refusal]
  for (const [entry, expected, anchored] of [
    ["tools/existing/file.ts", 0, ""],
    ["tools/existing/new.ts", 0, ""],
    ["tools/new/**", 0, ""],
    ["tools/new/src/a.ts", 2, "tools/new/**"],
    ["tools/new/src/*.ts", 2, "tools/new/**"],
    // Only the root exists: the repair is one new top-level directory, never the root `**`.
    ["bundles/icd-mechanism-20261122/**", 2, "bundles/**"],
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
      expect(stderr).toContain(`use ${anchored}, or keep ${entry}`);
      expect(stderr).toContain(".keep");
      expect(stderr).not.toContain("use **");
    }
  }
}, 30000);

const jj = async (root: string, ...args: string[]) => {
  const child = Bun.spawn(["jj", ...args], {
    cwd: root,
    env: {
      ...subprocessEnvironment(),
      JJ_USER: "Fixture",
      JJ_EMAIL: "fixture@example.invalid",
      // The repository-scoped trunk() alias lives under the config home check reads.
      XDG_CONFIG_HOME: join(root, "config"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
};

test("check without --cd warns when a writes parent is absent from the trunk a dispatch starts from", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-writes-trunk-"));
  roots.push(root);
  await writeFile(join(root, "agx.toml"), 'schema = 1\ntickets = "."\n');
  await mkdir(join(root, "landed"));
  await writeFile(join(root, "landed", "file.ts"), "");
  await jj(root, "git", "init");
  await jj(root, "commit", "-m", "base");
  await jj(root, "bookmark", "create", "main", "-r", "@-");
  await jj(root, "config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  // Present in this working copy only: a workspace created from main does not have it.
  await mkdir(join(root, "pending"));
  await writeFile(join(root, "pending", "file.ts"), "");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mise"),
    '#!/usr/bin/env bun\nconsole.log("{}");\n',
    { mode: 0o755 },
  );
  await mkdir(join(root, ".agents", "tickets"), { recursive: true });
  const ticket = join(root, ".agents", "tickets", "ticket.md");
  await writeFile(
    ticket,
    `+++\nschema = 2\nname = "writes-trunk"\noutcome = "fixture"\nwrites = ["landed/new.ts", "pending/new.ts"]\nverify = ["true"]\n[proposition]\nid = "TRUNK"\nclaim = "check predicts dispatch"\nrefuted_by = "a working-copy-only parent passes silently"\n+++\n`,
  );
  const check = async (...flags: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "check",
        ticket,
        "--skip-routing",
        ...flags,
      ],
      {
        cwd: root,
        env: {
          ...subprocessEnvironment(),
          PATH: `${bin}:${process.env.PATH}`,
          AGX_STATE_DIR: join(root, "state"),
          XDG_CONFIG_HOME: join(root, "config"),
          MISE_GLOBAL_CONFIG_FILE: join(root, "mise.toml"),
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
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
    return { exit, stderr };
  };
  const asked = await check();
  expect(asked.exit, asked.stderr).toBe(0);
  expect(asked.stderr).toContain(
    "WARN ticket writes.1: pending/new.ts parent directory pending exists in",
  );
  expect(asked.stderr).toContain("has no tracked file at trunk()");
  expect(asked.stderr).not.toContain("writes.0");
  // With --cd the caller names the prepared tree, as dispatch does; that tree is what counts.
  const prepared = await check("--cd", root);
  expect(prepared.exit, prepared.stderr).toBe(0);
  expect(prepared.stderr).not.toContain("WARN ticket writes");
}, 30000);
