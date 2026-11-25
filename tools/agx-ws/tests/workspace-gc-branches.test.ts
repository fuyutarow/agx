// `agx ws gc` integration branches. Split from workspace.test.ts so that the gate runs the parts side by side.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, chmod, unlink, symlink, truncate } from "node:fs/promises";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { rootFileFileset, untrackedContent } from "../src/workspace.ts";
import {
  WS,
  scratch,
  localPolicyFiles,
  bin,
  home,
  baseEnv,
  run,
  ws,
  jj,
  shim,
  setRecords,
  seq,
  repo,
  wsDir,
  recFor,
} from "./workspace-fixture.ts";

setDefaultTimeout(60_000);

describe("gc integration branches", () => {
  test("GC preserves ended run results before removing a workspace", async () => {
    const env = baseEnv({ AGX_STATE_DIR: join(scratch, "gc-preserve-state") });
    const path = await repo('trunk = "main"\nregenerable = ["results/"]\n');
    expect((await ws(["add", "preserve"], path, env)).code).toBe(0);
    const dir = wsDir(path, "preserve");
    await Bun.write(join(dir, "results/result.md"), "durable finding");
    setRecords([
      {
        ...recFor(dir),
        id: "preserve",
        report_path: join(dir, "results/result.md"),
      },
    ]);
    const collected = await ws(["gc", "--apply"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    const target = join(
      env.AGX_STATE_DIR!,
      "runs/preserve/harvest/results/result.md",
    );
    expect(await Bun.file(target).text()).toBe("durable finding");
    expect(collected.out).toContain(
      join(env.AGX_STATE_DIR!, "runs/preserve/harvest"),
    );
  });

  test("GC keeps a workspace when result preservation conflicts and continues", async () => {
    const env = baseEnv({
      AGX_STATE_DIR: join(scratch, "gc-preserve-failure-state"),
    });
    const path = await repo('trunk = "main"\nregenerable = ["results/"]\n');
    for (const slug of ["conflict", "success"])
      expect((await ws(["add", slug], path, env)).code).toBe(0);
    const conflict = wsDir(path, "conflict");
    const success = wsDir(path, "success");
    for (const dir of [conflict, success])
      await Bun.write(join(dir, "results/result.md"), "new result");
    setRecords(
      [conflict, success].map((dir) =>
        Object.assign(recFor(dir), {
          id: dir === conflict ? "conflict" : "success",
          report_path: join(dir, "results/result.md"),
        }),
      ),
    );
    await Bun.write(
      join(env.AGX_STATE_DIR!, "runs/conflict/harvest/results/result.md"),
      "old result",
    );
    const collected = await ws(["gc", "--apply"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(existsSync(conflict)).toBe(true);
    expect(existsSync(success)).toBe(false);
    expect(collected.out).toContain(
      "result preservation failed: harvest conflict",
    );
    expect(
      await Bun.file(
        join(env.AGX_STATE_DIR!, "runs/success/harvest/results/result.md"),
      ).text(),
    ).toBe("new result");
  });

  test("removed harvest command is unknown", async () => {
    shim("agx-ws", `exec bun "${WS}" "$@"`);
    const result = await run(
      ["bun", join(import.meta.dir, "../../agx/src/agx.ts"), "ws", "harvest"],
      scratch,
    );
    expect(result.code).not.toBe(0);
    expect(result.err.toLowerCase()).toContain("unknown command");
  });

  test("GC keeps an empty saved checkout with unsnapshotted disk edits and never snapshots it", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "unsnapshotted"], path)).code).toBe(0);
    const dir = wsDir(path, "unsnapshotted");
    await Bun.write(join(dir, "a.txt"), "edited on disk after snapshot\n");
    const saved = await jj(
      [
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        'commit_id ++ "\\t" ++ committer.timestamp()',
      ],
      dir,
    );
    expect(saved.code, saved.err).toBe(0);

    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tkeep\t`);
    expect(dry.out).toContain(
      "unsnapshotted working-copy changes: yes: bytes differ at a.txt",
    );
    const collected = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${dir}\tws\tkeep\t`);
    expect(collected.out).toContain(
      "unsnapshotted working-copy changes: yes: bytes differ at a.txt",
    );
    const realRow = collected.out
      .split("\n")
      .find((line) => line.startsWith(`${dir}\t`));
    const dryRow = dry.out
      .split("\n")
      .find((line) => line.startsWith(`${dir}\t`));
    expect(realRow?.split("\t").slice(0, 4)).toEqual(
      dryRow?.split("\t").slice(0, 4),
    );
    expect(
      (
        await jj(
          [
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            "@",
            "-T",
            'commit_id ++ "\\t" ++ committer.timestamp()',
          ],
          dir,
        )
      ).out,
    ).toBe(saved.out);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe(
      "edited on disk after snapshot\n",
    );
    setRecords([]);
  });

  test("result preservation requires every file, equal bytes and no symlink escape", async () => {
    const path = await repo('trunk = "main"\n');
    const runDir = join(scratch, "preservation-run");
    // 1.22.32 excludes ignored files; use real untracked results here.
    for (let i = 0; i < 7; i++) {
      await Bun.write(join(path, `${i}.result.md`), `result-${i}`);
      await Bun.write(join(runDir, "results", `${i}.result.md`), `result-${i}`);
    }
    const inventory = () => untrackedContent(path, [], 10_000, [runDir]);
    const complete = await inventory();
    expect(complete.ok && complete.value.count).toBe(0);
    await Bun.write(join(runDir, "results", "6.result.md"), "different bytes");
    const changed = await inventory();
    expect(changed.ok && changed.value.count).toBe(1);
    await unlink(join(runDir, "results", "6.result.md"));
    await symlink(
      join(path, "6.result.md"),
      join(runDir, "results", "6.result.md"),
    );
    const escaped = await inventory();
    expect(escaped.ok && escaped.value.count).toBe(1);

    const oversizedSource = join(path, "large.result.bin");
    const oversizedCopy = join(runDir, "results", "large.result.bin");
    await Bun.write(oversizedSource, "");
    await Bun.write(oversizedCopy, "");
    await truncate(oversizedSource, 16 * 1024 * 1024 + 1);
    await truncate(oversizedCopy, 16 * 1024 * 1024 + 1);
    const oversized = await inventory();
    expect(oversized.ok && oversized.value.count).toBe(2);
  });

  // Full-file execution reached 11008ms under host load; preserve the GC contract with headroom.
  test("fully rejected runs collect only when reachable and results are preserved", async () => {
    const path = await repo('trunk = "main"\n');
    for (const slug of [
      "reject-clean",
      "reject-copy",
      "reject-other",
      "reject-edit",
      "reject-unjudged",
      "reject-accept",
    ]) {
      expect((await ws(["add", slug], path)).code).toBe(0);
    }
    const rows = [
      "reject-clean",
      "reject-copy",
      "reject-other",
      "reject-edit",
      "reject-unjudged",
      "reject-accept",
    ].map((slug) => ({
      state: "ended",
      cwd: wsDir(path, slug),
      workspace: wsDir(path, slug),
      id: slug,
      ended_at: Temporal.Now.instant().toString(),
      outcome: "ok",
      judgment: { decision: slug === "reject-accept" ? "accept" : "reject" },
    }));
    setRecords([
      ...rows,
      {
        ...recFor(wsDir(path, "reject-unjudged")),
        id: "pending",
        judgment: null,
      },
    ]);
    for (const slug of ["reject-copy", "reject-other"]) {
      // Ignore local results so jj does not turn them into source changes.
      await Bun.write(join(wsDir(path, slug), ".gitignore"), "*.result.md\n");
      await jj(["status"], wsDir(path, slug));
    }
    const landedCopy = (
      await jj(
        ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
        wsDir(path, "reject-copy"),
      )
    ).out.trim();
    expect(
      (await jj(["bookmark", "set", "main", "-r", landedCopy], path)).code,
    ).toBe(0);
    for (const slug of ["reject-copy", "reject-other"]) {
      await Bun.write(
        join(wsDir(path, slug), "worker.result.md"),
        "measurement",
      );
    }
    const copied = join(
      baseEnv().AGX_STATE_DIR!,
      "runs",
      "reject-copy",
      "results",
      "worker.result.md",
    );
    await Bun.write(copied, "measurement");
    await Bun.write(
      join(wsDir(path, "reject-accept"), "a.txt"),
      "accepted but unlanded",
    );
    await jj(["status"], wsDir(path, "reject-accept"));
    await Bun.write(join(wsDir(path, "reject-edit"), "a.txt"), "unlanded edit");
    await jj(["status"], wsDir(path, "reject-edit"));
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(
      wsDir(path, "reject-clean") + "\tws\tremovable\t",
    );
    expect(dry.out).toContain(wsDir(path, "reject-copy") + "\tws\tremovable\t");
    expect(dry.out).toContain("no age wait");
    expect(dry.out).toContain(wsDir(path, "reject-other") + "\tws\tkeep\t");
    expect(dry.out).toContain(wsDir(path, "reject-edit") + "\tws\tkeep\t");
    expect(dry.out).toContain("unjudged; keep");
    const collected = await ws(["gc", "--apply"], path);
    expect(collected.code, collected.err).toBe(0);
    for (const slug of ["reject-clean", "reject-copy"])
      expect(existsSync(wsDir(path, slug))).toBe(false);
    for (const slug of [
      "reject-other",
      "reject-edit",
      "reject-unjudged",
      "reject-accept",
    ])
      expect(existsSync(wsDir(path, slug))).toBe(true);
    expect(await Bun.file(copied).text()).toBe("measurement");
  });

  test("filesets select literal paths without selecting neighboring files", async () => {
    const path = await repo();
    const names = [
      ".dx/verdicts/20261019_x%2Emd.jsonl",
      'space and "quote".txt',
      "operators (a|b)&~glob:*.txt",
      "back\\slash.txt",
      "日本語.txt",
      "tab\tline\n.txt",
    ];
    for (const name of names) {
      await Bun.write(join(path, name), `literal ${name}`);
      await Bun.write(join(path, `${name}.neighbor`), "wrong file");
    }
    expect((await jj(["status"], path)).code).toBe(0);
    for (const name of names) {
      const shown = await jj(["file", "show", rootFileFileset(name)], path);
      expect(shown.code, shown.err).toBe(0);
      expect(shown.out).toBe(`literal ${name}`);
    }
  });

  test("gc compares saved content for percent and quoted tracked paths", async () => {
    const path = await repo('trunk = "main"\n');
    const firstName = ".dx/verdicts/20261019_x%2Emd.jsonl";
    const names = [firstName, 'space and "quote".txt'];
    for (const name of names)
      await Bun.write(join(path, name), "a\nb\nc\nd\ne\nf\ng\n");
    expect((await jj(["commit", "-m", "literal path base"], path)).code).toBe(
      0,
    );
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    const dir = wsDir(path, "literal-paths");
    await mkdir(dirname(dir), { recursive: true });
    expect(
      (
        await jj(
          ["workspace", "add", "--name", "literal-paths", "-r", "main", dir],
          path,
        )
      ).code,
    ).toBe(0);
    for (const name of names)
      await Bun.write(join(dir, name), "a\nB\nc\nd\ne\nf\ng\n");
    expect((await jj(["status"], dir)).code).toBe(0);
    const target = (
      await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
    ).out.trim();
    expect(
      (await jj(["bookmark", "set", "main", "-r", target], path)).code,
    ).toBe(0);
    setRecords([]);
    const landed = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(landed.code, landed.err).toBe(0);
    expect(landed.out).toContain(`${dir}\tws\tremovable\t`);
    await Bun.write(join(dir, firstName), "a\nB\nc\nD\ne\nf\ng\n");
    const pending = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(pending.code, pending.err).toBe(0);
    expect(pending.out).toContain(`${dir}\tws\tkeep\t`);
    expect(pending.out).toContain(
      `unsnapshotted working-copy changes: yes: bytes differ at ${firstName}`,
    );
  });

  for (const integration of ["squash", "rebase", "continuation"]) {
    // measured 5400ms on the census of alpha under host load
    test(`AGX-WS-GC-KEEP-BY-DIFF-1024: accepted ${integration} and real paths`, async () => {
      const path = await repo('trunk = "main"\n');
      setRecords([]);
      expect((await ws(["add", "integrated"], path)).code).toBe(0);
      const dir = wsDir(path, "integrated");
      const changedFile = "trailing space ";
      const files = [" leading space.txt", changedFile, "日本語 [draft].txt"];
      for (const file of files) await Bun.write(join(dir, file), "accepted\n");
      const end = (
        await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
      ).out.trim();
      if (integration === "squash") {
        expect(
          (await jj(["squash", "--from", end, "--into", "@"], path)).code,
        ).toBe(0);
        expect(
          (await jj(["bookmark", "set", "main", "-r", "@"], path)).code,
        ).toBe(0);
        expect((await jj(["workspace", "update-stale"], dir)).code).toBe(0);
        expect((await jj(["new", "main"], dir)).code).toBe(0);
      } else {
        for (const file of files)
          await Bun.write(join(path, file), "accepted\n");
        expect(
          (await jj(["commit", "-m", "independent integrated copy"], path))
            .code,
        ).toBe(0);
        expect(
          (await jj(["bookmark", "set", "main", "-r", "@-"], path)).code,
        ).toBe(0);
        if (integration === "rebase")
          expect(
            (await jj(["rebase", "-s", "@", "-d", "main"], dir)).code,
          ).toBe(0);
        else expect((await jj(["new", "main"], dir)).code).toBe(0);
      }
      setRecords([
        {
          ...recFor(dir),
          id: "old",
          judgment: { decision: "accept" },
          end_commit: end,
        },
        {
          ...recFor(dir),
          id: "continued",
          continues: "old",
          judgment: { decision: "accept" },
        },
      ]);
      const dry = await ws(["gc", "--dry-run"], path);
      expect(dry.code, `${dry.err}\n${dry.out}`).toBe(0);
      expect(dry.out).toContain(`${dir}\tws\tremovable\t`);
      // A locked recheck must see disk edits without recording them into jj.
      await Bun.write(join(dir, changedFile), "still unlanded\n");
      const kept = await ws(["gc", "--apply"], path);
      expect(kept.code, kept.err).toBe(0);
      expect(kept.out).toContain(`${dir}\tws\tkeep\t`);
      expect(kept.out).toContain(
        `unsnapshotted working-copy changes: yes: bytes differ at ${changedFile}`,
      );
      expect(kept.out).toContain(changedFile);
      expect(await Bun.file(join(dir, changedFile)).text()).toBe(
        "still unlanded\n",
      );
      await Bun.write(join(dir, changedFile), "accepted\n");
      expect((await jj(["status"], dir)).code).toBe(0);
      const collected = await ws(["gc", "--apply"], path);
      expect(collected.code, collected.err).toBe(0);
      expect(collected.out).toContain(`${dir}\tws\tremovable\t`);
      expect(existsSync(dir)).toBe(false);
      setRecords([]);
    });
  }

  test("WS-GC-IMMUTABLE: collects without abandoning an immutable workspace commit", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "immutable-abandoned"], path)).code).toBe(0);
    const dir = wsDir(path, "immutable-abandoned");
    expect(
      (
        await jj(
          [
            "config",
            "set",
            "--repo",
            'revset-aliases."immutable_heads()"',
            "root()",
          ],
          path,
        )
      ).code,
    ).toBe(0);
    const edited = await jj(["edit", "main"], dir);
    expect(edited.code, edited.err).toBe(0);
    const tip = (
      await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
    ).out.trim();
    expect(
      (
        await jj(
          [
            "config",
            "set",
            "--repo",
            'revset-aliases."immutable_heads()"',
            `builtin_immutable_heads() | ${tip}`,
          ],
          path,
        )
      ).code,
    ).toBe(0);
    const state = join(scratch, "immutable-state");
    const realBin = join(scratch, "immutable-bin");
    await mkdir(state);
    await mkdir(realBin);
    await symlink(
      join(import.meta.dir, "../../agx-worker/src/next/cli.ts"),
      join(realBin, "agx-worker"),
    );
    const wrapper = join(realBin, "agx");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun\nconst p=Bun.spawn([process.execPath,${JSON.stringify(join(import.meta.dir, "../../agx/src/agx.ts"))},...process.argv.slice(2)],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exitCode=await p.exited;\n`,
    );
    await chmod(wrapper, 0o755);
    const env = baseEnv({
      AGX_STATE_DIR: state,
      PATH: `${realBin}:${bin}:${process.env.PATH}`,
    });
    const old = Temporal.Now.instant().subtract({ hours: 48 }).toString();
    const id = "immutable-abandoned-first";
    await Bun.write(
      join(state, "records.jsonl"),
      `${[
        {
          kind: "started",
          id,
          at: old,
          ticket: id,
          writes: [],
          cwd: path,
          workspace: dir,
          row: "fixture",
          dispatcher_session: null,
          vendor_session: null,
          pid: process.pid,
        },
        {
          kind: "ended",
          id,
          at: old,
          exit: 1,
          outcome: "verify-failed",
          report_path: null,
          vendor_session: null,
          verify: [],
        },
        { kind: "judged", id, at: old, decision: "reject", note: "fixture" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    const collected = await ws(["gc", "--apply", "--abandoned"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${dir}\tws\tremovable\t`);
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_immutable-abandoned",
    );
    expect(
      (
        await jj(
          ["log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"'],
          path,
        )
      ).out,
    ).toContain(tip);
  });

  // measured 8798ms on the census of alpha under host load
  test("WS-GC-UNACCEPTED: abandonment requires rejection; flags never override unjudged runs", async () => {
    const path = await repo('trunk = "main"\nkeep = ["ws_kept"]\n');
    const slugs = [
      "abandoned",
      "accepted",
      "running",
      "unknown",
      "kept",
      "recent",
      "undated",
    ];
    for (const slug of slugs) {
      expect((await ws(["add", slug], path)).code).toBe(0);
      await Bun.write(join(wsDir(path, slug), "attempt.txt"), `${slug}\n`);
      expect((await jj(["status"], wsDir(path, slug))).code).toBe(0);
    }
    const state = join(scratch, "unaccepted-state");
    const realBin = join(scratch, "unaccepted-bin");
    await mkdir(state);
    await mkdir(realBin);
    await symlink(
      join(import.meta.dir, "../../agx-worker/src/next/cli.ts"),
      join(realBin, "agx-worker"),
    );
    const wrapper = join(realBin, "agx");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun\nconst p=Bun.spawn([process.execPath,${JSON.stringify(join(import.meta.dir, "../../agx/src/agx.ts"))},...process.argv.slice(2)],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exitCode=await p.exited;\n`,
    );
    await chmod(wrapper, 0o755);
    const env = baseEnv({
      AGX_STATE_DIR: state,
      PATH: `${realBin}:${bin}:${process.env.PATH}`,
    });
    const old = Temporal.Now.instant().subtract({ hours: 48 }).toString();
    const recent = Temporal.Now.instant().subtract({ hours: 1 }).toString();
    const events: object[] = [];
    const record = (
      slug: string,
      suffix: string,
      outcome?: string,
      endedAt = old,
      accept = false,
    ) => {
      const id = `${slug}-${suffix}`;
      events.push({
        kind: "started",
        id,
        at: old,
        ticket: id,
        writes: [],
        cwd: path,
        workspace: wsDir(path, slug),
        continues: suffix === "second" ? `${slug}-first` : null,
        row: "fixture",
        dispatcher_session: null,
        vendor_session: null,
        pid: process.pid,
      });
      if (outcome !== undefined)
        events.push({
          kind: "ended",
          id,
          at: endedAt,
          exit: 1,
          outcome,
          report_path: null,
          vendor_session: null,
          verify: [],
        });
      if (accept)
        events.push({
          kind: "judged",
          id,
          at: old,
          decision: "accept",
          note: "fixture",
        });
    };
    record("abandoned", "first", "verify-failed");
    record("abandoned", "second", "malformed");
    events.push({
      kind: "judged",
      id: "abandoned-second",
      at: old,
      decision: "reject",
      note: "fixture",
    });
    record("accepted", "first", "ok", old, true);
    record("accepted", "second", "refused");
    record("running", "first", "timeout");
    record("running", "second");
    record("kept", "first", "lost");
    record("recent", "first", "refused");
    record("recent", "second", "timeout", recent);
    // A dead pid yields derived loss with no ended timestamp, which cannot prove age.
    events.push({
      kind: "started",
      id: "undated-first",
      at: old,
      ticket: "undated",
      writes: [],
      cwd: path,
      workspace: wsDir(path, "undated"),
      row: "fixture",
      dispatcher_session: null,
      vendor_session: null,
      pid: 2147483647,
    });
    await Bun.write(
      join(state, "records.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const abandoned = wsDir(path, "abandoned");
    const tip = (
      await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], abandoned)
    ).out.trim();
    const dry = await ws(["gc", "--dry-run", "--abandoned"], path, env);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${abandoned}\tws\tremovable\t`);
    expect(dry.out).toContain(
      "abandoned-first (verify-failed), abandoned-second (malformed)",
    );
    const plain = await ws(
      ["gc", "--apply", "--include-unrecorded"],
      path,
      env,
    );
    expect(plain.code, plain.err).toBe(0);
    expect(plain.out).toContain("pass --abandoned");
    expect(await Bun.file(join(abandoned, "attempt.txt")).exists()).toBe(true);
    const collected = await ws(["gc", "--apply", "--abandoned"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${abandoned}\tws\tremovable\t`);
    expect(await Bun.file(join(abandoned, "attempt.txt")).exists()).toBe(false);
    const registered = (await jj(["workspace", "list"], path)).out;
    expect(registered).not.toContain("ws_abandoned");
    expect(
      (
        await jj(
          ["log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"'],
          path,
        )
      ).out,
    ).not.toContain(tip);
    for (const slug of slugs.filter((candidate) => candidate !== "abandoned")) {
      expect(
        await Bun.file(join(wsDir(path, slug), "attempt.txt")).exists(),
      ).toBe(true);
      expect(registered).toContain(`ws_${slug}`);
    }
    expect(collected.out).toContain(`${wsDir(path, "kept")}\tws\tkeep\t`);
  });

  test("WS-GC-LANDED-CONTENT: equal bytes in a non-ancestor do not count as landing", async () => {
    const path = await repo('trunk = "main"\n');
    for (const slug of ["rebased-copy", "partial-copy"])
      expect((await ws(["add", slug], path)).code).toBe(0);
    const landed = wsDir(path, "rebased-copy");
    const partial = wsDir(path, "partial-copy");
    for (const dir of [landed, partial]) {
      await Bun.write(join(dir, "a.txt"), "changed\n");
      await Bun.write(join(dir, "second.txt"), "new\n");
      await unlink(join(dir, "agx.toml"));
    }
    await Bun.write(join(partial, "second.txt"), "outstanding\n");
    await Bun.write(join(path, "a.txt"), "changed\n");
    await Bun.write(join(path, "second.txt"), "new\n");
    // Keep the committed config so trunk remains explicit, but delete another tracked file below.
    expect(
      (await jj(["commit", "-m", "independent landing copy"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    // An identical independent copy is not ancestry evidence; both commits remain unlanded.
    for (const dir of [landed, partial])
      expect((await jj(["status"], dir)).code).toBe(0);
    setRecords([recFor(landed), recFor(partial)]);
    const before = await ws(["gc", "--dry-run"], path);
    expect(before.out).toContain(`${landed}\tws\tkeep\t`);
    expect(before.out).toContain(`${partial}\tws\tkeep\t`);
    expect(before.out).toContain("unlanded change");
    await unlink(join(path, "agx.toml"));
    expect((await jj(["commit", "-m", "land deletion"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    // Neither working nor committed config exists; supply trunk through jj's default alias.
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"],
          path,
        )
      ).code,
    ).toBe(0);
    const env = baseEnv();
    const dry = await ws(["gc", "--dry-run"], path, env);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${landed}\tws\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    const collected = await ws(["gc", "--apply"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(await Bun.file(join(landed, "a.txt")).exists()).toBe(true);
    expect(await Bun.file(join(partial, "second.txt")).text()).toBe(
      "outstanding\n",
    );
  });

  test("release consumes notes and version metadata; later trunk edits preserve landing evidence", async () => {
    const path = await repo('trunk = "main"\n');
    await Bun.write(
      join(path, "tools/example/package.json"),
      '{"name":"example","version":"0.1.0"}\n',
    );
    await Bun.write(
      join(path, "tools/example/CHANGELOG.md"),
      "# Changelog\n\n## 0.1.0\n\n- Initial\n",
    );
    expect((await jj(["commit", "-m", "tool base"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    expect((await ws(["add", "release-copy"], path)).code).toBe(0);
    const dir = wsDir(path, "release-copy");
    const note = "tools/example/.changes/released.md";
    await Bun.write(
      join(dir, note),
      "---\nbump: patch\n---\n\nReleased feature\n",
    );
    await Bun.write(join(dir, "feature.txt"), "released work\n");
    // Worker edits to release metadata must survive release normalization.
    await Bun.write(
      join(dir, "tools/example/package.json"),
      '{"name":"renamed","version":"0.1.0"}\n',
    );
    await Bun.write(
      join(dir, "tools/example/CHANGELOG.md"),
      "# Changelog\n\n## 0.1.0\n\n- Initial, corrected\n",
    );
    await Bun.write(join(path, "feature.txt"), "released work\n");
    await Bun.write(
      join(path, "tools/example/package.json"),
      '{"name":"renamed","version":"0.1.1"}\n',
    );
    await Bun.write(
      join(path, "tools/example/CHANGELOG.md"),
      "# Changelog\n\n## 0.1.1\n\n- Released feature\n\n## 0.1.0\n\n- Initial, corrected\n",
    );
    expect(
      (await jj(["commit", "-m", "squashed release copy"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    await Bun.write(
      join(path, "feature.txt"),
      "released work, subsequently improved\n",
    );
    expect((await jj(["commit", "-m", "later trunk edit"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    setRecords([recFor(dir)]);
    expect((await jj(["status"], dir)).code).toBe(0);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    await Bun.write(join(dir, "feature.txt"), "unreleased work\n");
    const partial = await ws(["gc", "--apply"], path);
    expect(partial.code, partial.err).toBe(0);
    expect(partial.out).toContain(`${dir}\tws\tkeep\t`);
    expect(partial.out).toContain("unlanded change");
    expect(await Bun.file(join(dir, "feature.txt")).exists()).toBe(true);
    await Bun.write(join(dir, "feature.txt"), "released work\n");
    await Bun.write(
      join(dir, note),
      "---\nbump: patch\n---\n\nNever released\n",
    );
    expect((await jj(["status"], dir)).code).toBe(0);
    const missing = await ws(["gc", "--apply"], path);
    expect(missing.out).toContain(`${dir}\tws\tkeep\t`);
    expect(missing.out).toContain("unlanded change");
    expect(await Bun.file(join(dir, note)).exists()).toBe(true);
  });

  test("land staging residue with an unlanded change stays keep after the lock is free", async () => {
    const path = await repo('trunk = "main"\n');
    const state = join(home, "state/agx/land", `fixture-${seq.n}`);
    const dir = join(state, "workspace");
    await mkdir(state, { recursive: true });
    expect(
      (
        await jj(
          ["workspace", "add", "--name", "lander", "-r", "main", dir],
          path,
        )
      ).code,
    ).toBe(0);
    await Bun.write(join(dir, "temporary.txt"), "land staging residue\n");
    // This test exercises the land lock; the staging residue must be restorable.
    expect((await jj(["status"], dir)).code).toBe(0);
    setRecords([]);
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tland\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    expect((await ws(["gc", "--apply"], path)).code).toBe(0);
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    await Bun.write(
      join(state, "land.lock/owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        what: "land",
        since: Temporal.Now.instant().toString(),
      }),
    );
    const held = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(held.code, held.err).toBe(0);
    expect(held.out).toContain("land lock is held");
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    await Bun.write(
      join(state, "land.lock/owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: hostname(),
        what: "land",
        since: Temporal.Now.instant().toString(),
      }),
    );
    const collected = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(collected.out).toContain(`${dir}\tland\tkeep\t`);
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).toContain("lander");
  });

  test("an identical squash copy is still unlanded without commit reachability", async () => {
    const path = await repo('trunk = "main"\n');
    await Bun.write(join(path, "a.txt"), "a\nb\nc\nd\ne\nf\ng\n");
    expect((await jj(["commit", "-m", "multiline base"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    const dir = wsDir(path, "contained-diff");
    await mkdir(dirname(dir), { recursive: true });
    expect(
      (
        await jj(
          ["workspace", "add", "--name", "contained", "-r", "main", dir],
          path,
        )
      ).code,
    ).toBe(0);
    await Bun.write(join(dir, "a.txt"), "a\nB\nc\nd\ne\nf\ng\n");
    await Bun.write(join(dir, "shared-new.txt"), "same new file\n");
    expect((await jj(["status"], dir)).code).toBe(0);
    await Bun.write(join(path, "a.txt"), "a\nB\nc\nd\ne\nf\nG\n");
    await Bun.write(join(path, "shared-new.txt"), "same new file\n");
    await Bun.write(join(path, "unrelated.txt"), "other integrated work\n");
    expect(
      (await jj(["commit", "-m", "integrated plus other work"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    setRecords([]);
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tkeep\t`);
    expect(dry.out).toContain("unlanded change");
    // An additional on-disk edit must prevent deletion without being snapshotted.
    await Bun.write(join(dir, "a.txt"), "a\nB\nc\nD\ne\nf\ng\n");
    const partial = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(partial.code, partial.err).toBe(0);
    expect(partial.out).toContain(`${dir}\tws\tkeep\t`);
    expect(partial.out).toContain("unlanded change");
    expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
  });

  test("all unions creation state and L2 repositories once in an isolated config", async () => {
    const allEnv = baseEnv({ AGX_STATE_DIR: join(scratch, "all-state") });
    const primary = await repo('trunk = "main"\n');
    const consumer = await repo('trunk = "main"\n');
    const pending = await repo('trunk = "main"\n');
    for (const path of [primary, consumer, pending])
      expect(
        (
          await ws(
            ["add", "all"],
            path,
            path === pending
              ? baseEnv({
                  AGX_STATE_DIR: join(scratch, "all-historical-state"),
                })
              : allEnv,
          )
        ).code,
      ).toBe(0);
    const configDirectory = join(scratch, "config", "agx", "repos");
    await mkdir(configDirectory, { recursive: true });
    for (const [index, path] of [primary, consumer, pending].entries()) {
      const configPath = join(configDirectory, `repo-${index}.toml`);
      await Bun.write(
        configPath,
        `schema = 1\nroot = ${JSON.stringify(path)}\n`,
      );
      localPolicyFiles.push(configPath);
    }
    setRecords([]);
    const module = join(import.meta.dir, "../src/workspace.ts");
    const result = await run(
      [
        "bun",
        "--eval",
        `import {gcAll} from ${JSON.stringify(module)};const r=await gcAll({dryRun:true,includeUnrecorded:true,graceMinutes:0},${JSON.stringify(primary)});process.stdout.write(JSON.stringify(r));`,
      ],
      primary,
      allEnv,
    );
    expect(result.code, result.err).toBe(0);
    const parsed = jsonOf(
      z.object({
        ok: z.literal(true),
        value: z.object({
          lines: z.array(z.string()),
          failed: z.array(z.string()),
          repositories: z.array(
            z.object({ root: z.string(), sources: z.array(z.string()) }),
          ),
        }),
      }),
    ).safeParse(result.out);
    expect(parsed.success, result.out).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.value.failed, result.out).toEqual([]);
    expect(
      parsed.data.value.repositories.find((r) => r.root === pending)?.sources,
    ).toEqual(["L2"]);
    expect(
      parsed.data.value.repositories.find((r) => r.root === primary)?.sources,
    ).toEqual(["L2", "state"]);
    expect(parsed.data.value.lines).toHaveLength(3);
    const counts = jsonOf(
      z.object({
        value: z.object({
          counts: z.object({
            total: z.number(),
            unlanded: z.number(),
            collectable: z.number(),
          }),
        }),
      }),
    ).safeParse(result.out);
    expect(counts).toMatchObject({
      success: true,
      data: {
        value: { counts: { total: 3, unlanded: 0, collectable: 3 } },
      },
    });
    for (const path of [primary, consumer, pending]) {
      expect(
        parsed.data.value.lines.some((line) =>
          line.startsWith(`${wsDir(path, "all")}\tws\tremovable\t`),
        ),
      ).toBe(true);
      expect(await Bun.file(join(wsDir(path, "all"), "a.txt")).exists()).toBe(
        true,
      );
    }
    const conflict = await ws(
      ["gc", "--apply", "--all", "--repo", primary],
      primary,
    );
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("cannot be combined");
    const help = await ws(["gc", "--help"], primary);
    expect(help.code).toBe(0);
    expect(help.out).toContain("only creator");
  });
});

// These cases reproduce the incident with an empty saved diff and exercise real CLI effects.
