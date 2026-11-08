import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

test("canonical imported runs and judgments retain identity and tie-breaks", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-imported-events-"));
  using _cleanup = {
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  const at = "2026-10-15T00:00:00Z";
  const events = [
    {
      kind: "started",
      id: "legacy-id",
      at,
      ticket: "old",
      writes: [],
      cwd: root,
      workspace: root,
      row: "old",
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
      legacy_key: "run:original",
      legacy: { run_id: "original", source: "legacy-v1" },
    },
    {
      kind: "ended",
      id: "legacy-id",
      at,
      exit: 0,
      report_path: null,
      vendor_session: null,
      verify: [],
      legacy_key: "run-ended:original",
    },
    {
      kind: "judged",
      id: "legacy-id",
      at,
      decision: "accept",
      note: "larger",
      legacy_key: "judged:z",
    },
    {
      kind: "judged",
      id: "legacy-id",
      at,
      decision: "reject",
      note: "smaller",
      legacy_key: "judged:a",
    },
  ];
  writeFileSync(
    join(root, "records.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const invoke = (...args: string[]) =>
    Bun.spawnSync(
      [process.execPath, "tools/agx-worker/src/next/cli.ts", ...args],
      {
        env: {
          ...subprocessEnvironment(),
          AGX_STATE_DIR: root,
          HOME: root,
          XDG_STATE_HOME: root,
        },
      },
    );
  const listing = invoke("ls", "--json", "--all");
  expect(listing.exitCode).toBe(0);
  const parsedListing = jsonOf(z.array(z.unknown())).safeParse(
    listing.stdout.toString(),
  );
  expect(parsedListing.success).toBe(true);
  if (parsedListing.success)
    expect(parsedListing.data).toMatchObject([
      {
        id: "legacy-id",
        ticket: "old",
        legacy: { run_id: "original", source: "legacy-v1" },
        judgment: {
          decision: "accept",
          note: "larger",
          legacy_key: "judged:z",
        },
      },
    ]);
  for (const [command, flag] of [
    ["ls", "--include-legacy"],
    ["stats", "--import-legacy"],
  ]) {
    expect(invoke(command!, flag!).exitCode).toBe(2);
    expect(invoke(command!, "--help").stdout.toString()).not.toContain(flag!);
  }
});
