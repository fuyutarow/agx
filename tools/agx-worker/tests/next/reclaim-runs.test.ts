import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  readdirSync,
  chmodSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

test("preview is read-only and apply retains records and ineligible runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-reclaim-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "rip"),
      '#!/bin/sh\nfor p in "$@"; do mv "$p" "$GRAVEYARD/$(basename "$p")"; done\n',
    );
    chmodSync(join(bin, "rip"), 0o755);
    mkdirSync(join(root, "graveyard"));
    const state = join(root, "state");
    const events: object[] = [];
    for (const [id, age, judged] of [
      ["old", 30, true],
      ["pinned", 30, true],
      ["unjudged", 30, false],
      ["recent", 1, true],
    ] as const) {
      const dir = join(state, "runs", id);
      mkdirSync(join(dir, "artifacts"), { recursive: true });
      for (const name of [
        "brief.md",
        "report.json",
        "result.md",
        `${id}.json`,
        "verify-round-1-01.log",
        "worker-progress.jsonl",
        "worker-progress-02.jsonl",
        `judged-evidence-${"a".repeat(64)}.txt`,
        "extra.bin",
        "artifacts/big",
      ])
        writeFileSync(join(dir, name), name);
      const at = new Date(Date.now() - age * 86400000).toISOString();
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
        pid: 1,
      });
      events.push({
        kind: "ended",
        id,
        at,
        exit: 0,
        outcome: "ok",
        report_path: join(dir, "report.json"),
        vendor_session: null,
        verify: [],
      });
      if (judged)
        events.push({ kind: "judged", id, at, decision: "accept", note: "" });
    }
    writeFileSync(
      join(state, "records.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const pinFile = join(root, "pins.txt");
    const extraPin = join(root, "pins-extra.txt");
    writeFileSync(
      pinFile,
      join(state, "runs", "pinned", "artifacts", "big") + "\n",
    );
    writeFileSync(extraPin, join(root, "irrelevant") + "\n");
    const invoke = async (apply: boolean) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          resolve("tools/agx-worker/src/next/cli.ts"),
          "reclaim-runs",
          "--older-than",
          "14",
          "--pin",
          pinFile,
          "--pin",
          extraPin,
          ...(apply ? ["--apply"] : []),
        ],
        {
          env: {
            ...subprocessEnvironment(),
            PATH: `${bin}:${process.env.PATH}`,
            AGX_STATE_DIR: state,
            GRAVEYARD: join(root, "graveyard"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit, stderr).toBe(0);
      return stdout;
    };
    const before = readFileSync(join(state, "records.jsonl"), "utf8");
    const pinnedDir = join(state, "runs", "pinned");
    const pinnedBefore = readdirSync(pinnedDir, { recursive: true })
      .toSorted()
      .map((name) => [
        name,
        existsSync(join(pinnedDir, String(name))) &&
        !String(name).endsWith("artifacts")
          ? readFileSync(join(pinnedDir, String(name)), "utf8")
          : null,
      ]);
    const preview = await invoke(false);
    expect(preview).toContain("would move to the graveyard");
    expect(preview).toContain("pinned: pinned");
    expect(existsSync(join(state, "runs/old/artifacts/big"))).toBe(true);
    expect(readFileSync(join(state, "records.jsonl"), "utf8")).toBe(before);
    const applied = await invoke(true);
    expect(applied).toContain("moved to the graveyard");
    expect(applied).toContain("pinned: pinned");
    for (const name of [
      "brief.md",
      "report.json",
      "result.md",
      "old.json",
      "verify-round-1-01.log",
      "worker-progress.jsonl",
      "worker-progress-02.jsonl",
      `judged-evidence-${"a".repeat(64)}.txt`,
    ])
      expect(existsSync(join(state, "runs/old", name))).toBe(true);
    for (const name of ["artifacts", "extra.bin"])
      expect(existsSync(join(state, "runs/old", name))).toBe(false);
    for (const id of ["recent", "unjudged", "pinned"])
      expect(existsSync(join(state, "runs", id, "artifacts/big"))).toBe(true);
    const pinnedAfter = readdirSync(pinnedDir, { recursive: true })
      .toSorted()
      .map((name) => [
        name,
        !String(name).endsWith("artifacts")
          ? readFileSync(join(pinnedDir, String(name)), "utf8")
          : null,
      ]);
    expect(pinnedAfter).toEqual(pinnedBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid pin input refuses before any removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-invalid-pin-"));
  try {
    const state = join(root, "state");
    const dir = join(state, "runs", "old", "artifacts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evidence"), "keep");
    const at = "2026-01-01T00:00:00Z";
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
    const pin = join(root, "pins");
    writeFileSync(pin, "relative/path\n");
    for (const pinPath of [pin, join(root, "missing")]) {
      const proc = Bun.spawn(
        [
          process.execPath,
          resolve("tools/agx-worker/src/next/cli.ts"),
          "reclaim-runs",
          "--older-than",
          "14",
          "--apply",
          "--pin",
          pinPath,
        ],
        {
          env: {
            ...subprocessEnvironment(),
            AGX_STATE_DIR: state,
            GRAVEYARD: join(root, "graveyard"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, , stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit, stderr).toBe(2);
      expect(existsSync(join(dir, "evidence"))).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit pins, shared files, failure and rerun", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-reclaim-contract-"));
  try {
    const state = join(root, "state"),
      bin = join(root, "bin"),
      grave = join(root, "grave");
    mkdirSync(bin);
    mkdirSync(grave);
    const events: object[] = [];
    for (const id of ["one", "two", "three", "four"]) {
      const dir = join(state, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "data"), id);
      const at = "2026-01-01T00:00:00Z";
      events.push(
        {
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
          pid: 1,
        },
        {
          kind: "ended",
          id,
          at,
          exit: 0,
          outcome: "ok",
          report_path: null,
          vendor_session: null,
          verify: [],
        },
        { kind: "judged", id, at, decision: "accept", note: "" },
      );
    }
    rmSync(join(state, "runs/four"), { recursive: true });
    linkSync(join(state, "runs/one/data"), join(root, "external"));
    writeFileSync(
      join(state, "records.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const rip = join(bin, "rip");
    const setRip = (fail: boolean) => {
      writeFileSync(
        rip,
        `#!/bin/sh\n${fail ? `[ -f "${root}/called" ] && exit 1\ntouch "${root}/called"` : ""}\nfor p in "$@"; do mv "$p" "${grave}/$(basename "$(dirname "$p")")-$(basename "$p")"; done\n`,
      );
      chmodSync(rip, 0o755);
    };
    setRip(true);
    const invoke = async (...args: string[]) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          resolve("tools/agx-worker/src/next/cli.ts"),
          "reclaim-runs",
          "--older-than",
          "1",
          ...args,
        ],
        {
          env: {
            ...subprocessEnvironment(),
            PATH: `${bin}:${process.env.PATH}`,
            AGX_STATE_DIR: state,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exit, out, err };
    };
    const preview = await invoke();
    expect(preview.out).toContain("shared: 3 bytes");
    expect(preview.err).toContain("four: skipped:");
    expect(preview.err).toContain("skipped: 1 runs");
    expect((await invoke("--apply")).exit).toBe(2);
    expect(existsSync(join(state, "runs/one/data"))).toBe(true);
    const failed = await invoke("--apply", "--no-pins");
    expect(failed.exit).toBe(1);
    expect(failed.err).toContain("1 runs moved, 1 runs not attempted");
    setRip(false);
    const resumed = await invoke("--apply", "--no-pins");
    expect(resumed.exit).toBe(0);
    expect(resumed.out).toContain("moved to the graveyard");
    expect(resumed.err).toContain("rip keeps moved files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable entry is reported and skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "agx-reclaim-unreadable-"));
  const state = join(root, "state"),
    dir = join(state, "runs", "old"),
    blocked = join(dir, "blocked");
  try {
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "data"), "x");
    chmodSync(blocked, 0o000);
    const at = "2026-01-01T00:00:00Z";
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
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "reclaim-runs",
        "--older-than",
        "1",
      ],
      {
        env: { ...subprocessEnvironment(), AGX_STATE_DIR: state },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, , err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(err).toContain("old: skipped:");
    expect(err).toContain("skipped: 1 runs");
  } finally {
    chmodSync(blocked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
