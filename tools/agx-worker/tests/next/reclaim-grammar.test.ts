import { jsonOf, z } from "../../../shared/src/zod.ts";
const Envelope = z.object({
  rows: z.array(z.array(z.string())),
  counts: z.record(z.string(), z.number()),
  broken: z.array(z.unknown()),
  complete: z.boolean(),
});
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

test("reclaim modes preserve effects and JSON envelope", async () => {
  for (const [flags, removes] of [
    [[], false],
    [["--dry-run"], false],
    [["--apply", "--no-pins"], true],
    [["--apply", "--dry-run", "--no-pins", "--json"], false],
    [["--apply", "--json"], false],
    [["--json"], false],
  ] satisfies [string[], boolean][]) {
    const root = mkdtempSync(join(tmpdir(), "reclaim-grammar-"));
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const state = join(root, "state"),
      bin = join(root, "bin"),
      dir = join(state, "runs", "old");
    mkdirSync(dir, { recursive: true });
    mkdirSync(bin);
    const path = join(dir, "data");
    writeFileSync(path, "data");
    const rip = join(bin, "rip");
    writeFileSync(rip, '#!/bin/sh\nrm -rf -- "$@"\n');
    chmodSync(rip, 0o755);
    const at = "2020-01-01T00:00:00Z";
    const events = [
      {
        kind: "started",
        id: "old",
        at,
        ticket: "old",
        writes: [],
        cwd: root,
        workspace: root,
        row: "test",
        dispatcher_session: null,
        vendor_session: null,
        pid: 1,
      },
      {
        kind: "ended",
        id: "old",
        at,
        exit: 0,
        outcome: "ok",
        report_path: null,
        vendor_session: null,
        verify: [],
      },
      { kind: "judged", id: "old", at, decision: "accept", note: "" },
    ];
    writeFileSync(
      join(state, "records.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "reclaim-runs",
        "--older-than",
        "14",
        ...flags,
      ],
      {
        env: {
          ...subprocessEnvironment(),
          AGX_STATE_DIR: state,
          PATH: `${bin}:${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code, err).toBe(
      flags.includes("--apply") &&
        (flags.includes("--dry-run") || !flags.includes("--no-pins"))
        ? 2
        : 0,
    );
    expect(existsSync(path)).toBe(!removes);
    if (code === 2) {
      expect(out).toBe("");
      expect(err).toContain("--apply");
      expect(err).toContain(
        flags.includes("--dry-run") ? "--dry-run" : "--pin",
      );
      continue;
    }
    if (flags.includes("--json")) {
      const human = Bun.spawn(
        [
          process.execPath,
          resolve("tools/agx-worker/src/next/cli.ts"),
          "reclaim-runs",
          "--older-than",
          "14",
        ],
        {
          env: {
            ...subprocessEnvironment(),
            AGX_STATE_DIR: state,
            PATH: `${bin}:${process.env.PATH}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [humanCode, humanOut, humanErr] = await Promise.all([
        human.exited,
        new Response(human.stdout).text(),
        new Response(human.stderr).text(),
      ]);
      expect(humanCode, humanErr).toBe(0);
      const value = envelope(out);
      expect(value.rows.length).toBe(1);
      expect(value.counts["would-move"]).toBe(
        humanOut
          .split("\n")
          .filter(
            (line) =>
              /^[^:]+: \d+ bytes would move to the graveyard$/u.test(line) &&
              !line.startsWith("total:"),
          ).length,
      );
      expect(value.counts.bytes).toBe(
        Number(/^total: (\d+) bytes/mu.exec(humanOut)?.[1]),
      );
      expect(value.counts.skipped).toBe(
        humanErr.split("\n").filter((line) => line.includes(": skipped:"))
          .length,
      );
      expect(value.broken).toEqual([]);
      expect(value.complete).toBe(true);
    }
  }
});

function envelope(text: string) {
  const parsed = jsonOf(Envelope).safeParse(text);
  expect(parsed.success).toBe(true);
  return parsed.success
    ? parsed.data
    : { rows: [], counts: { total: 0 }, broken: [], complete: false };
}
