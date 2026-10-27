import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const CLI = resolve("tools/agx-worker/src/next/cli.ts");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(input: { verify: string[]; always?: string[] }) {
  const parent = await mkdtemp(join(tmpdir(), "agx-sandbox-dispatch-"));
  roots.push(parent);
  const repo = join(parent, "repo");
  const tickets = join(repo, ".agents", "tickets");
  const workspace = join(parent, "repo.ws", "ws_sandbox-contract");
  const jjStore = join(repo, ".jj", "repo");
  const gitStore = join(parent, "git-store");
  const bin = join(parent, "bin");
  const state = join(parent, "state");
  const home = join(parent, "home");
  const launchTranscript = join(parent, "systemd-run.txt");
  const ticket = join(tickets, "sandbox-contract.md");
  await Promise.all([
    mkdir(jjStore, { recursive: true }),
    mkdir(gitStore, { recursive: true }),
    mkdir(tickets, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  const repositoryConfig = [
    "schema = 1",
    'tickets = ".agents/tickets"',
    ...(input.always === undefined
      ? []
      : ["", "[verify]", `always = ${JSON.stringify(input.always)}`]),
    "",
  ].join("\n");
  await writeFile(join(repo, "agx.toml"), repositoryConfig);
  await writeFile(
    ticket,
    [
      "+++",
      "schema = 2",
      'name = "sandbox-contract"',
      'writes = ["src/**"]',
      `verify = ${JSON.stringify(input.verify)}`,
      'outcome = "dispatch contract"',
      "[proposition]",
      'id = "SANDBOX-STORE"',
      'claim = "the dispatch honors VCS store write capability"',
      'refuted_by = "the worker starts with an unwritable verify store"',
      "+++",
      "Exercise the dispatch preflight.",
      "",
    ].join("\n"),
  );

  const writeExecutable = async (name: string, body: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  };
  await writeExecutable(
    "jj",
    [
      'if [ "$1" = "--version" ]; then echo "jj 0.46.0"; exit 0; fi',
      'case " $* " in',
      `  *" workspace root "*) printf '%s\\n' "$FAKE_REPO" ;;`,
      '  *" workspace list "*) printf \'"%s"\\n\' "$FAKE_REPO"; printf \'"%s"\\n\' "$FAKE_WORKSPACE" ;;',
      "  *\" file list \"*) printf 'agx.toml\\n' ;;",
      '  *" file show "*) cat "$FAKE_REPO/agx.toml" ;;',
      "  *\" log \"*) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;",
      "  *) printf 'unexpected jj invocation: %s\\n' \"$*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"),
  );
  await writeExecutable(
    "agx-ws",
    [
      'mkdir -p "$FAKE_WORKSPACE/.jj"',
      'printf \'%s\\n\' "$FAKE_JJ_STORE" > "$FAKE_WORKSPACE/.jj/repo"',
      'printf \'gitdir: %s\\n\' "$FAKE_GIT_STORE" > "$FAKE_WORKSPACE/.git"',
      'printf \'{"workspace":"%s"}\\n\' "$FAKE_WORKSPACE"',
    ].join("\n"),
  );
  await writeExecutable("mise", "printf '{}\\n'");
  await writeExecutable("systemctl", "exit 3");
  await writeExecutable(
    "systemd-run",
    'printf \'%s\\n\' "$*" > "$FAKE_LAUNCH_TRANSCRIPT"',
  );

  const env = { ...subprocessEnvironment() };
  for (const name of ["AGX_NEXT_STATE_DIR", "AGX_WORKER_PATH_SOURCE"])
    Reflect.deleteProperty(env, name);
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    AGX_STATE_DIR: state,
    AGX_CONFIG: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
    JJ_CONFIG: "",
    JJ_USER: "Fixture",
    JJ_EMAIL: "fixture@example.invalid",
    MISE_GLOBAL_CONFIG_FILE: join(parent, "mise.toml"),
    FAKE_REPO: repo,
    FAKE_WORKSPACE: workspace,
    FAKE_JJ_STORE: jjStore,
    FAKE_GIT_STORE: gitStore,
    FAKE_LAUNCH_TRANSCRIPT: launchTranscript,
  });
  return {
    env,
    gitStore,
    jjStore,
    launchTranscript,
    repo,
    state,
    ticket,
    workspace,
  };
}

async function invoke(f: Awaited<ReturnType<typeof fixture>>) {
  const child = Bun.spawn([process.execPath, CLI, "dispatch", f.ticket], {
    cwd: f.repo,
    env: f.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

test("sandbox contract: a verify that commits refuses before systemd-run", async () => {
  const f = await fixture({
    verify: [
      "jj new",
      "jj commit -m ticket",
      "jj rebase",
      "jj describe -m ticket",
    ],
    always: ["git commit -m repository policy"],
  });
  const result = await invoke(f);

  expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(2);
  expect(result.stderr).toContain("sandbox contract: verify[0]");
  expect(result.stderr).toContain("jj new");
  expect(result.stderr).toContain("jj commit");
  expect(result.stderr).toContain("jj rebase");
  expect(result.stderr).toContain("jj describe");
  expect(result.stderr).toContain("[verify].always[0]");
  expect(result.stderr).toContain("git commit");
  expect(result.stderr).toContain(`store=${JSON.stringify(f.jjStore)}`);
  expect(result.stderr).toContain(`store=${JSON.stringify(f.gitStore)}`);
  expect(result.stderr).toContain("leave edits for the dispatcher to commit");
  expect(result.stderr).toContain("explicitly choose --sandbox none");
  expect(await Bun.file(f.launchTranscript).exists()).toBe(false);
  const records = await readFile(join(f.state, "records.jsonl"), "utf8");
  expect(records).not.toContain('"kind":"dispatching"');
});

test("sandbox contract: an edit-only ticket still dispatches with the store warning", async () => {
  const f = await fixture({ verify: [] });
  const result = await invoke(f);

  expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stderr).toContain(
    "WARN sandbox capability=external-vcs-store-write; requested=workspace-write",
  );
  expect(result.stderr).toContain("writes[0]: src/**");
  expect(result.stderr).not.toContain("sandbox contract:");
  const transcript = await readFile(f.launchTranscript, "utf8");
  expect(transcript).toContain("--unit=agt_sandbox-contract");
  expect(transcript).toContain("--sandbox workspace-write");
  expect(basename(f.workspace)).toBe("ws_sandbox-contract");
  const records = await readFile(join(f.state, "records.jsonl"), "utf8");
  expect(records).toContain('"kind":"dispatching"');
});
