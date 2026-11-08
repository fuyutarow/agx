import { prepareTicketRepo } from "../ticket-repo.ts";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
setDefaultTimeout(15000);
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonOf, z } from "../../../shared/src/zod.ts";
import { createTempTracker } from "../temp.ts";
import {
  agxTempRoot,
  createRunTemp,
  freeRunTemp,
  recordedLifetime,
} from "../../src/temp.ts";
import { append } from "../../src/next/store.ts";
import {
  workerWritableRoots,
  claudeWorkspaceWriteSettings,
} from "../../src/workers/environment.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const tempDirs = createTempTracker();
afterAll(tempDirs.assertRemoved);

const servers: ReturnType<typeof Bun.spawn>[] = [];
const jevServers: ReturnType<typeof Bun.serve>[] = [];
const roots: string[] = [];
const makeWritable = (path: string) => {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
};
afterEach(async () => {
  for (const server of servers.splice(0)) server.kill();
  for (const server of jevServers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});
const scratch = (prefix: string): string => {
  const root = tempDirs.register(
    mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-${prefix}`)),
  );
  roots.push(root);
  return root;
};

const CLI = "tools/agx-worker/src/next/cli.ts";

// A fixture agx project: fake Jev, a ticket, and a worker script that reports its temp variables.
async function fixture(workerBody: string, verify: string | string[]) {
  const root = scratch("run-temp-");
  await prepareTicketRepo(root);
  const tempRoot = join(root, "xdg-state", "agx", "runs");
  const ticket = join(root, "ticket.md");
  const worker = join(root, "fake-worker.ts");
  const jev = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        answers: { worker: { choice: "mechanical", confidence: 0.9 } },
      }),
  });
  jevServers.push(jev);
  writeFileSync(
    ticket,
    `+++\nschema = 2\nname = "temp-fixture"\nwrites = []\noutcome = "temp fixture"\nverify = ${JSON.stringify(Array.isArray(verify) ? verify : [verify])}\n[proposition]\nid = "TMP-1"\nclaim = "run owns temp"\nrefuted_by = "leftover"\n+++\nRun the fixture.\n`,
  );
  writeFileSync(worker, workerBody);
  const home = join(root, "fixture-home");
  const env = {
    ...subprocessEnvironment(),
    HOME: home,
    AGX_WORKER_PATH_SOURCE: "dispatcher",
    AGX_STATE_DIR: join(root, "state"),
    JEV_URL: `http://127.0.0.1:${jev.port}/choice`,
    AGX_WORKER_BIN: worker,
    XDG_STATE_HOME: join(root, "xdg-state"),
    TYPESAFE_API_KEY: "test-key",
    AGX_CONFIG: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  };
  return { root, tempRoot, ticket, env };
}

const DONE = `process.stdout.write(JSON.stringify({ exit: 0, report: { summary: "done", changes: [], checks: [], for_coordinator: [], open: [] } }) + "\\n");\n`;

describe("agx worker run owns its temp space", () => {
  test("bare service environment shares user tools, mise PATH and temp with verify; records failure kinds", async () => {
    const f = await fixture(
      `import { writeFileSync } from "node:fs";
       const tools = Bun.spawnSync(["sh", "-c", "cargo-only --help && bun-only --help && repo-only --help"]);
       if (tools.exitCode !== 0) process.exit(1);
       writeFileSync("worker-env.txt", [process.env.PATH, process.env.TMPDIR, process.env.AGX_MISE_FIXTURE].join("\\n"));
       ${DONE}`,
      [
        'cargo-only --help && bun-only --help && repo-only --help && printf "%s\\n%s\\n%s" "$PATH" "$TMPDIR" "$AGX_MISE_FIXTURE" > verify-env.txt',
        "agx-command-that-does-not-exist",
        "./not-executable",
        "kill -KILL $$",
        "exit 7",
      ],
    );
    const home = join(f.root, "home");
    for (const [dir, name] of [
      [".cargo/bin", "cargo-only"],
      [".bun/bin", "bun-only"],
      ["repo-bin", "repo-only"],
    ]) {
      const bin = join(home, dir ?? "");
      mkdirSync(bin, { recursive: true });
      const path = join(bin, name ?? "");
      writeFileSync(path, '#!/bin/sh\n[ "$1" = --help ]\n');
      chmodSync(path, 0o755);
    }
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const mise = join(home, ".local/bin/mise");
    writeFileSync(
      mise,
      `#!/bin/sh\nprintf '{"PATH":"%s:${join(home, "repo-bin")}","AGX_MISE_FIXTURE":"repo-value"}' "$PATH"\n`,
    );
    chmodSync(mise, 0o755);
    const jj = Bun.which("jj");
    if (jj === null) throw new Error("jj is required by the fixture");
    symlinkSync(jj, join(home, ".local/bin/jj"));
    writeFileSync(join(f.root, "not-executable"), "not executable\n");
    const env = {
      HOME: home,
      PATH: `${join(home, ".local/bin")}:/usr/bin:/bin`,
      AGX_STATE_DIR: f.env.AGX_STATE_DIR,
      JEV_URL: f.env.JEV_URL,
      AGX_WORKER_BIN: f.env.AGX_WORKER_BIN,
      XDG_STATE_HOME: f.env.XDG_STATE_HOME,
      TYPESAFE_API_KEY: f.env.TYPESAFE_API_KEY,
      AGX_CONFIG: f.env.AGX_CONFIG,
    };
    const child = Bun.spawn(
      [process.execPath, CLI, "run", f.ticket, "--cd", f.root],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    expect(stdout).toContain('"outcome":"verify-killed"');
    expect(readFileSync(join(f.root, "worker-env.txt"), "utf8")).toBe(
      readFileSync(join(f.root, "verify-env.txt"), "utf8"),
    );
    const listed = Bun.spawnSync([process.execPath, CLI, "ls", "--json"], {
      env,
    });
    expect(listed.exitCode).toBe(0);
    const records = readFileSync(
      join(f.env.AGX_STATE_DIR, "records.jsonl"),
      "utf8",
    );
    for (const kind of ["passed", "unrunnable", "killed", "failed"])
      expect(records).toContain(`"kind":"${kind}"`);
    const rows = jsonOf(
      z.array(
        z.looseObject({
          outcome: z.string(),
          verify: z.array(
            z.looseObject({
              exit: z.number(),
              kind: z.string(),
              log_path: z.string(),
            }),
          ),
        }),
      ),
    ).safeParse(listed.stdout.toString());
    expect(rows.success).toBe(true);
    if (!rows.success) return;
    expect(rows.data[0]?.outcome).toBe("verify-killed");
    expect(
      rows.data[0]?.verify.map(({ exit: code, kind }) => ({
        exit: code,
        kind,
      })),
    ).toEqual([
      { exit: 0, kind: "passed" },
      { exit: 127, kind: "unrunnable" },
      { exit: 126, kind: "unrunnable" },
      { exit: 137, kind: "killed" },
      { exit: 7, kind: "failed" },
    ]);
    expect(
      rows.data[0]?.verify.every(({ log_path }) => existsSync(log_path)),
    ).toBe(true);
  }, 15_000);

  test("worker and verify see TMPDIR under the temp root; the run removes it", async () => {
    const root0 = scratch("probe-");
    const seen = join(root0, "seen.txt");
    const f = await fixture(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, [process.env.TMPDIR, process.env.TMP, process.env.TEMP].join("\\n"));\n${DONE}`,
      `printf %s "$TMPDIR" > ${join(root0, "verify.txt")}`,
    );
    const result = Bun.spawn(
      [process.execPath, CLI, "run", f.ticket, "--cd", f.root],
      {
        cwd: process.cwd(),
        env: f.env,
        timeout: 10_000,
      },
    );
    expect(await result.exited).toBe(0);
    const [tmpdirSeen, tmpSeen, tempSeen] = readFileSync(seen, "utf8").split(
      "\n",
    );
    expect(tmpdirSeen?.startsWith(`${f.tempRoot}/`)).toBe(true);
    expect(tmpSeen).toBe(tmpdirSeen ?? "");
    expect(tempSeen).toBe(tmpdirSeen ?? "");
    expect(readFileSync(join(root0, "verify.txt"), "utf8")).toBe(
      tmpdirSeen ?? "",
    );
    expect(existsSync(tmpdirSeen ?? "")).toBe(false);
    expect(existsSync(tmpdirSeen ?? "")).toBe(false);
  });

  test("missing temp before verify is environment-lost", async () => {
    const f = await fixture(
      `import { rmSync } from "node:fs"; rmSync(process.env.TMPDIR, { recursive: true }); \n${DONE}`,
      "exit 7",
    );
    const child = Bun.spawn(
      [process.execPath, CLI, "run", f.ticket, "--cd", f.root],
      {
        cwd: process.cwd(),
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [out, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, error).toBe(0);
    expect(out).toContain('"outcome":"environment-lost"');
    expect(out).not.toContain('"outcome":"verify-failed"');
    expect(
      readFileSync(join(f.env.AGX_STATE_DIR, "records.jsonl"), "utf8"),
    ).toContain('"outcome":"environment-lost"');
  });

  test("reclaim only removes recorded ended runs", async () => {
    const f = await fixture(DONE, "true");
    const live = createRunTemp("live", f.tempRoot)._unsafeUnwrap();
    const ended = createRunTemp("ended", f.tempRoot)._unsafeUnwrap();
    append(
      {
        kind: "started",
        id: "ended",
        at: "2026-11-04T00:00:00Z",
        ticket: "fixture",
        writes: [],
        cwd: f.root,
        workspace: f.root,
        row: "fixture",
        dispatcher_session: null,
        vendor_session: null,
        pid: process.pid,
      },
      f.env.AGX_STATE_DIR,
      false,
    );
    append(
      {
        kind: "ended",
        id: "ended",
        at: "2026-11-04T00:00:00Z",
        exit: 0,
        report_path: null,
        vendor_session: null,
        verify: [],
      },
      f.env.AGX_STATE_DIR,
      false,
    );
    const child = Bun.spawn(
      [process.execPath, CLI, "run", f.ticket, "--cd", f.root],
      {
        cwd: process.cwd(),
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 12000,
      },
    );
    const [out, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, error + out).toBe(0);
    expect(existsSync(live.dir)).toBe(true);
    expect(existsSync(ended.dir)).toBe(false);
  });

  test("SIGTERM removes the run directory", async () => {
    const root0 = scratch("term-");
    const marker = join(root0, "worker-pid.txt");
    const f = await fixture(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "up");\nawait Bun.sleep(30000);\n`,
      "true",
    );
    const child = Bun.spawn(
      [process.execPath, CLI, "run", f.ticket, "--cd", f.root],
      {
        cwd: process.cwd(),
        env: f.env,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    servers.push(child);
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1)
      await Bun.sleep(25);
    expect(readdirSync(f.tempRoot).length).toBeGreaterThan(0);
    child.kill("SIGTERM");
    await child.exited;
    expect(
      readdirSync(f.tempRoot).every(
        (id) => !existsSync(join(f.tempRoot, id, "tmp")),
      ),
    ).toBe(true);
  });

  test("a read-only worker subtree is removed after the ended record is written", async () => {
    const f = await fixture(
      `import { chmodSync, mkdirSync } from "node:fs";\nconst child = process.env.TMPDIR + "/readonly";\nmkdirSync(child);\nchmodSync(child, 0o555);\n${DONE}`,
      "true",
    );
    const result = Bun.spawn(
      [process.execPath, CLI, "run", f.ticket, "--cd", f.root],
      { cwd: process.cwd(), env: f.env, timeout: 10_000, stdout: "pipe" },
    );
    expect(await result.exited).toBe(0);
    expect(
      readdirSync(f.tempRoot).every(
        (id) => !existsSync(join(f.tempRoot, id, "tmp")),
      ),
    ).toBe(true);
    const state = readFileSync(
      join(f.env.AGX_STATE_DIR, "records.jsonl"),
      "utf8",
    );
    const parsed = jsonOf(
      z.array(z.looseObject({ kind: z.string(), exit: z.number().optional() })),
    ).safeParse(`[${state.trim().split("\n").join(",")}]`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.at(-1)?.kind).toBe("ended");
    expect(parsed.data.at(-1)?.exit).toBe(0);
  });
});

describe("createRunTemp", () => {
  test("refuses a temp root that is /tmp itself and leaves /tmp untouched", () => {
    expect(createRunTemp("run-1", "/tmp")._unsafeUnwrapErr()).toContain(
      "refusing",
    );
    expect(existsSync("/tmp/run-1")).toBe(false);
    expect(existsSync("/tmp/run-1.pid")).toBe(false);
  });

  test("refuses ids that would escape the root", () => {
    const root = scratch("ids-");
    for (const id of ["", ".", "..", "a/b"])
      expect(createRunTemp(id, root)._unsafeUnwrapErr()).toContain(
        "invalid run id",
      );
  });

  test("only a recorded ended lifetime permits cleanup", () => {
    const root = scratch("lifetime-");
    const records = join(root, "records");
    const temp = createRunTemp("run-1", root)._unsafeUnwrap();
    append(
      {
        kind: "started",
        id: "run-1",
        at: "2026-11-04T00:00:00Z",
        ticket: "fixture",
        writes: [],
        cwd: root,
        workspace: root,
        row: "fixture",
        dispatcher_session: null,
        vendor_session: null,
        pid: process.pid,
      },
      records,
      false,
    );
    const live = recordedLifetime("run-1", records);
    // @ts-expect-error a live lifetime cannot authorize deletion
    expect(freeRunTemp(live, root, records).isErr()).toBe(true);
    expect(existsSync(temp.dir)).toBe(true);
    append(
      {
        kind: "ended",
        id: "run-1",
        at: "2026-11-04T00:00:00Z",
        exit: 0,
        report_path: null,
        vendor_session: null,
        verify: [],
      },
      records,
      false,
    );
    const ended = recordedLifetime("run-1", records);
    if (ended.state !== "ended") throw new Error("missing end record");
    expect(freeRunTemp(ended, root, records).isOk()).toBe(true);
    expect(existsSync(temp.dir)).toBe(false);
  });

  test("state root and both sandbox roots include the run temp", () => {
    const root = scratch("roots-");
    const runDir = join(root, "agx", "runs", "run-1");
    const temp = join(runDir, "tmp");
    expect(agxTempRoot({ XDG_STATE_HOME: root })).toBe(
      join(root, "agx", "runs"),
    );
    expect(
      workerWritableRoots({ runDir, source: { TMPDIR: temp, HOME: root } }),
    ).toContain(temp);
    expect(
      claudeWorkspaceWriteSettings({
        runDir,
        runTemp: temp,
        source: { HOME: root },
      }).sandbox.filesystem.allowWrite,
    ).toContain(temp);
  });
});
