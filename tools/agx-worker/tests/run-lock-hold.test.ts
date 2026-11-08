import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import {
  acquireWorkspaceLockUntilAvailable,
  append,
  flushRunPublications,
} from "../src/next/store.ts";

setDefaultTimeout(60_000);

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const worker = resolve(import.meta.dir, "fake-live-worker.ts");
const Published = z.object({
  output: z.string(),
  endedRuns: z.array(z.object({ id: z.string() })),
});
const Rows = jsonOf(z.object({ runs: z.array(z.object({ id: z.string() })) }));

/** The log of a long-lived installation: many workspaces, so each publication has real work. */
async function history(root: string, workspaces: number) {
  const lines: string[] = [];
  for (let index = 0; index < workspaces; index += 1) {
    const id = `old-${index}`;
    const workspace = join(root, "old", String(index));
    lines.push(
      JSON.stringify({
        kind: "started",
        id,
        at: Temporal.Now.instant().toString(),
        ticket: "old",
        writes: [],
        cwd: workspace,
        workspace,
        row: "fixture",
        dispatcher_session: null,
        vendor_session: null,
        pid: 1,
      }),
      JSON.stringify({
        kind: "ended",
        id,
        at: Temporal.Now.instant().toString(),
        exit: 0,
        outcome: "ok",
        report_path: null,
        vendor_session: null,
        verify: [],
      }),
    );
  }
  await writeFile(join(root, "records.jsonl"), `${lines.join("\n")}\n`);
}

test("a live run holds the current-runs lock only for the publish write", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-run-lock-hold-"));
  roots.push(root);
  await history(root, 6_000);
  const child = Bun.spawn([process.execPath, worker, "6000"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    child.kill();
  });
  const lockPath = join(root, "current-runs.json");
  const publishedIds = async () => {
    const parsed = jsonOf(Published).safeParse(
      await readFile(lockPath, "utf8"),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return { running: [], ended: [] };
    const published = parsed.data;
    const rows = Rows.safeParse(published.output);
    expect(rows.success).toBe(true);
    if (!rows.success) return { running: [], ended: [] };
    return {
      running: rows.data.runs.map((run) => run.id),
      ended: published.endedRuns.map((run) => run.id),
    };
  };
  const id = "live-run";
  const workspace = join(root, "live");
  append(
    {
      kind: "started",
      id,
      at: Temporal.Now.instant().toString(),
      ticket: "live",
      writes: [],
      cwd: workspace,
      workspace,
      row: "fixture",
      dispatcher_session: null,
      vendor_session: null,
      pid: child.pid,
    },
    root,
  );
  // Judge-style acquisition for as long as the start publication is in flight.
  const flushed = flushRunPublications();
  const startedAt = performance.now();
  let attempts = 0;
  let slowest = 0;
  while (attempts < 100 && performance.now() - startedAt < 60_000) {
    const began = performance.now();
    const lock = await acquireWorkspaceLockUntilAvailable(
      lockPath,
      root,
      2_000,
    );
    slowest = Math.max(slowest, performance.now() - began);
    expect(lock.ok, JSON.stringify(lock)).toBe(true);
    if (lock.ok) await lock.release();
    attempts += 1;
    await Promise.race([flushed, Bun.sleep(20)]);
  }
  await flushed;
  expect(attempts).toBeGreaterThan(0);
  expect(slowest).toBeLessThan(500);
  expect((await publishedIds()).running).toContain(id);
  expect(child.killed || child.exitCode === null).toBe(true);

  append(
    {
      kind: "ended",
      id,
      at: Temporal.Now.instant().toString(),
      exit: 0,
      outcome: "ok",
      report_path: null,
      vendor_session: null,
      verify: [],
    },
    root,
  );
  await flushRunPublications();
  const after = await publishedIds();
  expect(after.running).not.toContain(id);
  expect(after.ended).toContain(id);
});
