import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DispatchBindingSchema } from "../../shared/src/agx-dispatch-binding.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";

const ENTRY = fileURLToPath(new URL("../src/next/cli.ts", import.meta.url));
const RunRecord = z.looseObject({
  id: z.string(),
  ticket: z.string(),
  cwd: z.string(),
  workspace: z.string(),
  unit: z.string(),
});
const roots: string[] = [];
function inheritedEnv() {
  const env = { ...process.env };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  return env;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-dispatch-"));
  roots.push(root);
  const repo = join(root, "repo");
  const tickets = join(repo, ".agents", "tickets");
  const bin = join(root, "bin");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(join(repo, ".jj"));
  mkdirSync(bin);
  const ticket = join(tickets, "foo-bar.md");
  writeFileSync(
    ticket,
    `+++\nschema = 2\nwrites = []\nname = "foo-bar"\noutcome = "fixture"\n[proposition]\nid = "P1"\nclaim = "fixture"\nrefuted_by = "fixture"\n+++\n`,
  );
  const records = join(root, "records.json");
  const unitArgs = join(root, "unit-args.txt");
  const bindingFile = join(root, "binding.json");
  const wsArgs = join(root, "ws-args.txt");
  const home = join(root, "home");
  mkdirSync(home);
  const entry = join(root, "dispatcher.ts");
  writeFileSync(
    entry,
    [
      `import { dispatchMain } from ${JSON.stringify(fileURLToPath(new URL("../src/dispatch.ts", import.meta.url)))};`,
      "const args = process.argv.slice(2);",
      'if (args[0] === "dispatch") await dispatchMain(args.slice(1));',
      'else { const child = Bun.spawn([process.env.FAKE_WORKER_COMMAND!, ...args], { stdout: "inherit", stderr: "inherit", timeout: 65_000 }); process.exitCode = await child.exited; }',
    ].join("\n"),
  );
  const systemdRunner = join(root, "fake-systemd-run.ts");
  writeFileSync(records, "[]\n");
  writeFileSync(
    systemdRunner,
    [
      'import { writeFileSync } from "node:fs";',
      "const args = Bun.argv.slice(2);",
      'writeFileSync(process.env.FAKE_UNIT_ARGS!, args.join("\\n") + "\\n");',
      'if (process.env.FAKE_START_FAIL === "yes") {',
      '  process.stderr.write("fixture unit failure\\n");',
      "  process.exit(1);",
      "}",
      'if (process.env.FAKE_NO_RECORD === "yes") process.exit(0);',
      'const divider = args.indexOf("--");',
      "const command = args.slice(divider + 1);",
      'const bindingIndex = command.indexOf("--dispatch-binding");',
      "const bindingText = command[bindingIndex + 1];",
      "writeFileSync(process.env.FAKE_BINDING!, bindingText!);",
      "const binding = JSON.parse(bindingText!);",
      'const cdIndex = command.indexOf("--cd");',
      "const workspace = command[cdIndex + 1];",
      'const record = JSON.stringify([{ ...binding, state: "running", cwd: workspace, row: "fixture-high", route: "codex", model: "fixture-model", effort: "high", sandbox: "workspace-write", sandbox_source: "built-in default", sandbox_effective: "workspace-write", sandbox_effective_source: "built-in default" }]) + "\\n";',
      'if (process.env.FAKE_LATE_RECORD === "yes") writeFileSync(process.env.FAKE_PENDING_RECORD!, record);',
      "else writeFileSync(process.env.FAKE_RECORDS!, record);",
    ].join("\n"),
  );
  const shim = (name: string, body: string[]) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body.join("\n")}\n`);
    chmodSync(path, 0o755);
  };
  shim("agx-ws", [
    `printf '%s\\n' "$@" > "$FAKE_WS_ARGS"`,
    'if [ "$FAKE_WS_FAIL" = "yes" ]; then echo "ws: fixture-home is not a valid local jj workspace" >&2; exit 1; fi',
    'slug="$2"',
    "shift 2",
    "json=no",
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--json" ]; then json=yes; fi',
    '  if [ "$1" = "--repo" ]; then repo="$2"; shift 2; else shift; fi',
    "done",
    'if [ "$repo" != "$FAKE_REPO" ]; then echo "ws: fixture-home is not a valid local jj workspace" >&2; exit 1; fi',
    'workspace="$(dirname "$repo")/$(basename "$repo").ws/ws_$slug"',
    'mkdir -p "$workspace/.jj"',
    'if [ "$FAKE_WS_CHATTER" = "yes" ]; then',
    '  chatter="30 packages installed …\n$HOME/consumer.ws/ws_fleet-line-real\'"',
    '  if [ "$json" = "yes" ]; then printf "%s\\n" "$chatter" >&2; else printf "%s\\n" "$chatter"; exit 0; fi',
    "fi",
    'if [ "$FAKE_WS_INVALID" = "yes" ]; then echo "invalid workspace response"; exit 0; fi',
    'if [ "$json" = "yes" ]; then printf \'{"workspace":"%s"}\\n\' "$workspace"; else printf \'%s\\n\' "$workspace"; fi',
  ]);
  shim("jj", [
    'case " $* " in *" workspace list "*) printf \'"%s"\\n\' "${FAKE_REGISTERED_WORKSPACE:-$FAKE_REPO}"; exit 0 ;; esac',
    'case " $* " in *"--name recorded"*) printf "%s\\n" "${FAKE_REGISTERED_WORKSPACE:-$FAKE_REPO}"; exit 0 ;; esac',
    'case " $* " in *" log "*) printf "%s\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0 ;; esac',
    'case "$PWD" in',
    '  "$FAKE_REPO".ws/*) printf \'%s\\n\' "${FAKE_WORKSPACE_REPO:-$FAKE_REPO}" ;;',
    "  *) printf '%s\\n' \"$FAKE_REPO\" ;;",
    "esac",
  ]);
  shim("systemctl", [
    'if [ "$FAKE_ACTIVE_POLLS" != "" ]; then',
    '  active_count="$(cat "$FAKE_ACTIVE_COUNT" 2>/dev/null || echo 0)"',
    '  if [ "$active_count" -lt "$FAKE_ACTIVE_POLLS" ]; then',
    '    echo "$((active_count + 1))" > "$FAKE_ACTIVE_COUNT"',
    "    exit 0",
    "  fi",
    "fi",
    'if [ "$FAKE_ACTIVE" = "yes" ]; then exit 0; fi',
    "exit 3",
  ]);
  shim("systemd-run", ['exec bun "$FAKE_SYSTEMD_RUN_SCRIPT" "$@"']);
  shim("agx-worker", [
    'if [ "$1" = "ls" ]; then',
    '  if [ "$FAKE_LATE_RECORD" = "yes" ]; then',
    '    if [ ! -e "$FAKE_LS_MARKER" ]; then touch "$FAKE_LS_MARKER"',
    '    elif [ -s "$FAKE_PENDING_RECORD" ]; then cp "$FAKE_PENDING_RECORD" "$FAKE_RECORDS"; : > "$FAKE_PENDING_RECORD"; fi',
    "  fi",
    '  cat "$FAKE_RECORDS"; exit 0',
    "fi",
    'if [ "$1" = "check" ]; then if [ "$FAKE_CHECK_FAIL" = "yes" ]; then printf "agx: invalid writes; repair: use relative globs\\nagx: untrusted mise.toml; repair: mise trust\\n" >&2; exit 2; fi; exit 0; fi',
    'echo "unexpected fake agx command: $*" >&2',
    "exit 2",
  ]);
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv(),
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    AGX_STATE_DIR: join(home, "state", "agx"),
    CLAUDE_CODE_SESSION_ID: "fixture-claude",
    CODEX_SESSION_ID: "fixture-codex",
    FAKE_WORKER_COMMAND: join(bin, "agx-worker"),
    FAKE_REPO: repo,
    FAKE_RECORDS: records,
    FAKE_PENDING_RECORD: join(root, "pending-record.json"),
    FAKE_LS_MARKER: join(root, "ls-marker"),
    FAKE_UNIT_ARGS: unitArgs,
    FAKE_BINDING: bindingFile,
    FAKE_WS_ARGS: wsArgs,
    FAKE_SYSTEMD_RUN_SCRIPT: systemdRunner,
    AGX_DISPATCH_WAIT_MS: "10",
  };
  return {
    root,
    repo,
    ticket,
    records,
    unitArgs,
    bindingFile,
    entry,
    wsArgs,
    env,
  };
}

async function invoke(f: ReturnType<typeof fixture>, ...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, f.entry, "dispatch", f.ticket, ...args],
    {
      cwd: f.env.FAKE_CALLER_CWD ?? f.repo,
      env: f.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: Number(f.env.FAKE_INVOKE_TIMEOUT_MS ?? 5000),
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function priorRun(
  f: ReturnType<typeof fixture>,
  workspace: string,
  fallback = false,
) {
  mkdirSync(join(workspace, ".jj"), { recursive: true });
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "prior-run",
        ticket: "foo-bar",
        state: "ended",
        cwd: workspace,
        ...(fallback ? {} : { workspace }),
      },
    ]),
  );
  f.env.FAKE_REGISTERED_WORKSPACE = workspace;
  return workspace;
}

test("continuation ignores a deleted registered sibling but refuses its own missing workspace", async () => {
  const f = fixture();
  // Keep systemd and the worker fake, but exercise the actual jj registry.
  rmSync(join(f.root, "bin", "jj"));
  rmSync(join(f.repo, ".jj"), { recursive: true });
  const jj = (...args: string[]) => {
    const result = Bun.spawnSync(["jj", ...args], {
      cwd: f.repo,
      env: f.env,
      timeout: 5000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  jj("git", "init", ".");
  const workspace = join(`${f.repo}.ws`, "ws_recorded");
  const sibling = join(f.root, "deleted-sibling");
  mkdirSync(`${f.repo}.ws`);
  jj("workspace", "add", "--name", "z-recorded", workspace);
  jj("workspace", "add", "--name", "a-deleted", sibling);
  priorRun(f, workspace);
  rmSync(sibling, { recursive: true });
  expect(
    jj("--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\n"'),
  ).toContain("a-deleted");
  const resumed = await invoke(f, "--continue", "prior-run");
  expect(resumed.exitCode, resumed.stderr).toBe(0);
  expect(await Bun.file(f.unitArgs).text()).toContain(`--cd\n${workspace}\n`);
  expect(await Bun.file(f.wsArgs).exists()).toBe(false);

  priorRun(f, workspace);
  rmSync(workspace, { recursive: true });
  rmSync(f.unitArgs);
  const missing = await invoke(f, "--continue", "prior-run");
  expect(missing.exitCode, missing.stderr).toBe(2);
  expect(missing.stderr).toContain(workspace);
  expect(missing.stdout).toBe("");
  expect(await Bun.file(f.unitArgs).exists()).toBe(false);
});

test.each(["foo-bar", "foo-bar-2", "another-ticket"])(
  "continuation keeps recorded workspace %s without creating one",
  async (slug) => {
    const f = fixture();
    const workspace = priorRun(f, join(`${f.repo}.ws`, `ws_${slug}`));
    const result = await invoke(f, "--continue", "prior-run");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await Bun.file(f.unitArgs).text()).toContain(`--cd\n${workspace}\n`);
    expect(await Bun.file(f.unitArgs).text()).toContain(
      "--continue\nprior-run\n",
    );
    expect(await Bun.file(f.wsArgs).exists()).toBe(false);
  },
);

test("continuation resolves a unique run id prefix before reading its workspace", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "aa94ee5d12345678",
        ticket: "foo-bar",
        state: "ended",
        cwd: workspace,
        workspace,
      },
    ]),
  );
  const result = await invoke(f, "--continue", "aa94ee5d");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await Bun.file(f.unitArgs).text()).toContain(`--cd\n${workspace}\n`);
  expect(await Bun.file(f.unitArgs).text()).toContain(
    "--continue\naa94ee5d12345678\n",
  );
});

test("continuation waits for an active prior unit, then reports timeout state", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "prior-run",
        ticket: "foo-bar",
        state: "running",
        cwd: workspace,
        workspace,
        unit: "agt_prior-worker",
      },
    ]),
  );
  f.env.FAKE_ACTIVE = "yes";
  f.env.AGX_DISPATCH_CONTINUE_WAIT_MS = "0";
  const result = await invoke(f, "--continue", "prior-run");
  expect(result.exitCode).toBe(75);
  expect(result.stderr).toContain(
    "waiting for run prior-run, unit agt_prior-worker.service",
  );
  expect(result.stderr).toContain(
    "timed out waiting for run prior-run, unit agt_prior-worker.service",
  );
  expect(result.stderr).toContain("remaining state=running");
  expect(await Bun.file(f.unitArgs).exists()).toBe(false);
});

test("continuation starts after its active prior unit ends", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "prior-run",
        ticket: "foo-bar",
        state: "running",
        cwd: workspace,
        workspace,
        unit: "agt_prior-worker",
      },
    ]),
  );
  f.env.FAKE_ACTIVE_POLLS = "2";
  f.env.FAKE_ACTIVE_COUNT = join(f.root, "active-polls");
  f.env.AGX_DISPATCH_CONTINUE_WAIT_MS = "2500";
  const result = await invoke(f, "--continue", "prior-run");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain(
    "waiting for run prior-run, unit agt_prior-worker.service",
  );
  expect(await Bun.file(f.unitArgs).exists()).toBe(true);
});

test("a second continuation is refused with the existing continuation while the first waits", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "prior-run",
        ticket: "foo-bar",
        state: "running",
        cwd: workspace,
        workspace,
        unit: "agt_prior-worker",
      },
    ]),
  );
  f.env.FAKE_ACTIVE = "yes";
  f.env.AGX_DISPATCH_CONTINUE_WAIT_MS = "3000";
  const first = Bun.spawn(
    [
      process.execPath,
      f.entry,
      "dispatch",
      f.ticket,
      "--continue",
      "prior-run",
    ],
    { cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  const lock = join(
    f.env.AGX_STATE_DIR!,
    "continuations",
    `${createHash("sha256").update("prior-run").digest("hex")}.json`,
  );
  const deadline = performance.now() + 1000;
  while (!existsSync(lock) && performance.now() < deadline) await Bun.sleep(10);
  const second = await invoke(f, "--continue", "prior-run");
  expect(second.exitCode).toBe(2);
  expect(second.stderr).toContain(
    "continuation of that run is already starting or running",
  );
  expect(second.stderr).toContain("agt_prior-worker.service");
  first.kill();
  await Promise.all([
    first.exited,
    new Response(first.stdout).text(),
    new Response(first.stderr).text(),
  ]);
});

test("an already-running continuation is named and refused", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "prior-run",
        ticket: "foo-bar",
        state: "ended",
        cwd: workspace,
        workspace,
      },
      {
        id: "active-continuation",
        ticket: "foo-bar",
        state: "running",
        cwd: workspace,
        workspace,
        unit: "agt_active-continuation",
        continues: "prior-run",
      },
    ]),
  );
  const result = await invoke(f, "--continue", "prior-run");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(
    "continuation active-continuation is already running",
  );
  expect(result.stderr).toContain("agt_active-continuation.service");
  expect(await Bun.file(f.unitArgs).exists()).toBe(false);
});

test("continuation refuses ambiguous and unknown prefixes with run candidates", async () => {
  const f = fixture();
  const workspace = join(`${f.repo}.ws`, "ws_foo-bar");
  mkdirSync(workspace, { recursive: true });
  const records = ["aa94ee5d12345678", "aa94ee5d87654321"].map((id) => ({
    id,
    ticket: "foo-bar",
    state: "ended",
    cwd: workspace,
    workspace,
  }));
  writeFileSync(f.records, JSON.stringify(records));
  for (const [selector, candidates] of [
    ["aa94ee5d", records.map((row) => row.id)],
    ["missing", records.map((row) => row.id)],
  ] as const) {
    const result = await invoke(f, "--continue", selector);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    for (const candidate of candidates) expect(lines[0]).toContain(candidate);
    expect(await Bun.file(f.unitArgs).exists()).toBe(false);
  }
});

test.each([undefined, ""])(
  "continuation of a run --cd falls back to recorded cwd (%s)",
  async (recordedWorkspace) => {
    const f = fixture();
    const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_other"), true);
    writeFileSync(
      f.records,
      JSON.stringify([
        {
          id: "prior-run",
          ticket: "foo-bar",
          state: "ended",
          cwd: workspace,
          workspace: recordedWorkspace,
        },
      ]),
    );
    const result = await invoke(f, "--continue", "prior-run");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await Bun.file(f.unitArgs).text()).toContain(`--cd\n${workspace}\n`);
    expect(await Bun.file(f.wsArgs).exists()).toBe(false);
  },
);

test("recorded workspace takes precedence over a different cwd", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_other"));
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "prior-run",
        ticket: "foo-bar",
        state: "ended",
        cwd: f.repo,
        workspace,
      },
    ]),
  );
  const result = await invoke(f, "--continue", "prior-run");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await Bun.file(f.unitArgs).text()).toContain(`--cd\n${workspace}\n`);
  expect(await Bun.file(f.wsArgs).exists()).toBe(false);
});

test("continuation accepts --ws only when it names the recorded workspace", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_other"));
  const result = await invoke(f, "--continue", "prior-run", "--ws", "other");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await Bun.file(f.unitArgs).text()).toContain(`--cd\n${workspace}\n`);
  expect(await Bun.file(f.wsArgs).exists()).toBe(false);
});

test.each(["conflict", "missing", "unregistered", "foreign", "file"])(
  "continuation refuses %s recorded workspace without starting or creating",
  async (kind) => {
    const f = fixture();
    const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_other"));
    if (kind === "missing") rmSync(workspace, { recursive: true });
    if (kind === "unregistered" || kind === "foreign")
      f.env.FAKE_REGISTERED_WORKSPACE = f.repo;
    if (kind === "foreign") f.env.FAKE_WORKSPACE_REPO = join(f.root, "foreign");
    if (kind === "file") {
      rmSync(workspace, { recursive: true });
      writeFileSync(workspace, "not a directory");
    }
    const result = await invoke(
      f,
      "--continue",
      "prior-run",
      ...(kind === "conflict" ? ["--ws", "foo-bar"] : []),
    );
    expect(result.exitCode, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(workspace);
    expect(result.stderr).toContain("repair:");
    expect(result.stderr).toContain(
      kind === "conflict" ? "different workspace" : "agx ws add",
    );
    expect(await Bun.file(f.wsArgs).exists()).toBe(false);
    expect(await Bun.file(f.unitArgs).exists()).toBe(false);
  },
);

test("dispatch records its one ticket-derived binding", async () => {
  const f = fixture();
  const result = await invoke(f);
  const workspace = join(`${f.repo}.ws`, "ws_foo-bar");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const recordResult = jsonOf(z.array(RunRecord)).safeParse(
    await Bun.file(f.records).text(),
  );
  const bindingResult = jsonOf(DispatchBindingSchema).safeParse(
    await Bun.file(f.bindingFile).text(),
  );
  expect(recordResult.success).toBe(true);
  expect(bindingResult.success).toBe(true);
  if (!recordResult.success || !bindingResult.success) return;
  const [record] = recordResult.data;
  expect(result.stdout).toStartWith(`${bindingResult.data.id} workspace=`);
  expect(result.stdout).toContain(
    `workspace=${JSON.stringify(workspace)} row=fixture-high route=codex model=fixture-model effort=high sandbox=workspace-write sandbox_source="built-in default"`,
  );
  expect(bindingResult.data).toMatchObject({
    ticket: "foo-bar",
    workspace,
    unit: "agt_foo-bar",
  });
  expect(record).toMatchObject({ ...bindingResult.data, cwd: workspace });
  const args = await Bun.file(f.unitArgs).text();
  expect(args).toContain("--unit=agt_foo-bar\n");
  expect(args).toContain(`${f.ticket}\n--cd\n${workspace}\n`);
  expect(args).toContain("KillMode=mixed\n-p\nTimeoutStopSec=60\n");
  expect(await Bun.file(f.wsArgs).text()).toContain("--reuse");
});

test("workspace and unit overrides are honored even when they differ from the ticket", async () => {
  const f = fixture();
  const result = await invoke(f, "--ws", "other", "--unit", "agt_other-2");
  const workspace = join(`${f.repo}.ws`, "ws_other");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = jsonOf(z.array(RunRecord)).safeParse(
    await Bun.file(f.records).text(),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const runId = result.stdout.trim().split(" ")[0];
  if (runId === undefined) expect.unreachable("dispatch output has no run ID");
  expect(parsed.data[0]).toMatchObject({
    id: runId,
    ticket: "foo-bar",
    workspace,
    cwd: workspace,
    unit: "agt_other-2",
  });
  expect(await Bun.file(f.unitArgs).text()).toContain("--unit=agt_other-2\n");
  expect(await Bun.file(f.wsArgs).text()).toContain("other\n");
});

test("dispatch refuses an already-active overridden unit by its name", async () => {
  const f = fixture();
  f.env.FAKE_ACTIVE = "yes";
  const result = await invoke(f, "--unit", "agt_other-2");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("agt_other-2.service is already running");
});

test("dispatch reports the cause when a unit does not start", async () => {
  const f = fixture();
  f.env.FAKE_START_FAIL = "yes";
  const result = await invoke(f);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("agt_foo-bar.service did not start");
  expect(result.stderr).toContain("fixture unit failure");
});

test("dispatch refuses success when no run record appears", async () => {
  const f = fixture();
  f.env.FAKE_NO_RECORD = "yes";
  const result = await invoke(f);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("agt_foo-bar.service");
  expect(result.stderr).toContain(
    "no matching run record appeared within 10ms",
  );
});

test("dispatch finds a run record that appears after the first read", async () => {
  const f = fixture();
  f.env.FAKE_LATE_RECORD = "yes";
  f.env.AGX_DISPATCH_WAIT_MS = "1000";
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  const parsedBinding = jsonOf(DispatchBindingSchema).safeParse(
    await Bun.file(f.bindingFile).text(),
  );
  expect(parsedBinding.success).toBe(true);
  if (!parsedBinding.success) return;
  expect(result.stdout).toStartWith(`${parsedBinding.data.id} workspace=`);
  expect(result.stderr).toBe("");
});

test("dispatch refuses a ticket and workspace from different repositories", async () => {
  const f = fixture();
  const otherRepo = join(f.root, "other-repo");
  f.env.FAKE_WORKSPACE_REPO = otherRepo;
  const result = await invoke(f);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(`ticket repository ${f.repo}`);
  expect(result.stderr).toContain(`workspace repository ${otherRepo}`);
  expect(result.stdout).toBe("");
});

test("dispatch resolves the ticket repository from an unrelated caller cwd", async () => {
  const f = fixture();
  f.env.FAKE_CALLER_CWD = f.root;
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  const runId = result.stdout.trim().split(" ")[0];
  if (runId === undefined) expect.unreachable("dispatch output has no run ID");
  expect(runId).not.toBe("");
  expect(await Bun.file(f.wsArgs).text()).toContain(`--repo\n${f.repo}\n`);
  expect(await Bun.file(f.records).text()).toContain(runId);
});

test("dispatch uses machine output when readiness prints the reported install chatter and stray quote", async () => {
  const f = fixture();
  f.env.FAKE_WS_CHATTER = "yes";
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  const runId = result.stdout.trim().split(" ")[0];
  if (runId === undefined) expect.unreachable("dispatch output has no run ID");
  expect(runId).not.toBe("");
  expect(await Bun.file(f.wsArgs).text()).toContain("--json\n");
  expect(await Bun.file(f.records).text()).toContain(runId);
  expect(await Bun.file(f.unitArgs).text()).toContain(
    `${f.repo}.ws/ws_foo-bar\n`,
  );
});

test.each([
  [
    "FAKE_WS_FAIL",
    "agx ws add failed: ws: fixture-home is not a valid local jj workspace",
  ],
  ["FAKE_WS_INVALID", "agx ws add returned an invalid workspace"],
])(
  "dispatch names the cause and fails without starting a unit: %s",
  async (flag, cause) => {
    const f = fixture();
    f.env[flag] = "yes";
    const result = await invoke(f);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(cause);
    expect(result.stdout).toBe("");
    expect(await Bun.file(f.unitArgs).exists()).toBe(false);
    expect(await Bun.file(f.records).text()).toBe("[]\n");
  },
);

test("dispatch reports service and all check failures before starting a unit", async () => {
  const f = fixture();
  f.env.FAKE_ACTIVE = "yes";
  f.env.FAKE_CHECK_FAIL = "yes";
  const result = await invoke(f);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("already running");
  expect(result.stderr).toContain("invalid writes; repair:");
  expect(result.stderr).toContain("untrusted mise.toml; repair:");
  expect(await Bun.file(f.unitArgs).exists()).toBe(false);
});

test("dispatch relays successful preflight warnings before launch without upgrading sandbox", async () => {
  const f = fixture();
  const worker = join(f.root, "bin/agx-worker");
  const original = await Bun.file(worker).text();
  await Bun.write(
    worker,
    original.replace(
      'if [ "$1" = "check" ]; then',
      'if [ "$1" = "check" ]; then printf "WARN sandbox capability=user-systemd-bus; requested=workspace-write; evidence=verify[0]: systemctl --user status fixture; allows=none; sandbox unchanged\\n" >&2;',
    ),
  );
  const result = await invoke(f, "--sandbox", "workspace-write");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain("WARN sandbox capability=user-systemd-bus");
  const args = (await Bun.file(f.unitArgs).text()).split("\n");
  expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
});

test("preflight refusal identifies the checked tree, revision and child exit", async () => {
  const f = fixture();
  priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  f.env.FAKE_CHECK_FAIL = "yes";
  const result = await invoke(
    f,
    "--continue",
    "prior-run",
    "--sandbox",
    "none",
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain(`--cd ${f.repo}.ws/ws_foo-bar`);
  expect(result.stderr).toContain("@/base_rev=");
  expect(result.stderr).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(result.stderr).toContain("check exit=2");
  expect(result.stderr).toContain("invalid writes");
});

test("a silent preflight refusal still identifies its child exit and tree", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "bin/agx-worker"), "#!/bin/sh\nexit 7\n");
  const result = await invoke(f);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("check exit=7");
  expect(result.stderr).toContain("no stderr");
  expect(result.stderr).toContain(`--cd ${f.repo}.ws/ws_foo-bar`);
});

test("preflight can finish beyond the former 30000ms subprocess deadline", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "bin/agx-worker"),
    `#!/usr/bin/env bun
