import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { createTempTracker } from "./temp.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";

setDefaultTimeout(60_000);
const temps = createTempTracker();
afterAll(temps.assertRemoved);
const holderCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of holderCleanups.splice(0)) await cleanup();
});

const store = new URL("../src/next/store.ts", import.meta.url).pathname;
const cli = new URL("../src/next/cli.ts", import.meta.url).pathname;

const fixture = () => {
  const root = temps.register(mkdtempSync(join(tmpdir(), "agx-ls-lock-busy-")));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  writeFileSync(
    join(state, "records.jsonl"),
    JSON.stringify({
      kind: "started",
      id: "run-ended",
      at: "2026-10-14T12:00:00Z",
      ticket: "t",
      writes: [],
      cwd: workspace,
      workspace,
      row: "fixture",
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
    }) +
      "\n" +
      JSON.stringify({
        kind: "ended",
        id: "run-ended",
        at: "2026-10-14T12:01:00Z",
        exit: 0,
        report_path: null,
        vendor_session: null,
      }) +
      "\n",
  );
  return { root, state };
};

const ls = async (state: string) => {
  const begin = performance.now();
  const proc = Bun.spawn([process.execPath, cli, "ls", "--json"], {
    env: { ...subprocessEnvironment(), AGX_STATE_DIR: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, ms: performance.now() - begin };
};

test("ls --json does not wait on a busy publish lock and keeps stdout JSON", async () => {
  const { root, state } = fixture();
  const script = join(root, "holder.ts");
  writeFileSync(
    script,
    `import { join } from "node:path";
import { acquireWorkspaceLock } from ${JSON.stringify(store)};
const root = process.argv[2];
if (root === undefined) throw new Error("missing root");
const lock = await acquireWorkspaceLock(join(root, "current-runs.json"), root);
if (!lock.ok) throw new Error(lock.error);
process.stdout.write("held\\n");
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
  process.stdin.once("end", () => resolve());
});
await lock.release();
`,
  );
  const holder = Bun.spawn([process.execPath, script, state], {
    env: subprocessEnvironment(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  holderCleanups.push(async () => {
    await holder.stdin.end();
    await holder.exited;
  });
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
  reader.releaseLock();
  const result = await ls(state);
  expect(result.code).toBe(0);
  expect(result.ms).toBeLessThan(2000);
  const rows = jsonOf(z.array(z.unknown())).safeParse(result.stdout);
  expect(rows.success).toBe(true);
  // ls is a pure reader: it never takes the publish lock, so nothing is skipped or reported.
  expect(result.stderr).toBe("");
});
