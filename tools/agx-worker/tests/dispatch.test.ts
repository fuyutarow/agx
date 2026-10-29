import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DispatchBindingSchema } from "../../shared/src/agx-dispatch-binding.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { DISPATCH_COMMAND_TIMEOUT_MS } from "../src/dispatch.ts";
import {
  BOUND_CLAUDE_TARGET_ENV,
  encodeBoundClaudeTarget,
} from "../../xmsg/src/claude-target.ts";

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
      'const divider = args.indexOf("--");',
      "const command = args.slice(divider + 1);",
      'const bindingIndex = command.indexOf("--dispatch-binding");',
      "const bindingText = command[bindingIndex + 1];",
      "const binding = JSON.parse(bindingText!);",
      "writeFileSync(process.env.FAKE_BINDING!, bindingText!);",
      'if (process.env.FAKE_ASSERT_PRELAUNCH_RECORD === "yes") {',
      '  const path = process.env.AGX_STATE_DIR! + "/records.jsonl";',
      '  const events = (await Bun.file(path).text()).trim().split("\\n").map((line) => JSON.parse(line));',
      '  if (!events.some((event: { kind?: string; id?: string }) => event.kind === "dispatching" && event.id === binding.id)) { process.stderr.write("dispatch reservation missing before systemd-run\\n"); process.exit(98); }',
      "}",
      'if (process.env.FAKE_START_FAIL === "yes") {',
      '  process.stderr.write("fixture unit failure\\n");',
      "  process.exit(1);",
      "}",
      'if (process.env.FAKE_NO_RECORD === "yes") process.exit(0);',
      'if (process.env.FAKE_ROSTER_CHECK === "yes") {',
      "  const env: Record<string, string> = { HOME: process.env.HOME!, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!, XDG_STATE_HOME: process.env.XDG_STATE_HOME! };",
      "  for (let i = 0; i < divider; i++) {",
      '    if (args[i] !== "-E") continue;',
      "    const entry = args[++i]!;",
      '    const equal = entry.indexOf("=");',
      "    if (equal >= 0) env[entry.slice(0, equal)] = entry.slice(equal + 1);",
      "    else if (process.env[entry] !== undefined) env[entry] = process.env[entry]!;",
      "  }",
      '  if (process.env.FAKE_STALE_ROSTER === "yes") await Bun.write(process.env.DISPATCH_ROSTER_PATH!, "invalid TOML [");',
      '  const child = Bun.spawn([process.execPath, process.env.FAKE_ROSTER_SCRIPT!], { cwd: process.env.HOME!, env, stdout: "pipe", stderr: "pipe", timeout: 5000 });',
      "  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);",
      "  if (code !== 0) { process.stderr.write(err); process.exit(code); }",
      "  writeFileSync(process.env.FAKE_CHILD_ROSTER!, out);",
      "}",
      'const cdIndex = command.indexOf("--cd");',
      "const workspace = command[cdIndex + 1];",
      'const record = JSON.stringify([{ ...binding, state: "running", cwd: workspace, row: "fixture-high", route: "codex", model: "fixture-model", effort: "high", sandbox: "workspace-write", sandbox_source: "built-in default", sandbox_effective: "workspace-write", sandbox_effective_source: "built-in default" }]) + "\\n";',
      "writeFileSync(process.env.FAKE_RECORDS!, record);",
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
    'if [ "$FAKE_WS_SLEEP_SECONDS" != "" ]; then sleep "$FAKE_WS_SLEEP_SECONDS"; fi',
    'if [ "$FAKE_WS_CHATTER" = "yes" ]; then',
    '  chatter="30 packages installed …\n$HOME/consumer.ws/ws_fleet-line-real\'"',
    '  if [ "$json" = "yes" ]; then printf "%s\\n" "$chatter" >&2; else printf "%s\\n" "$chatter"; exit 0; fi',
    "fi",
    'if [ "$FAKE_WS_INVALID" = "yes" ]; then echo "invalid workspace response"; exit 0; fi',
    'if [ "$json" = "yes" ]; then printf \'{"workspace":"%s"}\\n\' "$workspace"; else printf \'%s\\n\' "$workspace"; fi',
  ]);
  shim("jj", [
    'if [ "$1" = "--version" ]; then echo "jj 0.46.0"; exit 0; fi',
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
    FAKE_UNIT_ARGS: unitArgs,
    FAKE_BINDING: bindingFile,
    FAKE_WS_ARGS: wsArgs,
    FAKE_WS_SLEEP_SECONDS: "",
    FAKE_SYSTEMD_RUN_SCRIPT: systemdRunner,
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

test("dispatch passes the ticket ACK target to the run as a bound address", async () => {
  const f = fixture();
  writeFileSync(
    f.ticket,
    readFileSync(f.ticket, "utf8").replace(
      "schema = 2",
      'schema = 2\nack_target = "claude:coordinator-peer"',
    ),
  );
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  const bound = encodeBoundClaudeTarget({
    selector: "claude:coordinator-peer",
    address: "claude:coordinator-peer",
  });
  expect(readFileSync(f.unitArgs, "utf8")).toContain(
    `--setenv=${BOUND_CLAUDE_TARGET_ENV}=${bound}`,
  );
});

test("dispatch contract: an unresolvable ACK target never fails the dispatch", async () => {
  const f = fixture();
  const target = "claude:12345678-1234-4123-8123-123456789abc";
  f.env.CLAUDE_CODE_SESSION_ID = target.slice("claude:".length);
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain("ACK will not be delivered by agx msg");
  const args = readFileSync(f.unitArgs, "utf8");
  expect(args).toContain("--setenv=AGX_DISPATCH_ACK_UNBOUND=1");
  expect(args).not.toContain(`--setenv=${BOUND_CLAUDE_TARGET_ENV}=`);
  const event = jsonOf(z.object({ ack: z.object({ status: z.literal("unbound"), target: z.string(), error: z.string().min(1) }) })).safeParse(
    readFileSync(join(f.env.AGX_STATE_DIR!, "records.jsonl"), "utf8").trim().split("\n")[0]!,
  );
  expect(event.success).toBe(true);
  if (event.success) expect(event.data.ack.target).toBe(target);
});

test("dispatch binds its Claude session when the ticket omits an ACK target", async () => {
  const f = fixture();
  f.env.AGX_DISPATCHER_SESSION = undefined;
  const result = await invoke(f);
  expect(result.exitCode, result.stderr).toBe(0);
  const bound = encodeBoundClaudeTarget({
    selector: "claude:fixture-claude",
    address: "claude:fixture-claude",
  });
  expect(readFileSync(f.unitArgs, "utf8")).toContain(
    `--setenv=${BOUND_CLAUDE_TARGET_ENV}=${bound}`,
  );
});

test("dispatch contract: every flag the documentation names for dispatch is accepted", async () => {
  const f = fixture();
  f.env.AGX_DISPATCHER_SESSION = "environment-session";
  const result = await invoke(f, "--session", "explicit-session");
  expect(result.exitCode, result.stderr).toBe(0);
  const eventSchema = z.looseObject({
    dispatcher_session: z.string().nullable().optional(),
  });
  const events = readFileSync(join(f.env.AGX_STATE_DIR!, "records.jsonl"), "utf8")
    .trim()
    .split("\n");
  const dispatchSessions = events.map((line) => {
    const parsed = jsonOf(eventSchema).safeParse(line);
    return parsed.success ? parsed.data.dispatcher_session : undefined;
  });
  expect(dispatchSessions.find((session) => session !== undefined)).toBe(
    "explicit-session",
  );
  const unitArgs = readFileSync(f.unitArgs, "utf8").split("\n");
  const divider = unitArgs.indexOf("--");
  const command = unitArgs.slice(divider + 1);
  expect(command).toContain("--session");
  expect(command[command.indexOf("--session") + 1]).toBe("explicit-session");
});

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

test.each([
  { name: "refused without a change", body: "", timeout: 600, allowed: false },
  {
    name: "allowed after a split",
    body: "Split into: child-one, child-two",
    timeout: 600,
    allowed: true,
  },
  {
    name: "allowed after raising the time box",
    body: "Time box raised: 600 to 1200 for verification",
    timeout: 1200,
    allowed: true,
  },
  {
    name: "refused with only a raise claim",
    body: "Time box raised: still 600",
    timeout: 600,
    allowed: false,
  },
  {
    name: "refused with only a larger timeout",
    body: "",
    timeout: 1200,
    allowed: false,
  },
  {
    name: "refused with an empty split",
    body: "Split into:\nNo child tickets",
    timeout: 600,
    allowed: false,
  },
])("dispatch contract: rule 3 $name", async ({ body, timeout, allowed }) => {
  const f = fixture();
  f.env.FAKE_INVOKE_TIMEOUT_MS = "15000";
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  const original = readFileSync(f.ticket, "utf8").replace(
    "schema = 2",
    "schema = 2\ntimeout_s = 600",
  );
  writeFileSync(
    f.ticket,
    original.replace("timeout_s = 600", `timeout_s = ${timeout}`) + body + "\n",
  );
  const state = f.env.AGX_STATE_DIR!;
  const priorDirectory = join(state, "runs", "timeout-second");
  mkdirSync(priorDirectory, { recursive: true });
  writeFileSync(join(priorDirectory, "ticket.orig.md"), original);
  writeFileSync(
    f.records,
    JSON.stringify([
      {
        id: "timeout-first",
        ticket: "foo-bar",
        state: "ended",
        outcome: "timeout",
        cwd: workspace,
        workspace,
        continues: null,
      },
      {
        id: "timeout-second",
        ticket: "foo-bar",
        state: "ended",
        outcome: "timeout",
        cwd: workspace,
        workspace,
        continues: "timeout-first",
      },
    ]),
  );
  const snapshot = () =>
    [
      ...new Bun.Glob("**/*").scanSync({
        cwd: f.root,
        dot: true,
        onlyFiles: false,
      }),
    ]
      .toSorted()
      .map((path) => {
        const absolute = join(f.root, path);
        const stat = lstatSync(absolute);
        return {
          path,
          mode: stat.mode,
          content: stat.isFile()
            ? readFileSync(absolute).toString("base64")
            : null,
        };
      });
  const before = snapshot();
  const result = await invoke(f, "--continue", "timeout-sec");
  expect(result.exitCode, result.stderr).toBe(allowed ? 0 : 2);
  expect(existsSync(f.wsArgs)).toBe(false);
  expect(existsSync(f.unitArgs)).toBe(allowed);
  if (allowed) {
    expect(result.stderr).toBe("");
    expect(readFileSync(f.unitArgs, "utf8")).toContain(
      "--continue\ntimeout-second\n",
    );
  } else {
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "agx worker dispatch: time-box-lineage: runs timeout-second, timeout-first timed out in one continuation lineage; repair: raise timeout_s above the last timed-out run and add a 'Time box raised:' line, or list split-off tickets on a 'Split into:' line\n",
    );
    expect(snapshot()).toEqual(before);
  }
});

// measured 5026ms on alpha 1.22.5 under host load
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
}, 11000);

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
    `workspace=${JSON.stringify(workspace)} row=unknown route=unknown model=unknown effort=unknown sandbox=workspace-write sandbox_source="built-in default"`,
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

