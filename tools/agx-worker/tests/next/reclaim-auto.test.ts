import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function fixture(
  ages: [string, number, boolean, boolean][],
  pins: string[] | null,
  fail: boolean | "hang" = false,
  batch = false,
) {
  const root = mkdtempSync(join(tmpdir(), "agx-auto-"));
  const state = join(root, "state"),
    config = join(root, "config"),
    bin = join(root, "bin"),
    grave = join(root, "grave");
  mkdirSync(bin);
  mkdirSync(grave);
  const rip =
    fail === "hang" ? "#!/bin/sh\nexec sleep 10\n" : "#!/bin/sh\nexit 1\n";
  writeFileSync(
    join(bin, "rip"),
    fail !== false
      ? rip
      : '#!/bin/sh\nfor p in "$@"; do mv "$p" "$GRAVE/$(basename "$(dirname "$p")")-$(basename "$p")"; done\n',
  );
  chmodSync(join(bin, "rip"), 0o755);
  const events: object[] = [];
  for (const [id, age, judged, running] of ages) {
    const dir = join(state, "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data"), id);
    writeFileSync(join(dir, "result.md"), "record");
    const at = Temporal.Instant.fromEpochMilliseconds(
      Temporal.Now.instant().epochMilliseconds - age * 86400000,
    ).toString();
    events.push({
      kind: "started",
      id,
      at,
      ticket: id,
      writes: [],
      cwd: root,
      workspace: root,
      row: "test",
      dispatcher_session: null,
      vendor_session: null,
      pid: process.pid,
    });
    if (!running)
      events.push({
        kind: "ended",
        id,
        at,
        exit: 0,
        outcome: "ok",
        report_path: null,
        vendor_session: null,
        verify: [],
      });
    if (judged)
      events.push({ kind: "judged", id, at, decision: "reject", note: "" });
  }
  writeFileSync(
    join(state, "records.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  if (pins !== null) {
    const dir = join(config, "agx", "run-pins.d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "first.txt"),
      pins.map((id) => join(state, "runs", id, "data")).join("\n") +
        (pins.length > 0 ? "\n" : ""),
    );
  }
  const args = batch
    ? ["judge", "--from", join(root, "batch.jsonl")]
    : ["judge", ages[0]![0], "reject"];
  if (batch)
    writeFileSync(
      join(root, "batch.jsonl"),
      JSON.stringify({ run: ages[0]![0], decision: "reject" }) + "\n",
    );
  const proc = Bun.spawn(
    [process.execPath, resolve("tools/agx-worker/src/next/cli.ts"), ...args],
    {
      env: {
        ...process.env,
        AGX_STATE_DIR: state,
        XDG_CONFIG_HOME: config,
        PATH: `${bin}:${process.env.PATH}`,
        GRAVE: grave,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return {
    root,
    state,
    exit,
    stdout,
    stderr,
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const rows: [string, number, boolean, boolean][] = [
  ["judge", 1, false, false],
  ["old", 30, true, false],
  ["pinned", 31, true, false],
  ["recent", 1, true, false],
  ["unjudged", 30, false, false],
  ["running", 30, true, true],
];
test("absent pin decision disables sweep", async () => {
  using f = await fixture(rows, null);
  expect(f.exit).toBe(0);
  expect(existsSync(join(f.state, "runs/old/data"))).toBe(true);
  expect(f.stderr).not.toContain("reclaimed");
  expect(existsSync(join(f.state, "reclaim.jsonl"))).toBe(false);
});
test("pins and eligibility protect runs and record receipt", async () => {
  using f = await fixture(rows, ["pinned"], false, true);
  expect(f.exit).toBe(0);
  expect(f.stderr).toMatch(
    /agx: reclaimed 1 runs, \d+ bytes moved to the graveyard \(retention 14 days\)/u,
  );
  expect(existsSync(join(f.state, "runs/old/data"))).toBe(false);
  expect(existsSync(join(f.state, "runs/old/result.md"))).toBe(true);
  for (const id of ["pinned", "recent", "unjudged", "running"])
    expect(existsSync(join(f.state, "runs", id, "data"))).toBe(true);
  expect(readFileSync(join(f.state, "reclaim.jsonl"), "utf8")).toContain(
    '"id":"old"',
  );
});
test("one sweep moves at most twenty oldest runs", async () => {
  const many: typeof rows = [
    ["judge", 1, false, false],
    ...Array.from(
      { length: 23 },
      (_, i): [string, number, boolean, boolean] => [
        `r${i}`,
        20 + i,
        true,
        false,
      ],
    ),
  ];
  using f = await fixture(many, []);
  expect(f.exit).toBe(0);
  expect(f.stderr).toContain("reclaimed 20 runs");
  for (let i = 0; i < 23; i++)
    expect(existsSync(join(f.state, "runs", `r${i}`, "data"))).toBe(i < 3);
  expect(
    readFileSync(join(f.state, "reclaim.jsonl"), "utf8").trim().split("\n"),
  ).toHaveLength(20);
});
test("rip failure cannot change the judge exit", async () => {
  using f = await fixture(rows, [], true);
  expect(f.exit).toBe(0);
  expect(f.stderr).toContain("stopped at");
  expect(existsSync(join(f.state, "runs/old/data"))).toBe(true);
});
test("a stuck rip is stopped without changing the judge exit", async () => {
  using f = await fixture(rows, [], "hang");
  expect(f.exit).toBe(0);
  expect(f.stderr).toContain(
    "stopped at automatic reclaim: time limit exceeded",
  );
  expect(existsSync(join(f.state, "runs/old/data"))).toBe(true);
});
