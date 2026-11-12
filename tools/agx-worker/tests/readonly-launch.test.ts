import { afterAll, afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTicketRepo } from "./ticket-repo.ts";
import { createTempTracker } from "./temp.ts";
import { append, foldedRuns, now } from "../src/next/store.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

// AGX-READONLY-LAUNCH-LOST-1103: a read-only claude-route dispatch either starts with a run dir or
// is refused with a reason; a failure before launch is a launch failure with its cause, never lost.

const tempDirs = createTempTracker();
afterAll(tempDirs.assertRemoved);
const servers: ReturnType<typeof Bun.spawn>[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(tmpRoot?: (root: string) => string) {
  const root = tempDirs.register(
    mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-readonly-`)),
  );
  roots.push(root);
  await prepareTicketRepo(root);
  const state = join(root, "state");
  const binding = {
    id: "00000000-0000-4000-8000-000000001103",
    ticket: "readonly-launch",
    workspace: root,
    unit: "agt_readonly-launch",
  };
  const ticket = join(root, "ticket.md");
  writeFileSync(
    ticket,
    `+++\nschema = 2\nname = "readonly-launch"\nwrites = []\noutcome = "read-only claude launch"\nverify = ["true"]\n[proposition]\nid = "READONLY"\nclaim = "read-only claude starts or is refused"\nrefuted_by = "ends lost without a cause"\n+++\nRead only.\n`,
  );
  const policy = join(root, "policy.toml");
  writeFileSync(
    policy,
    readFileSync(
      new URL("../src/roster/policy.example.toml", import.meta.url).pathname,
      "utf8",
    ).replace(
      'allow = ["codex", "claude-session"]',
      'allow = ["claude-session"]',
    ),
  );
  const worker = join(root, "fake-claude-worker.ts");
  writeFileSync(
    worker,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(root, "argv.log"))}, JSON.stringify(Bun.argv.slice(2)) + "\\n");\nconsole.log(JSON.stringify({ report: { summary: "done", changes: [], checks: [], for_coordinator: [], open: [] } }));\n`,
  );
  chmodSync(worker, 0o755);
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const jev = join(root, "jev.ts");
  writeFileSync(
    jev,
    `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ answers: { worker: { choice: "mechanical", confidence: 0.9 } } }) });\n`,
  );
  servers.push(
    Bun.spawn([process.execPath, jev], { stdout: "ignore", stderr: "ignore" }),
  );
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}`).catch(() => null)) !== null)
      break;
    await Bun.sleep(25);
  }
  append(
    {
      kind: "dispatching",
      id: binding.id,
      at: now(),
      ticket: binding.ticket,
      writes: [],
      cwd: root,
      workspace: root,
      worker_name: binding.unit,
      unit: binding.unit,
      dispatcher_session: null,
      vendor_session: null,
      pid: process.pid,
      ticket_path: ticket,
    },
    state,
  );
  const env = {
    ...subprocessEnvironment(),
    XDG_CONFIG_HOME: join(root, "config"),
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: tmpRoot?.(root) ?? join(root, "agx-tmp"),
    JEV_URL: `http://127.0.0.1:${port}`,
    TYPESAFE_API_KEY: "test-key",
    AGX_WORKER_COMMAND: worker,
    AGX_CONFIG: policy,
  };
  const dispatch = () =>
    Bun.spawnSync(
      [
        process.execPath,
        "tools/agx-worker/src/next/cli.ts",
        "run",
        ticket,
        "--cd",
        root,
        "--sandbox",
        "read-only",
        "--dispatch-binding",
        JSON.stringify(binding),
      ],
      { cwd: process.cwd(), env, timeout: 20_000 },
    );
  return { root, state, binding, dispatch };
}

test("a read-only claude dispatch starts with a run dir and plan permission, or is refused with a reason", async () => {
  const { state, binding, dispatch } = await fixture();
  const result = dispatch();
  const run = (await foldedRuns(state)).find((r) => r.id === binding.id);
  expect(run, result.stderr.toString()).toBeDefined();
  if (run?.row === "dispatching") {
    // refused: must carry a reason and never be lost
    expect(run.outcome).toBe("refused");
    expect(result.stderr.toString()).not.toBe("");
    return;
  }
  expect(existsSync(join(state, "runs", binding.id))).toBe(true);
  expect(run?.route).toBe("claude-session");
  expect(run?.sandbox).toBe("read-only");
  const argv = readFileSync(join(state, "..", "argv.log"), "utf8");
  expect(argv).toContain('"--internal-claude"');
  expect(argv).toContain('"--permission-mode","plan"');
  expect(run?.outcome).not.toBe("lost");
});

test("a run that fails before launch ends launch-failed with its cause and stderr, never lost", async () => {
  // XDG_STATE_HOME below a regular file: the run temp cannot be created, so the process exits before
  // it records started or makes a run dir.
  const { root, state, binding, dispatch } = await fixture((r) => {
    const file = join(r, "not-a-directory");
    mkdirSync(r, { recursive: true });
    writeFileSync(file, "x");
    return join(file, "tmp");
  });
  const result = dispatch();
  expect(result.exitCode).not.toBe(0);
  const run = (await foldedRuns(state)).find((r) => r.id === binding.id);
  expect(run).toMatchObject({ state: "ended", outcome: "launch-failed" });
  expect(run?.outcome).not.toBe("lost");
  expect(run?.evidence).toBeUndefined();
  expect(run?.cause).toContain("before the run started");
  expect(run?.launch_stderr ?? "").not.toBe("");
  expect(
    readFileSync(join(state, "runs", binding.id, "launch-failure.txt"), "utf8"),
  ).toContain("before the run started");
  expect(root).toBeDefined();
});