if (Bun.argv[2] === "check") {
  await Bun.sleep(30_100);
  console.error("fixture slow check refusal");
  process.exit(2);
}
process.exit(1);
`,
  );
  const child = Bun.spawn([process.execPath, f.entry, "dispatch", f.ticket], {
    cwd: f.repo,
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 40_000,
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(2);
  expect(stderr).toContain("fixture slow check refusal");
  expect(stderr).toContain("check exit=2");
  expect(await Bun.file(f.unitArgs).exists()).toBe(false);
}, 45_000);

test.each([
  ["foo-bar", false],
  ["foo-bar-2", false],
  ["another-ticket", false],
  ["foo-bar-2", true],
] as const)(
  "real jj continued workspace %s agrees with check (missing premise=%s)",
  async (workspaceName, missingPremise) => {
    const f = fixture();
    f.env.AGX_CONFIG = fileURLToPath(
      new URL("../src/roster/policy.example.toml", import.meta.url),
    );
    f.env.AGX_DISPATCH_WAIT_MS = "1000";
    f.env.FAKE_INVOKE_TIMEOUT_MS = "45000";
    const jj = Bun.which("jj");
    expect(jj).not.toBeNull();
    if (jj === null) return;
    rmSync(join(f.repo, ".jj"), { recursive: true });
    f.env.JJ_CONFIG = "";
    f.env.JJ_USER = "Fixture";
    f.env.JJ_EMAIL = "fixture@example.invalid";
    const jjCommand = async (...args: string[]) => {
      const child = Bun.spawn([jj, ...args], {
        cwd: f.repo,
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, err).toBe(0);
      return out.trim();
    };
    await jjCommand("git", "init", ".");
    await jjCommand(
      "config",
      "set",
      "--repo",
      'revset-aliases."trunk()"',
      "bookmarks(main)",
    );
    writeFileSync(
      join(f.repo, "agx.toml"),
      'schema = 1\ntickets = ".agents/tickets"\n',
    );
    writeFileSync(join(f.repo, "main-only"), "present only in main checkout\n");
    await jjCommand("new", "-m", "Fixture policy");
    await jjCommand("bookmark", "create", "main", "-r", "@-");
    const workspace = join(`${f.repo}.ws`, `ws_${workspaceName}`);
    mkdirSync(`${f.repo}.ws`, { recursive: true });
    await jjCommand(
      "workspace",
      "add",
      "--name",
      workspaceName,
      "-r",
      "root()",
      workspace,
    );
    writeFileSync(join(f.root, "bin/jj"), `#!/bin/sh\nexec '${jj}' "$@"\n`);
    writeFileSync(
      f.ticket,
      `+++\nschema = 2\nwrites = []\nname = "foo-bar"\noutcome = "fixture"\npremises = ${missingPremise ? '["file:main-only"]' : "[]"}\n[proposition]\nid = "P1"\nclaim = "fixture"\nrefuted_by = "fixture"\n+++\n`,
    );
    const state = f.env.AGX_STATE_DIR;
    if (state === undefined)
      expect.unreachable("state fixture path is missing");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "records.jsonl"),
      [
        {
          kind: "started",
          id: "prior-run",
          at: "2026-10-14T01:00:00Z",
          ticket: "foo-bar",
          ticket_path: f.ticket,
          writes: [],
          cwd: workspace,
          workspace,
          row: "terra-high",
          dispatcher_session: null,
          vendor_session: null,
          pid: 0,
        },
        {
          kind: "ended",
          id: "prior-run",
          at: "2026-10-14T01:10:00Z",
          exit: 0,
          report_path: null,
          vendor_session: "fixture-session",
          verify: [],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    writeFileSync(
      f.records,
      JSON.stringify([
        {
          id: "prior-run",
          ticket: "foo-bar",
          state: "ended",
          cwd: workspace,
          workspace,
        },
      ]),
    );
    const checkArgs = [
      "check",
      f.ticket,
      "--cd",
      workspace,
      "--sandbox",
      "none",
      "--continue",
      "prior-run",
    ];
    const checked = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, ENTRY, ...args], {
        cwd: f.repo,
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, out, err };
    };
    const main = await checked([
      "check",
      f.ticket,
      "--cd",
      f.repo,
      "--sandbox",
      "none",
      "--continue",
      "prior-run",
    ]);
    expect(main.code, main.err).toBe(0);
    const direct = await checked(checkArgs);
    expect(direct.code, direct.err).toBe(missingPremise ? 2 : 0);
    const checkArgv = join(f.root, "check-argv.json");
    writeFileSync(
      join(f.root, "bin/agx-worker"),
      `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args[0] === "check") {
  await Bun.write(${JSON.stringify(checkArgv)}, JSON.stringify(args));
  const child = Bun.spawn([process.execPath, ${JSON.stringify(ENTRY)}, ...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
console.log(await Bun.file(${JSON.stringify(f.records)}).text());
`,
    );
    const before = await jjCommand(
      "--ignore-working-copy",
      "log",
      "-r",
      `${workspaceName}@`,
      "--no-graph",
      "-T",
      "commit_id",
    );
    const result = await invoke(
      f,
      "--sandbox",
      "none",
      "--continue",
      "prior-run",
    );
    expect(result.exitCode, result.stderr).toBe(direct.code);
    const observedArgs = jsonOf(z.array(z.string())).safeParse(
      await Bun.file(checkArgv).text(),
    );
    expect(observedArgs.success).toBe(true);
    expect(observedArgs.data).toEqual(checkArgs);
    expect(await Bun.file(join(workspace, ".agx.toml")).exists()).toBe(false);
    expect(await Bun.file(join(workspace, "agx.toml")).exists()).toBe(false);
    expect(
      await jjCommand(
        "--ignore-working-copy",
        "log",
        "-r",
        `${workspaceName}@`,
        "--no-graph",
        "-T",
        "commit_id",
      ),
    ).toBe(before);
    if (missingPremise) {
      expect(result.stderr).toContain(`--cd ${workspace} @/base_rev=${before}`);
      expect(result.stderr).toContain("check exit=2");
      expect(result.stderr).toContain("file:main-only: file does not exist");
      expect(await Bun.file(f.unitArgs).exists()).toBe(false);
    }
  },
  60_000,
);

