import { afterAll, afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { startFakeJev } from "./fake-jev.ts";

const jev = startFakeJev();
afterAll(() => jev.stop());

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const TIMEOUT_MS = 60_000;
const TICKET = `+++\nschema = 2\nwrites = []\nname = "foo-bar"\noutcome = "fixture"\nverify = ["true"]\n[proposition]\nid = "P1"\nclaim = "fixture"\nrefuted_by = "fixture"\n+++\n`;

/** Everything lives under one temp root: repository, external tickets, XDG config, state, stubs. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-dispatch-ticket-repo-"));
  roots.push(root);
  const repo = join(root, "repo");
  const external = join(root, "external-tickets");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const config = join(home, "config", "agx", "repos");
  for (const directory of [join(repo, ".jj"), external, bin, config])
    mkdirSync(directory, { recursive: true });
  const unitArgs = join(root, "unit-args.txt");
  const wsArgs = join(root, "ws-args.txt");
  const records = join(root, "records.json");
  writeFileSync(records, "[]\n");
  const entry = join(root, "dispatcher.ts");
  writeFileSync(
    entry,
    [
      `import { dispatchMain } from ${JSON.stringify(fileURLToPath(new URL("../src/dispatch.ts", import.meta.url)))};`,
      "const args = process.argv.slice(2);",
      'if (args[0] === "dispatch") await dispatchMain(args.slice(1));',
      'else { const child = Bun.spawn([process.env.FAKE_WORKER_COMMAND!, ...args], { stdout: "inherit", stderr: "inherit", timeout: 30_000 }); process.exitCode = await child.exited; }',
    ].join("\n"),
  );
  const systemdRunner = join(root, "fake-systemd-run.ts");
  writeFileSync(
    systemdRunner,
    [
      'import { writeFileSync } from "node:fs";',
      "const args = Bun.argv.slice(2);",
      'writeFileSync(process.env.FAKE_UNIT_ARGS!, args.join("\\n") + "\\n");',
      'const command = args.slice(args.indexOf("--") + 1);',
      'const binding = JSON.parse(command[command.indexOf("--dispatch-binding") + 1]!);',
      'const workspace = command[command.indexOf("--cd") + 1];',
      'writeFileSync(process.env.FAKE_RECORDS!, JSON.stringify([{ ...binding, state: "running", cwd: workspace, row: "fixture-high", route: "codex", model: "fixture-model", effort: "high", sandbox: "workspace-write", sandbox_source: "built-in default", sandbox_effective: "workspace-write", sandbox_effective_source: "built-in default" }]) + "\\n");',
    ].join("\n"),
  );
  const shim = (name: string, body: string[]) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body.join("\n")}\n`);
    chmodSync(path, 0o755);
  };
  // The fake jj knows one repository: only a directory inside it (or its ws siblings) has a default workspace.
  shim("jj", [
    'if [ "$1" = "--version" ]; then echo "jj 0.46.0"; exit 0; fi',
    'case " $* " in *" log "*) printf "%s\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0 ;; esac',
    'case "$PWD" in',
    '  "$FAKE_REPO"|"$FAKE_REPO"/*|"$FAKE_REPO".ws/*) printf "%s\\n" "$FAKE_REPO" ;;',
    '  *) echo "There is no jj repo in \\".\\"" >&2; exit 1 ;;',
    "esac",
  ]);
  // Records the repository agx-ws is asked to add the workspace to.
  shim("agx-ws", [
    'printf "%s\\n" "$@" > "$FAKE_WS_ARGS"',
    'slug="$2"',
    'while [ "$#" -gt 0 ]; do if [ "$1" = "--repo" ]; then repo="$2"; shift 2; else shift; fi; done',
    'workspace="$repo.ws/ws_$slug"',
    'mkdir -p "$workspace/.jj"',
    'printf \'{"workspace":"%s"}\\n\' "$workspace"',
  ]);
  shim("systemctl", ["exit 3"]);
  shim("systemd-run", ['exec bun "$FAKE_SYSTEMD_RUN_SCRIPT" "$@"']);
  shim("agx-worker", [
    'if [ "$1" = "ls" ]; then cat "$FAKE_RECORDS"; exit 0; fi',
    'if [ "$1" = "check" ]; then exit 0; fi',
    'echo "unexpected fake agx command: $*" >&2',
    "exit 2",
  ]);
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    AGX_STATE_DIR: join(home, "state", "agx"),
    CLAUDE_CODE_SESSION_ID: "fixture-claude",
    FAKE_WORKER_COMMAND: join(bin, "agx-worker"),
    FAKE_REPO: repo,
    FAKE_RECORDS: records,
    FAKE_UNIT_ARGS: unitArgs,
    FAKE_WS_ARGS: wsArgs,
    FAKE_SYSTEMD_RUN_SCRIPT: systemdRunner,
    JEV_URL: jev.url,
    TYPESAFE_API_KEY: "test-key",
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  const register = (name: string, rootPath: string, tickets: string) => {
    writeFileSync(
      join(config, `${name}.toml`),
      `schema = 1\nroot = ${JSON.stringify(rootPath)}\ntickets = ${JSON.stringify(tickets)}\n`,
    );
  };
  const ticketIn = (directory: string) => {
    const path = join(directory, "foo-bar.md");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, TICKET);
    return path;
  };
  return {
    root,
    repo,
    external,
    config,
    env,
    entry,
    wsArgs,
    unitArgs,
    register,
    ticketIn,
  };
}

async function dispatch(f: ReturnType<typeof fixture>, ticket: string) {
  const child = Bun.spawn([process.execPath, f.entry, "dispatch", ticket], {
    cwd: f.root,
    env: f.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test(
  "a ticket in a registered external tickets directory dispatches against that repository",
  async () => {
    const f = fixture();
    f.register("repo", f.repo, f.external);
    const ticket = f.ticketIn(f.external);
    const result = await dispatch(f, ticket);
    expect(result.exitCode, result.stderr).toBe(0);
    const ws = readFileSync(f.wsArgs, "utf8").split("\n");
    expect(ws[ws.indexOf("--repo") + 1]).toBe(f.repo);
    const unit = readFileSync(f.unitArgs, "utf8");
    expect(unit).toContain(`${f.repo}.ws/ws_foo-bar`);
  },
  TIMEOUT_MS,
);

test(
  "a ticket inside the repository still resolves by walking up",
  async () => {
    const f = fixture();
    f.register("repo", f.repo, f.external);
    const ticket = f.ticketIn(join(f.repo, ".agents", "tickets"));
    const result = await dispatch(f, ticket);
    expect(result.exitCode, result.stderr).toBe(0);
    const ws = readFileSync(f.wsArgs, "utf8").split("\n");
    expect(ws[ws.indexOf("--repo") + 1]).toBe(f.repo);
  },
  TIMEOUT_MS,
);

test(
  "an unregistered external ticket is refused naming the examined configs",
  async () => {
    const f = fixture();
    const elsewhere = join(f.root, "elsewhere-tickets");
    mkdirSync(elsewhere);
    f.register("repo", f.repo, elsewhere);
    const ticket = f.ticketIn(f.external);
    const result = await dispatch(f, ticket);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot resolve ticket repository");
    expect(result.stderr).toContain(ticket);
    expect(result.stderr).toContain(join(f.config, "repo.toml"));
    expect(result.stderr).toContain(`tickets = ${JSON.stringify(elsewhere)}`);
    expect(result.stderr).toContain("no registered repository has tickets");
  },
  TIMEOUT_MS,
);

test(
  "two registrations claiming the same tickets directory are refused",
  async () => {
    const f = fixture();
    const other = join(f.root, "other-repo");
    mkdirSync(join(other, ".jj"), { recursive: true });
    f.register("a", f.repo, f.external);
    f.register("b", other, f.external);
    const ticket = f.ticketIn(f.external);
    const result = await dispatch(f, ticket);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(join(f.config, "a.toml"));
    expect(result.stderr).toContain(join(f.config, "b.toml"));
    expect(() => readFileSync(f.wsArgs)).toThrow();
  },
  TIMEOUT_MS,
);
