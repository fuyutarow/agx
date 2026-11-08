import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("check validates absolute external reads, not descriptions or ticket body", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-external-reads-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  await mkdir(workspace);
  await mkdir(bin);
  await symlink(
    resolve("tools/agx-worker/src/next/cli.ts"),
    join(bin, "agx-worker"),
  );
  await writeFile(
    join(bin, "mise"),
    '#!/usr/bin/env bun\nconsole.log("{}");\n',
  );
  await chmod(join(bin, "mise"), 0o755);
  const ticket = join(root, "external.md");
  const existing = join(root, "reference");
  const missing = join(root, "missing");
  await writeFile(existing, "reference");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "mechanical", confidence: 0.9 } },
      }),
  });
  servers.push(server);
  const check = async (entry: string) => {
    await writeFile(
      ticket,
      `+++\nschema = 2\nname = "external"\noutcome = "fixture"\nwrites = []\nverify = ["test -s result.md"]\nexternal_reads = [${JSON.stringify(entry)}, "a reference description"]\n[proposition]\nid = "P"\nclaim = "exists"\nrefuted_by = "missing"\n+++\nBody mentions ${missing}\n`,
    );
    const env = {
      ...subprocessEnvironment(),
      JEV_URL: `http://127.0.0.1:${server.port}/choice`,
      TYPESAFE_API_KEY: "fixture-only",
      PATH: `${bin}:${process.env.PATH}`,
      AGX_STATE_DIR: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      MISE_GLOBAL_CONFIG_FILE: join(root, "mise.toml"),
      AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
    };
    Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx/src/agx.ts"),
        "worker",
        "check",
        ticket,
        "--cd",
        workspace,
      ],
      {
        env,
        stdin: "ignore",
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
    return { exit, stdout, stderr };
  };
  const passed = await check(existing);
  expect(passed.exit, passed.stderr).toBe(0);
  expect(passed.stdout).toContain("OK ticket=external");
  const refused = await check(missing);
  expect(refused.exit).toBe(2);
  expect(refused.stderr).toContain(missing);
  expect(refused.stderr).toContain("repair:");
}, 30000);