test.each(["check", "ls"])(
  "dispatch propagates temporary %s failure without a verdict",
  async (command) => {
    const f = fixture();
    writeFileSync(
      join(f.root, "bin/agx-worker"),
      `#!/bin/sh
if [ "$1" = "${command}" ]; then
  echo 'inspection timeout TEST_INSPECTION_MS=60000ms; command=["agx-worker","${command}"]; cwd=${f.repo}' >&2
  exit 75
fi
if [ "$1" = "check" ]; then exit 0; fi
cat "$FAKE_RECORDS"
`,
    );
    const result = await invoke(f);
    expect(result.exitCode).toBe(75);
    expect(result.stderr).toContain("TEST_INSPECTION_MS=60000ms");
    expect(result.stderr).not.toContain("preflight failed");
    expect(await Bun.file(f.unitArgs).exists()).toBe(false);
  },
);

test("dispatch check deadline is an operational timeout with exit 75", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "bin/agx-worker"),
    `#!/usr/bin/env bun
if (Bun.argv[2] === "check") {
  await Bun.sleep(65_000);
  console.error("late check verdict");
  process.exit(2);
}
process.exit(1);
`,
  );
  const child = Bun.spawn([process.execPath, f.entry, "dispatch", f.ticket], {
    cwd: f.repo,
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 70_000,
  });
  const [code, err] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(75);
  expect(err).toContain("DISPATCH_CHECK_TIMEOUT_MS=60000ms");
  expect(err).toContain(
    JSON.stringify([process.execPath, f.entry, "check"]).slice(0, -1),
  );
  expect(err).toContain(`cwd=${f.repo}`);
  expect(err).not.toContain("preflight failed");
  expect(err).not.toContain("late check verdict");
  expect(err.trim().split("\n")).toHaveLength(1);
  expect(await Bun.file(f.unitArgs).exists()).toBe(false);
}, 75_000);