test("dispatch contract: launch failure is recorded before systemd-run and visible in ls", async () => {
  const f = fixture();
  f.env.FAKE_START_FAIL = "yes";
  f.env.FAKE_ASSERT_PRELAUNCH_RECORD = "yes";
  const result = await invoke(f);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  const binding = jsonOf(DispatchBindingSchema).safeParse(readFileSync(f.bindingFile, "utf8"));
  expect(binding.success).toBe(true);
  if (!binding.success) return;
  const id = binding.data.id;
  const listed = Bun.spawnSync(
    [process.execPath, ENTRY, "ls", "--json", "--all"],
    { cwd: f.repo, env: f.env, timeout: 5_000 },
  );
  expect(listed.exitCode, listed.stderr.toString()).toBe(0);
  const runs = jsonOf(
    z.array(
      z.looseObject({
        id: z.string(),
        state: z.string(),
        outcome: z.string().nullable(),
        exit: z.number().nullable(),
        launch_stderr: z.string().optional(),
      }),
    ),
  ).safeParse(listed.stdout.toString());
  expect(runs.success).toBe(true);
  if (!runs.success) return;
  expect(runs.data.find((run) => run.id === id)).toMatchObject({
    state: "ended",
    outcome: "launch-failed",
    exit: 1,
    launch_stderr: "fixture unit failure\n",
  });
  expect(result.stderr).toContain("fixture unit failure");
});

