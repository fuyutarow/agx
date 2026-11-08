import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWorkspaceLock } from "../src/next/store.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

// Real entry point: `agx-worker dispatch` runs through next/cli.ts, which flushes run
// publications after dispatchMain returns. The worker is a fake that runs for 60 s.
const ENTRY = fileURLToPath(new URL("../src/next/cli.ts", import.meta.url));
const WORKER_SECONDS = 60;
/** The dispatch process has no job once its receipt is written and the unit is launched. */
const EXIT_AFTER_RECEIPT_MS = 5_000;
/** Another process (a sibling dispatch, a judge) holds the publication lock this long. */
const PUBLICATION_LOCK_HELD_MS = 15_000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function shim(bin: string, name: string, body: string[]) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body.join("\n")}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-dispatch-exits-"));
  roots.push(root);
  const repo = join(root, "repo");
  const tickets = join(repo, ".agents", "tickets");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(home, "state", "agx");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(join(repo, ".jj"));
  mkdirSync(bin);
  mkdirSync(state, { recursive: true });
  const ticket = join(tickets, "exit-probe.md");
  writeFileSync(
    ticket,
    `+++\nschema = 2\nwrites = []\nname = "exit-probe"\noutcome = "fixture"\n[proposition]\nid = "P1"\nclaim = "fixture"\nrefuted_by = "fixture"\n+++\n`,
  );
  const marker = join(root, "worker-completed");
  const started = join(root, "worker-started");
  // The fake unit launcher: systemd-run returns at once and the "unit" outlives it, as in production.
  const worker = join(root, "fake-worker.sh");
  writeFileSync(
    worker,
    `#!/bin/sh\ntouch "${started}"\nsleep ${WORKER_SECONDS}\ntouch "${marker}"\n`,
  );
  chmodSync(worker, 0o755);
  const launcher = join(root, "fake-systemd-run.ts");
  writeFileSync(
    launcher,
    [
      `const child = Bun.spawn(["${worker}"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      "child.unref();",
    ].join("\n"),
  );
  shim(bin, "systemd-run", [`exec bun "${launcher}" "$@"`]);
  shim(bin, "systemctl", ["exit 3"]);
  shim(bin, "agx-ws", [
    'slug="$2"',
    'workspace="$(dirname "$FAKE_REPO")/$(basename "$FAKE_REPO").ws/ws_$slug"',
    'mkdir -p "$workspace/.jj"',
    'printf \'{"workspace":"%s"}\\n\' "$workspace"',
  ]);
  shim(bin, "jj", [
    'if [ "$1" = "--version" ]; then echo "jj 0.46.0"; exit 0; fi',
    'case " $* " in *" workspace list "*) printf \'"%s"\\n\' "$FAKE_REPO"; exit 0 ;; esac',
    'case " $* " in *" log "*) printf "%s\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0 ;; esac',
    'printf "%s\\n" "$FAKE_REPO"',
  ]);
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    AGX_STATE_DIR: state,
    FAKE_REPO: repo,
  };
  Reflect.deleteProperty(env, "CLAUDE_CODE_SESSION_ID");
  Reflect.deleteProperty(env, "CODEX_SESSION_ID");
  Reflect.deleteProperty(env, "AGX_DISPATCHER_SESSION");
  return { root, repo, ticket, state, marker, started, env };
}

async function untilExists(path: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path) && performance.now() < deadline)
    await Bun.sleep(100);
  return existsSync(path);
}

test(
  "dispatch exits within seconds of its receipt while the 60 s run still completes",
  async () => {
    const f = fixture();
    // The publication lock is held by someone else for the first PUBLICATION_LOCK_HELD_MS.
    const held = await acquireWorkspaceLock(
      join(f.state, "current-runs.json"),
      f.state,
    );
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    setTimeout(() => void held.release(), PUBLICATION_LOCK_HELD_MS);
    const child = Bun.spawn(
      [process.execPath, ENTRY, "dispatch", f.ticket, "--json"],
      {
        cwd: f.repo,
        env: f.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      },
    );
    const stderr = new Response(child.stderr).text();
    let receiptAt: number | undefined;
    let receipt = "";
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receipt += decoder.decode(chunk.value);
      if (receipt.includes("\n") && receiptAt === undefined)
        receiptAt = performance.now();
    }
    const exitCode = await child.exited;
    const exitedAt = performance.now();
    expect(exitCode, await stderr).toBe(0);
    expect(receiptAt).toBeDefined();
    expect(receipt).toContain('"id"');
    // The unit was launched before the receipt, and the run is still going when dispatch is gone.
    expect(existsSync(f.started) || (await untilExists(f.started, 5_000))).toBe(
      true,
    );
    expect(existsSync(f.marker)).toBe(false);
    expect(exitedAt - receiptAt!).toBeLessThan(EXIT_AFTER_RECEIPT_MS);
    // The run does not depend on the dispatching process: it completes after dispatch exited.
    expect(await untilExists(f.marker, (WORKER_SECONDS + 30) * 1_000)).toBe(
      true,
    );
  },
  WORKER_SECONDS * 1_000 + 150_000,
);