test("dispatch inspection helpers distinguish expiry from a completed failure", async () => {
  const { invoke: inspect, invokeReadonly } =
    await import("../src/dispatch.ts");
  const f = fixture();
  const slow = [process.execPath, "-e", "await Bun.sleep(5000)"];
  const expiredList = await inspect(
    slow,
    f.repo,
    f.env,
    20,
    "DISPATCH_LIST_TIMEOUT_MS",
  );
  expect(expiredList.code).toBe(75);
  expect(expiredList.err).toContain("DISPATCH_LIST_TIMEOUT_MS=20ms");
  const expiredTree = await invokeReadonly(slow, f.repo, f.env, 20);
  expect(expiredTree.code).toBe(75);
  expect(expiredTree.err).toContain("DISPATCH_TREE_READ_TIMEOUT_MS=20ms");
  const completed = await inspect(
    [
      process.execPath,
      "-e",
      'console.error("completed refusal"); process.exit(2)',
    ],
    f.repo,
    f.env,
    2000,
    "DISPATCH_CHECK_TIMEOUT_MS",
  );
  expect(completed.code).toBe(2);
  expect(completed.err).toContain("completed refusal");
});

test("source dispatch pins bun, absolute source entry and dispatcher PATH", async () => {
  const f = fixture();
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  const args = (await Bun.file(f.unitArgs).text()).trimEnd().split("\n");
  expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 4)).toEqual([
    process.execPath,
    f.entry,
    "run",
  ]);
  expect(args).toContain(`--setenv=PATH=${f.env.PATH}`);
  expect(args).toContain("--setenv=AGX_WORKER_PATH_SOURCE=dispatcher");
});