test("worker contract: a unit that fails to start makes dispatch exit non-zero with a recorded reason", async () => {
  const f = fixture();
  f.env.FAKE_START_FAIL = "yes";
  const result = await invoke(f);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("fixture unit failure");
  const events = readFileSync(join(f.env.AGX_STATE_DIR!, "records.jsonl"), "utf8");
  expect(events).toContain('"outcome":"launch-failed"');
  expect(events).toContain("fixture unit failure");
});

test("worker contract: dispatch returns its receipt only after the unit starts", async () => {
  const f = fixture();
  const runner = f.env.FAKE_SYSTEMD_RUN_SCRIPT!;
  const source = readFileSync(runner, "utf8");
  writeFileSync(runner, `await Bun.write(${JSON.stringify(join(f.root, "entered"))}, "yes");\nwhile (!(await Bun.file(${JSON.stringify(join(f.root, "release"))}).exists())) await Bun.sleep(10);\n` + source);
  const child = Bun.spawn([process.execPath, f.entry, "dispatch", f.ticket], { cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const reader = child.stdout.getReader();
  const first = reader.read();
  while (!(await Bun.file(join(f.root, "entered")).exists())) await Bun.sleep(10);
  const early = await Promise.race([first.then(() => true), Bun.sleep(100).then(() => false)]);
  expect(early).toBe(false);
  await Bun.write(join(f.root, "release"), "yes");
  expect(new TextDecoder().decode((await first).value)).toContain("workspace=");
  expect(await child.exited).toBe(0);
});

test("worker contract: the unit command uses the stable executable path", async () => {
  const f = fixture();
  const executable = join(f.root, "Cellar/agx/1.2.3/bin/agx-worker");
  mkdirSync(join(f.root, "Cellar/agx/1.2.3/bin"), { recursive: true });
  const built = Bun.spawnSync([process.execPath, "build", "--compile", f.entry, "--outfile", executable], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const child = Bun.spawn([executable, "dispatch", f.ticket], { cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, err).toBe(0);
  const args = readFileSync(f.unitArgs, "utf8").split("\n");
  expect(args[args.indexOf("--") + 1]).toBe(join(f.root, "opt/agx/bin/agx-worker"));
});

test("dispatch contract: --continue returns with its record before a child record", async () => {
  const f = fixture();
  const workspace = priorRun(f, join(`${f.repo}.ws`, "ws_foo-bar"));
  f.env.FAKE_NO_RECORD = "yes";
  f.env.FAKE_ASSERT_PRELAUNCH_RECORD = "yes";
  const result = await invoke(f, "--continue", "prior-run");
  expect(result.exitCode, result.stderr).toBe(0);
  const id = result.stdout.trim().split(/\s/u)[0];
  if (id === undefined) expect.unreachable("dispatch printed no run id");
  const parsedBinding = jsonOf(DispatchBindingSchema).safeParse(
    await Bun.file(f.bindingFile).text(),
  );
  expect(parsedBinding.success).toBe(true);
  if (!parsedBinding.success) return;
  expect(parsedBinding.data.id).toBe(id);
  expect(parsedBinding.data.workspace).toBe(workspace);
  const listed = Bun.spawnSync([process.execPath, ENTRY, "ls", id, "--json"], {
    cwd: f.repo,
    env: f.env,
    timeout: 5_000,
  });
  expect(listed.exitCode, listed.stderr.toString()).toBe(0);
  const rows = jsonOf(
    z.array(
      z.looseObject({ id: z.string(), continues: z.string().nullable() }),
    ),
  ).safeParse(listed.stdout.toString());
  expect(rows.success).toBe(true);
  if (!rows.success) return;
  expect(rows.data).toMatchObject([{ id, continues: "prior-run" }]);
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
    expect(result.exitCode, result.stderr).toBe(75);
    expect(result.stderr).toContain("TEST_INSPECTION_MS=60000ms");
    expect(result.stderr).not.toContain("preflight failed");
    expect(await Bun.file(f.unitArgs).exists()).toBe(false);
  },
);

test("dispatch check deadline is an operational timeout with exit 75", async () => {
  const f = fixture();
  // Run the slow check in the process that dispatch can kill. A wrapper which
  // spawns another Bun leaves its descendant holding the stderr pipe open.
  writeFileSync(
    f.entry,
    `import { dispatchMain } from ${JSON.stringify(fileURLToPath(new URL("../src/dispatch.ts", import.meta.url)))};
if (Bun.argv[2] === "dispatch") await dispatchMain(Bun.argv.slice(3));
else if (Bun.argv[2] === "check") {
  await Bun.sleep(65_000);
  console.error("late check verdict");
  process.exit(2);
}
else process.exit(1);
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

test("dispatch contract: the inspection bound honours DISPATCH_COMMAND_TIMEOUT_MS", async () => {
  expect(DISPATCH_COMMAND_TIMEOUT_MS).toBe(60_000);

  const overridden = fixture();
  overridden.env.DISPATCH_COMMAND_TIMEOUT_MS = "1000";
  const slowWorkspaceAdd = join(overridden.root, "bin", "agx-ws");
  writeFileSync(
    slowWorkspaceAdd,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_WS_ARGS"\nexec sleep 2\n',
  );
  chmodSync(slowWorkspaceAdd, 0o755);
  const expired = await invoke(overridden);
  expect(expired.exitCode, expired.stderr).toBe(75);
  expect(expired.stderr).toContain(
    "inspection timeout DISPATCH_COMMAND_TIMEOUT_MS=1000ms",
  );
  expect(expired.stderr).toContain('"add"');
  expect(expired.stderr).toContain("--repo");
  expect(await Bun.file(overridden.unitArgs).exists()).toBe(false);

  const unset = fixture();
  delete unset.env.DISPATCH_COMMAND_TIMEOUT_MS;
  unset.env.FAKE_WS_SLEEP_SECONDS = "2";
  const completed = await invoke(unset);
  expect(completed.exitCode, completed.stderr).toBe(0);
  expect(await Bun.file(unset.unitArgs).exists()).toBe(true);
}, 15_000);

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

test("dispatch --json exposes the immediate dispatch receipt", async () => {
  const f = fixture();
  const result = await invoke(f, "--json", "--ws", "receipt");
  expect(result.exitCode, result.stderr).toBe(0);
  const receipt = jsonOf(
    z.looseObject({
      id: z.string(),
      workspace: z.string(),
      row: z.string().nullable(),
      route: z.string().nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      sandbox: z.string(),
      sandbox_source: z.string(),
      sandbox_effective: z.string().nullable(),
      sandbox_effective_source: z.string().nullable(),
    }),
  ).safeParse(result.stdout);
  expect(receipt.success).toBe(true);
  if (!receipt.success) return;
  expect(receipt.data).toMatchObject({
    workspace: join(`${f.repo}.ws`, "ws_receipt"),
    row: null,
    route: null,
    model: null,
    effort: null,
    sandbox: "workspace-write",
    sandbox_source: "built-in default",
    sandbox_effective: null,
    sandbox_effective_source: null,
  });
});
