import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ownSuiteDirectory, withSuitePath } from "../../src/next/verify.ts";
import { decodedJson } from "../decode.ts";
import { z } from "../../../shared/src/zod.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("worker and verify resolve agx in the running suite even when the link disappears", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-own-version-"));
  roots.push(root);
  const suite = join(root, "Cellar", "agx", "old", "bin");
  const links = join(root, "bin");
  mkdirSync(suite, { recursive: true });
  mkdirSync(links);
  for (const name of ["agx", "agx-worker"]) {
    const path = join(suite, name);
    writeFileSync(path, '#!/bin/sh\nprintf "old\\n"\n');
    chmodSync(path, 0o755);
  }
  const link = join(links, "agx-worker");
  symlinkSync(join(suite, "agx-worker"), link);
  const directory = ownSuiteDirectory(link, "/$bunfs/root/cli.js");
  expect(directory).toBe(suite);
  const env = withSuitePath({ PATH: `${links}:/usr/bin:/bin` }, directory);
  rmSync(link);
  for (const command of ["agx", 'sh -c "agx"']) {
    const child = Bun.spawnSync(["sh", "-c", command], { env });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("old\n");
  }
  expect(env.PATH?.split(":")[0]).toBe(suite);
});

test("source runs and incomplete suites leave PATH unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-own-version-source-"));
  roots.push(root);
  const worker = join(root, "agx-worker");
  writeFileSync(worker, "#!/bin/sh\n");
  chmodSync(worker, 0o755);
  const env = { PATH: "/original/bin" };
  expect(
    withSuitePath(env, ownSuiteDirectory(worker, "/source/cli.ts")),
  ).toEqual(env);
  expect(
    withSuitePath(env, ownSuiteDirectory(worker, "/$bunfs/root/cli.js")),
  ).toEqual(env);
});

test("actual run passes its suite PATH to the worker and verify and records it", async () => {
  const { prepareTicketRepo } = await import("../ticket-repo.ts");
  const { subprocessEnvironment } =
    await import("../../../shared/src/subprocess-env.ts");
  const root = mkdtempSync(join(tmpdir(), "agx-own-version-run-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const suite = join(root, "suite");
  mkdirSync(suite);
  const executable = join(suite, "agx-worker");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(process.cwd(), "tools/agx-worker/src/next/cli.ts"),
      "--outfile",
      executable,
    ],
    { cwd: root, timeout: 30000 },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const agx = join(suite, "agx");
  writeFileSync(agx, '#!/bin/sh\nprintf "old-suite\\n"\n');
  chmodSync(agx, 0o755);
  const worker = join(root, "worker.ts");
  writeFileSync(
    worker,
    `const result = Bun.spawnSync(["sh", "-c", "agx"]);\nawait Bun.write(${JSON.stringify(join(root, "worker-result"))}, result.stdout);\nprocess.stdout.write(JSON.stringify({report:{summary:"ok",changes:[],checks:[],for_coordinator:[],open:[]},vendor_session:"fixture"})+"\\n");\n`,
  );
  const ticket = join(root, "ticket.md");
  writeFileSync(
    ticket,
    `+++\nschema = 2\nname = "own-version"\ntimeout_s = 60\nwrites = []\ncapabilities = ["long-tool-loop"]\noutcome = "test"\nverify = ["agx"]\n[proposition]\nid = "OWN-VERSION"\nclaim = "same version"\nrefuted_by = "different version"\n+++\nWork.\n`,
  );
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: {
          worker: { choice: "mechanical", probabilities: { mechanical: 1 } },
        },
      }),
  });
  await using cleanup = { [Symbol.asyncDispose]: () => server.stop(true) };
  void cleanup;
  {
    const child = Bun.spawn(
      [executable, "run", ticket, "--cd", root, "--sandbox", "none"],
      {
        env: {
          ...subprocessEnvironment(),
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
          AGX_STATE_DIR: join(root, "state"),
          XDG_STATE_HOME: join(root, "tmp"),
          AGX_WORKER_BIN: worker,
          AGX_CONFIG: new URL(
            "../../src/roster/policy.example.toml",
            import.meta.url,
          ).pathname,
          JEV_URL: `http://127.0.0.1:${server.port}/`,
          TYPESAFE_API_KEY: "test-key",
          AGX_DISPATCHER_SESSION: "test-dispatcher",
          AGX_WORKER_PATH_SOURCE: "dispatcher",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr + stdout).toBe(0);
    expect(await Bun.file(join(root, "worker-result")).text()).toBe(
      "old-suite\n",
    );
    const execution = z.object({ suite_directory: z.string() });
    const result = decodedJson(
      z.object({ execution, report_path: z.string() }),
      stdout.trim().split("\n").at(-1) ?? "{}",
    );
    expect(result.execution.suite_directory).toBe(suite);
    const report = decodedJson(
      z.object({ execution }),
      await Bun.file(result.report_path).text(),
    );
    expect(report.execution.suite_directory).toBe(suite);
    expect(
      await Bun.file(
        join(dirname(result.report_path), "verify-round-1-01.log"),
      ).text(),
    ).toBe("old-suite\n");
    expect(stderr).toContain("VERIFY exit=0 agx");
  }
}, 60000);