test("compiled dispatcher outside manager PATH pins its own executable", async () => {
  const f = fixture();
  const executable = join(f.root, "mise install", "bin", "agx-worker");
  const built = Bun.spawnSync(
    [process.execPath, "build", "--compile", f.entry, "--outfile", executable],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const child = Bun.spawn([executable, "dispatch", f.ticket], {
    cwd: f.repo,
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, err).toBe(0);
  expect(out.trim()).not.toBe("");
  const args = (await Bun.file(f.unitArgs).text()).trimEnd().split("\n");
  expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 3)).toEqual([
    executable,
    "run",
  ]);
  expect(args).toContain(`--setenv=PATH=${f.env.PATH}`);
}, 40_000);

test.each([false, true])(
  "dispatch passes resolved continuation sandbox and provenance (compiled=%s)",
  async (compiled) => {
    const f = fixture();
    priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
    const state = f.env.AGX_STATE_DIR;
    if (state === undefined)
      expect.unreachable("state fixture path is missing");
    mkdirSync(join(state, "runs", "prior-run"), {
      recursive: true,
    });
    writeFileSync(
      join(state, "runs", "prior-run", "prior-run.json"),
      JSON.stringify({ sandbox: "none" }),
    );
    let command = [process.execPath, f.entry];
    if (compiled) {
      const executable = join(f.root, "installed", "agx-worker");
      const built = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          f.entry,
          "--outfile",
          executable,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      expect(built.exitCode, built.stderr.toString()).toBe(0);
      command = [executable];
    }
    for (const item of [
      { flag: [], ticket: undefined, mode: "none", source: "continued run" },
      { flag: [], ticket: "read-only", mode: "read-only", source: "ticket" },
      {
        flag: ["--sandbox", "workspace-write"],
        ticket: "none",
        mode: "workspace-write",
        source: "flag",
      },
    ]) {
      // The fake service replaces its listing, so restore the prior row for each dispatch.
      priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
      const ticket = `+++\nschema = 2\nwrites = []\nname = "foo-bar"\noutcome = "fixture"\n${item.ticket === undefined ? "" : `sandbox = "${item.ticket}"\n`}[proposition]\nid = "P1"\nclaim = "fixture"\nrefuted_by = "fixture"\n+++\n`;
      writeFileSync(f.ticket, ticket);
      const child = Bun.spawn(
        [
          ...command,
          "dispatch",
          f.ticket,
          "--continue",
          "prior-run",
          ...item.flag,
        ],
        {
          cwd: f.repo,
          env: f.env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      const [exit, , err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, err).toBe(0);
      const args = (await Bun.file(f.unitArgs).text()).trimEnd().split("\n");
      expect(args[args.indexOf("--sandbox") + 1]).toBe(item.mode);
      expect(args[args.indexOf("--sandbox-source") + 1]).toBe(item.source);
    }
  },
  40_000,
);

test.each([undefined, ""])(
  "dispatch refuses missing PATH (%s) in one line",
  async (path) => {
    const f = fixture();
    // Run a source wrapper so the actual stderr and exit contract is exercised.
    const probe = join(f.root, "missing-path.ts");
    writeFileSync(
      probe,
      `import { dispatch } from ${JSON.stringify(fileURLToPath(new URL("../src/dispatch.ts", import.meta.url)))}; process.exitCode = await dispatch({ ticketPath: ${JSON.stringify(f.ticket)}, env: ${JSON.stringify(path === undefined ? {} : { PATH: path })} });`,
    );
    const result = Bun.spawnSync([process.execPath, probe], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "agx worker dispatch: dispatcher PATH is missing; set PATH before dispatch\n",
    );
    expect(await Bun.file(f.unitArgs).exists()).toBe(false);
  },
);

test("dispatch --json exposes the recorded execution receipt", async () => {
  const f = fixture();
  const result = await invoke(f, "--json", "--ws", "receipt");
  expect(result.exitCode, result.stderr).toBe(0);
  const receipt = jsonOf(
    z.looseObject({
      id: z.string(),
      workspace: z.string(),
      row: z.string(),
      route: z.string(),
      model: z.string(),
      effort: z.string(),
      sandbox: z.string(),
      sandbox_source: z.string(),
      sandbox_effective: z.string(),
      sandbox_effective_source: z.string(),
    }),
  ).safeParse(result.stdout);
  expect(receipt.success).toBe(true);
  if (!receipt.success) return;
  expect(receipt.data).toMatchObject({
    workspace: join(`${f.repo}.ws`, "ws_receipt"),
    row: "fixture-high",
    route: "codex",
    model: "fixture-model",
    effort: "high",
    sandbox: "workspace-write",
    sandbox_source: "built-in default",
    sandbox_effective: "workspace-write",
    sandbox_effective_source: "built-in default",
  });
});
