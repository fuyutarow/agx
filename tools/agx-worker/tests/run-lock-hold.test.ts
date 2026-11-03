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
        at: new Date().toISOString(),
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
        at: new Date().toISOString(),
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
  const lockPath = join(root, "current-runs.json");
  const publishedIds = async () => {
    const published = Published.parse(
      JSON.parse(await readFile(lockPath, "utf8")),
    );
    return {
      running: Rows.parse(published.output).runs.map((run) => run.id),
      ended: published.endedRuns.map((run) => run.id),
    };
  };
  try {
    const id = "live-run";
    const workspace = join(root, "live");
    append(
      {
        kind: "started",
        id,
        at: new Date().toISOString(),
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
    let pending = true;
    const flushed = flushRunPublications().then(() => {
      pending = false;
    });
    let attempts = 0;
    let slowest = 0;
    while (pending) {
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
      await Bun.sleep(20);
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
        at: new Date().toISOString(),
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
  } finally {
    child.kill();
  }
});
