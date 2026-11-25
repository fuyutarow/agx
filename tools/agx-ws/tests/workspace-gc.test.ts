// `agx ws gc`: listing, jj workspace list and the local trunk. Split from workspace.test.ts so that the gate runs the parts side by side.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { jsonOf, z } from "../../shared/src/zod.ts";
import {
  WS,
  scratch,
  localPolicyFiles,
  bin,
  records,
  baseEnv,
  run,
  ws,
  jj,
  pushBookmark,
  shim,
  setRecords,
  repo,
  wsDir,
  listing,
  pathExists,
  gcRows,
} from "./workspace-fixture.ts";

setDefaultTimeout(60_000);

const rec = (path: string, slug: string, over: object) => ({
  id: `run-${slug}`,
  state: "ended",
  cwd: wsDir(path, slug),
  workspace: wsDir(path, slug),
  continues: null,
  judgment: { decision: "reject" },
  ...over,
});

describe("agx ws gc", () => {
  test("broken workspace rows do not stop dry-run or real gc", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    await ws(["add", "broken"], path);
    await ws(["add", "healthy"], path);
    const missing = wsDir(path, "broken");
    const healthy = wsDir(path, "healthy");
    rmSync(missing, { recursive: true, force: true });

    const dry = await ws(["gc", "--dry-run", "--json"], path);
    const plain = await ws(["gc", "--dry-run"], path);
    expect(plain.code, plain.err).toBe(1);
    const plainRows = plain.out
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(plainRows.filter((row) => row[2] === "broken")).toHaveLength(1);
    expect(
      plainRows.some((row) => row[0] === healthy && row[2] === "keep"),
    ).toBe(true);
    expect(dry.code, dry.err).toBe(1);
    const dryResult = gcRows.safeParse(dry.out);
    expect(dryResult.success, dry.out).toBe(true);
    if (!dryResult.success) return;
    const dryBroken = dryResult.data.rows.filter((row) => row[2] === "broken");
    expect(dryBroken).toHaveLength(1);
    expect(dryBroken[0]?.[0]).toBe(missing);
    expect(dryBroken[0]?.[5]).toContain(`directory missing: ${missing}`);
    expect(dryResult.data.broken).toEqual([missing]);
    expect(dryResult.data.complete).toBe(false);
    expect(
      dryResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "keep",
      ),
    ).toBe(true);

    const real = await ws(
      ["gc", "--apply", "--include-unrecorded", "--json"],
      path,
    );
    expect(real.code, real.err).toBe(1);
    const realResult = gcRows.safeParse(real.out);
    expect(realResult.success, real.out).toBe(true);
    if (!realResult.success) return;
    expect(
      realResult.data.rows.some(
        (row) => row[0] === missing && row[2] === "broken",
      ),
    ).toBe(true);
    expect(
      realResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "removable",
      ),
    ).toBe(true);
    expect(realResult.data.broken).toEqual([missing]);
    expect(existsSync(healthy)).toBe(false);
  });

  test("multiple missing directories stay as broken rows while real gc forgets reachable records", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    const missing = [
      wsDir(path, "missing-a"),
      wsDir(path, "missing-b"),
    ] as const;
    const healthy = wsDir(path, "healthy");
    mkdirSync(join(path, "..", "proj.ws"), { recursive: true });
    for (const [slug, dir] of [
      ["missing-a", missing[0]],
      ["missing-b", missing[1]],
      ["healthy", healthy],
    ] as const) {
      expect(
        (
          await jj(
            ["workspace", "add", "--name", `ws_${slug}`, "-r", "main", dir],
            path,
          )
        ).code,
      ).toBe(0);
    }
    expect(
      (await jj(["new", "ws_missing-a@", "ws_missing-b@"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@"], path)).code).toBe(
      0,
    );
    for (const dir of missing) rmSync(dir, { recursive: true, force: true });

    const dry = await ws(
      ["gc", "--dry-run", "--include-unrecorded", "--json"],
      path,
    );
    expect(dry.code, dry.err).toBe(1);
    const dryResult = gcRows.safeParse(dry.out);
    expect(dryResult.success, dry.out).toBe(true);
    if (!dryResult.success) return;
    expect(dryResult.data.rows).toHaveLength(4);
    expect(
      dryResult.data.rows.filter((row) => row[2] === "broken"),
    ).toHaveLength(2);
    for (const dir of missing)
      expect(dryResult.data.rows.find((row) => row[0] === dir)?.[5]).toContain(
        `directory missing: ${dir}`,
      );
    expect(
      dryResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "removable",
      ),
    ).toBe(true);

    const real = await ws(
      ["gc", "--apply", "--include-unrecorded", "--json"],
      path,
    );
    expect(real.code, real.err).toBe(1);
    const realResult = gcRows.safeParse(real.out);
    expect(realResult.success, real.out).toBe(true);
    if (!realResult.success) return;
    expect(realResult.data.rows).toHaveLength(4);
    expect(
      realResult.data.rows.filter((row) => row[2] === "broken"),
    ).toHaveLength(2);
    expect(
      realResult.data.rows.find((row) => row[0] === missing[0])?.[5],
    ).toContain("workspace record forgotten");
    expect(
      realResult.data.rows.some(
        (row) => row[0] === healthy && row[2] === "removable",
      ),
    ).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_missing-a",
    );
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_missing-b",
    );
    expect(existsSync(healthy)).toBe(false);
  });

  test("a missing workspace with an unpushed commit keeps its jj record", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    const missing = wsDir(path, "missing-unpushed");
    mkdirSync(join(path, "..", "proj.ws"), { recursive: true });
    expect(
      (
        await jj(
          [
            "workspace",
            "add",
            "--name",
            "ws_missing-unpushed",
            "-r",
            "main",
            missing,
          ],
          path,
        )
      ).code,
    ).toBe(0);
    await Bun.write(join(missing, "unpushed.txt"), "keep this commit\n");
    expect((await jj(["commit", "-m", "unpushed"], missing)).code).toBe(0);
    rmSync(missing, { recursive: true, force: true });

    const real = await ws(
      ["gc", "--apply", "--include-unrecorded", "--json"],
      path,
    );
    expect(real.code, real.err).toBe(1);
    const result = gcRows.safeParse(real.out);
    expect(result.success, real.out).toBe(true);
    if (!result.success) return;
    const row = result.data.rows.find((candidate) => candidate[0] === missing);
    expect(row?.[2]).toBe("broken");
    expect(row?.[5]).toContain(`directory missing: ${missing}`);
    expect(row?.[5]).toContain(
      "workspace commit is not reachable from trunk or a remote bookmark",
    );
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_missing-unpushed",
    );
  });

  test("reports the retaining remote bookmark and collects a pushed-only workspace", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "pushed-gc"], path)).code).toBe(0);
    const dir = wsDir(path, "pushed-gc");
    await Bun.write(join(dir, "pushed.txt"), "remote has this\n");
    expect((await jj(["commit", "-m", "pushed work"], dir)).code).toBe(0);
    await pushBookmark(dir, "feature-gc-pushed");
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${dir}\tws\tremovable\t`);
    expect(dry.out).toContain("feature-gc-pushed@origin");
    const collected = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(collected.code, collected.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("help explains where and how to declare kept workspaces", async () => {
    const path = await repo();
    const result = await ws(["gc", "--help"], path);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('keep = ["ws_<name>"]');
    expect(result.out).toContain('keep = ["ws_reference"]');
    expect(result.out).toContain("main checkout root `agx.toml`");
    expect(result.out).toContain("$XDG_CONFIG_HOME/agx/repos/<name>.toml");
    // 1.22.27 reports the per-repository inventory budget in help.
    expect(result.out).toContain("--inventory-budget-seconds");
    expect(result.out).toContain("--inventory-seconds");
    expect(result.out).toContain("default: 10");
  });

  test("reports narrowed sparse patterns even for an unrecorded workspace", async () => {
    const path = await repo('trunk = "main"\n');
    await Bun.write(join(path, "b.txt"), "tracked too\n");
    expect((await jj(["commit", "-m", "second tracked file"], path)).code).toBe(
      0,
    );
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    expect((await ws(["add", "narrow"], path)).code).toBe(0);
    const dir = wsDir(path, "narrow");
    expect(
      (await jj(["sparse", "set", "--clear", "--add", "a.txt"], dir)).code,
    ).toBe(0);
    setRecords([]);
    const r = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toContain(`${dir}\tws\tkeep\t`);
    expect(r.out).toContain("sparse or missing tracked file:");
    expect((await jj(["sparse", "list"], dir)).out.trim()).toBe("a.txt");
  });

  // measured 5087ms on the census of alpha under host load
  test("collects exactly terminal lineages with nothing unlanded; keeps live, continuing, unlanded", async () => {
    const path = await repo('trunk = "main"\n');
    for (const s of ["done", "live", "cont", "dirty", "orph"])
      await ws(["add", s], path);
    writeFileSync(join(wsDir(path, "dirty"), "w.txt"), "w\n");
    // Dry-run classification reads saved jj state; explicitly snapshot this fixture's work.
    expect((await jj(["status"], wsDir(path, "dirty"))).code).toBe(0);
    setRecords([
      rec(path, "done", {}),
      rec(path, "live", { state: "running" }),
      rec(path, "cont", { id: "run-cont-1" }),
      {
        ...rec(path, "cont", {
          id: "run-cont-2",
          state: "running",
          continues: "run-cont-1",
        }),
        cwd: "/elsewhere",
        workspace: "/elsewhere",
      },
      rec(path, "dirty", {}),
      rec(path, "orph", { state: "orphaned" }),
    ]);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.code).toBe(0);
    const verdict = Object.fromEntries(
      dry.out
        .trim()
        .split("\n")
        .map((l) => l.split("\t"))
        .map(([d, , v]) => [d?.split("/").pop() ?? "", v ?? ""] as const),
    );
    expect(verdict).toEqual({
      proj: "keep",
      ws_done: "removable",
      ws_live: "keep",
      ws_cont: "keep",
      ws_dirty: "keep",
      ws_orph: "removable",
    });
    for (const s of ["done", "live", "cont", "dirty", "orph"])
      expect(existsSync(wsDir(path, s))).toBe(true);
    const real = await ws(["gc", "--apply"], path);
    expect(real.code).toBe(0);
    expect(existsSync(wsDir(path, "done"))).toBe(false);
    expect(existsSync(wsDir(path, "orph"))).toBe(false);
    for (const s of ["live", "cont", "dirty"])
      expect(existsSync(wsDir(path, s))).toBe(true);
    expect(existsSync(join(wsDir(path, "dirty"), "w.txt"))).toBe(true);
    expect(listing(join(path, "..", "proj.ws"))).toEqual([
      "ws_cont",
      "ws_dirty",
      "ws_live",
    ]);
  });

  test("an obsolete run-end commit does not retain a workspace with no current content", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "ended"], path);
    const dir = wsDir(path, "ended");
    writeFileSync(join(dir, "w.txt"), "w\n");
    await jj(["commit", "-m", "run work"], dir);
    const end = (
      await jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], dir)
    ).out.trim();
    await jj(["new", "main"], dir);
    setRecords([rec(path, "ended", { end_commit: end })]);
    const r = await ws(["gc", "--apply"], path);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${dir}\tws\tremovable\t`);
    expect(existsSync(dir)).toBe(false);
  });

  test("unrecorded workspaces are reported, collected only with --include-unrecorded and no diff", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "clean"], path);
    await ws(["add", "diff"], path);
    writeFileSync(join(wsDir(path, "diff"), "w.txt"), "w\n");
    setRecords([]);
    const dry = await ws(["gc", "--dry-run"], path);
    expect(dry.out).toContain("unrecorded");
    expect(dry.out).not.toContain("would-collect");
    const plain = await ws(["gc", "--apply"], path);
    expect(plain.code).toBe(0);
    expect(existsSync(wsDir(path, "clean"))).toBe(true);
    const wide = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(wide.code).toBe(0);
    expect(existsSync(wsDir(path, "clean"))).toBe(false);
    expect(existsSync(wsDir(path, "diff"))).toBe(true);
  });

  test("young unrecorded workspaces survive include-unrecorded unless grace is zero", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "young"], path)).code).toBe(0);
    const young = wsDir(path, "young");
    setRecords([]);

    const protectedRun = await run(
      ["bun", WS, "gc", "--include-unrecorded", "--dry-run"],
      path,
      baseEnv(),
    );
    expect(protectedRun.code, protectedRun.err).toBe(0);
    expect(protectedRun.out).toContain(`${young}\tws\tkeep\t`);
    expect(protectedRun.out).toContain("created ");
    expect(protectedRun.out).toContain("; grace 30 min");

    const retained = await run(
      ["bun", WS, "gc", "--apply", "--include-unrecorded"],
      path,
      baseEnv(),
    );
    expect(retained.code, retained.err).toBe(0);
    expect(retained.out).toContain(`${young}\tws\tkeep\t`);
    expect(existsSync(young)).toBe(true);

    const disabled = await ws(
      ["gc", "--apply", "--include-unrecorded", "--grace-minutes", "0"],
      path,
    );
    expect(disabled.code, disabled.err).toBe(0);
    expect(disabled.out).toContain(`${young}\tws\tremovable\t`);
    expect(existsSync(young)).toBe(false);
  });

  test("gc help documents the workspace grace period", async () => {
    const path = await repo('trunk = "main"\n');
    const help = await ws(["gc", "--help"], path);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--grace-minutes");
    expect(help.out).toContain("default: 30; 0 disables");
  });

  test("old layout is kept outside the workspace root even on apply", async () => {
    const path = await repo('trunk = "main"\n');
    const old = join(path, "..", "proj-ws-old");
    expect(
      (await jj(["workspace", "add", "--name", "old", old], path)).code,
    ).toBe(0);
    for (const mode of ["--dry-run", "--apply"]) {
      const result = await ws(
        [
          "gc",
          mode,
          "--include-unrecorded",
          "--abandoned",
          "--grace-minutes",
          "0",
        ],
        path,
      );
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain(`${old}\toutside\tkeep\t`);
      expect(result.out).toContain(`${old} is outside workspace root`);
      expect(existsSync(old)).toBe(true);
    }
    const unknown = await ws(["gc", "--legacy"], path);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown option");
    const adopt = await ws(["adopt", "--help"], path);
    expect(adopt.code).toBe(2);
    expect(adopt.err).toContain('unknown command "adopt"');
    expect((await ws(["--help"], path)).out).not.toContain("adopt");
    expect((await ws(["gc", "--help"], path)).out).not.toContain("--legacy");
  });

  test("refuses, even as a dry run, when the graveyard is RAM-backed or agx fails", async () => {
    const path = await repo('trunk = "main"\n');
    const ram = await ws(
      ["gc", "--dry-run"],
      path,
      baseEnv({ FAKE_FS: "tmpfs" }),
    );
    expect(ram.code).toBe(1);
    expect(ram.err).toContain("RAM-backed");
    shim("agx", "echo broken >&2; exit 3");
    const broken = await ws(["gc", "--dry-run"], path);
    expect(broken.code).toBe(1);
    shim("agx", `cat "${records}"`);
  });
});

describe("WS-GC-JJ-LIST", () => {
  test("enumerates six registered layouts, repairs stale, protects keep, forgets before rip", async () => {
    const path = await repo(
      'trunk = "main"\nkeep = ["precious", "landed", "ws_modern"]\n',
    );
    setRecords([]);
    expect((await ws(["add", "modern"], path)).code).toBe(0);
    const dirs = {
      modern: wsDir(path, "modern"),
      empty: wsDir(path, "empty"),
      landed: wsDir(path, "landed"),
      unlanded: wsDir(path, "unlanded"),
      stale: wsDir(path, "stale"),
      precious: wsDir(path, "precious"),
    };
    for (const name of [
      "empty",
      "landed",
      "unlanded",
      "stale",
      "precious",
    ] as const) {
      const added = await jj(
        ["workspace", "add", "--name", name, "-r", "main", dirs[name]],
        path,
      );
      expect(added.code, added.err).toBe(0);
    }
    // A squash-style landing: the same diff on a different commit, without ancestry.
    await Bun.write(join(dirs.landed, "landed.txt"), "landed work\n");
    expect((await jj(["status"], dirs.landed)).code).toBe(0);
    await Bun.write(join(path, "landed.txt"), "landed work\n");
    expect((await jj(["commit", "-m", "squash landing"], path)).code).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    await Bun.write(join(dirs.unlanded, "unlanded.txt"), "must survive\n");
    await Bun.write(join(dirs.stale, "stale.txt"), "stale work\n");
    expect((await jj(["status"], dirs.stale)).code).toBe(0);
    expect((await jj(["status"], dirs.unlanded)).code).toBe(0);
    expect(
      (await jj(["restore", "--from", "unlanded@", "--to", "stale@"], path))
        .code,
    ).toBe(0);
    expect((await jj(["status"], dirs.stale)).err).toContain(
      "working copy is stale",
    );
    const outsider = await repo('trunk = "main"\n');
    expect((await ws(["add", "outside"], outsider)).code).toBe(0);
    const outsideBefore = (await jj(["workspace", "list"], outsider)).out;
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    const rows = dry.out
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(rows).toHaveLength(7);
    const machine = await ws(
      ["gc", "--dry-run", "--include-unrecorded", "--json"],
      path,
    );
    expect(machine.code, machine.err).toBe(0);
    expect(
      jsonOf(
        z.object({
          counts: z.object({
            total: z.number(),
            unlanded: z.number(),
            collectable: z.number(),
          }),
          complete: z.boolean(),
        }),
      ).safeParse(machine.out),
    ).toMatchObject({
      success: true,
      data: {
        counts: { total: 7, unlanded: 2, collectable: 1 },
        complete: true,
      },
    });
    expect(
      Object.fromEntries(
        rows.map(([dir, kind, verdict]) => [dir, [kind, verdict]]),
      ),
    ).toEqual({
      [path]: ["main", "keep"],
      [dirs.modern]: ["ws", "keep"],
      [dirs.empty]: ["ws", "removable"],
      [dirs.landed]: ["ws", "keep"],
      [dirs.unlanded]: ["ws", "keep"],
      [dirs.stale]: ["ws", "keep"],
      [dirs.precious]: ["ws", "keep"],
    });
    expect(dry.out).toContain("unlanded change");
    expect(dry.out).not.toContain("untracked content: 1 files (stale.txt)");
    // A row retained by aggregate reachability is not walked; stale repair remains explicit.
    expect((await jj(["status"], dirs.stale)).err).toContain(
      "working copy is stale",
    );
    expect((await jj(["workspace", "update-stale"], dirs.stale)).code).toBe(0);
    for (const dir of Object.values(dirs))
      expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(true);
    const plain = await ws(["gc", "--apply"], path);
    expect(plain.code, plain.err).toBe(0);
    expect(await Bun.file(join(dirs.empty, "a.txt")).exists()).toBe(true);

    // A real executable shim refuses burial unless jj has already forgotten that path.
    const tracedBin = join(scratch, "traced-bin");
    await mkdir(tracedBin);
    const trace = join(scratch, "rip-trace");
    const rip = Bun.which("rip");
    expect(rip).not.toBeNull();
    const wrapper = join(tracedBin, "rip");
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun
const p = Bun.spawn(["jj", "-R", ${JSON.stringify(path)}, "--ignore-working-copy", "workspace", "list", "-T", 'root ++ "\\n"'], {stdout:"pipe",stderr:"pipe"});
const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
if (code !== 0 || out.split("\\n").includes(process.argv[2])) { process.stderr.write(err || "workspace still registered"); process.exit(9); }
const old = Bun.file(${JSON.stringify(trace)}); await Bun.write(old, ((await old.exists()) ? await old.text() : "") + process.argv[2] + "\\n");
const child = Bun.spawn([${JSON.stringify(rip)}, ...process.argv.slice(2)], {stdout:"inherit",stderr:"inherit"}); process.exit(await child.exited);
`,
    );
    await chmod(wrapper, 0o755);
    const collected = await ws(
      ["gc", "--apply", "--include-unrecorded"],
      path,
      baseEnv({ PATH: `${tracedBin}:${bin}:${process.env.PATH}` }),
    );
    expect(collected.code, collected.err).toBe(0);
    const ripped = (await Bun.file(trace).text()).trim().split("\n");
    expect(ripped).toHaveLength(1);
    const tombstone = ripped[0];
    expect(tombstone).toBeDefined();
    if (tombstone === undefined) return;
    expect(tombstone.startsWith(join(`${path}.ws`, ".agx-ws-tombstone-"))).toBe(
      true,
    );
    expect(await pathExists(tombstone)).toBe(false);
    const registered = (
      await jj(["workspace", "list", "-T", 'name ++ "\\n"'], path)
    ).out
      .trim()
      .split("\n");
    expect(registered).toEqual([
      "default",
      "landed",
      "precious",
      "stale",
      "unlanded",
      "ws_modern",
    ]);
    for (const name of ["empty"] as const)
      expect(await Bun.file(join(dirs[name], "a.txt")).exists()).toBe(false);
    for (const name of [
      "modern",
      "landed",
      "unlanded",
      "stale",
      "precious",
    ] as const)
      expect(await Bun.file(join(dirs[name], "a.txt")).exists()).toBe(true);
    expect(collected.out).toContain(`${dirs.unlanded}\tws\tkeep\t`);
    expect(await Bun.file(join(dirs.unlanded, "unlanded.txt")).text()).toBe(
      "must survive\n",
    );
    expect((await jj(["workspace", "list"], outsider)).out).toBe(outsideBefore);
    expect(
      await Bun.file(join(wsDir(outsider, "outside"), "a.txt")).exists(),
    ).toBe(true);
  });

  test("uses jj trunk(), keeps root-only repos unclassified, and unions L2 keep paths", async () => {
    const path = await repo();
    const configured = await jj(
      ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"],
      path,
    );
    expect(configured.code, configured.err).toBe(0);
    expect((await ws(["add", "safe"], path)).code).toBe(0);
    expect((await ws(["add", "ancestor"], path)).code).toBe(0);
    const directory = join(scratch, "config", "agx", "repos");
    await mkdir(directory, { recursive: true });
    const l2Path = join(directory, `keep-${path.split("/").at(-2)}.toml`);
    await Bun.write(
      l2Path,
      `schema = 1\nroot = ${JSON.stringify(path)}\n[ws]\nkeep = ["ws_ancestor"]\n`,
    );
    localPolicyFiles.push(l2Path);
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`${wsDir(path, "safe")}\tws\tremovable\t`);
    expect(dry.out).toContain(`${wsDir(path, "ancestor")}\tws\tkeep\t`);
    expect((await ws(["rm", "ancestor"], path)).code).toBe(1);
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "root()"],
          path,
        )
      ).code,
    ).toBe(0);
    expect((await jj(["bookmark", "delete", "main"], path)).code).toBe(0);
    const noTrunk = await ws(["gc", "--apply", "--include-unrecorded"], path);
    expect(noTrunk.code, noTrunk.err).toBe(0);
    expect(noTrunk.out).toContain("trunk resolves to root");
    expect(
      await Bun.file(join(wsDir(path, "ancestor"), "a.txt")).exists(),
    ).toBe(true);
  });
});

describe("AGX-GC-LOCAL-TRUNK-1025", () => {
  for (const names of [
    ["alpha"],
    ["main"],
    ["master"],
    ["trunk"],
    [],
    ["alpha", "main"],
  ]) {
    test(`root trunk with local candidates ${names.length === 0 ? "none" : names.join(",")}`, async () => {
      const path = await repo();
      expect((await jj(["bookmark", "delete", "main"], path)).code).toBe(0);
      for (const name of names)
        expect(
          (await jj(["bookmark", "create", name, "-r", "@-"], path)).code,
        ).toBe(0);
      expect(
        (
          await jj(
            ["config", "set", "--repo", 'revset-aliases."trunk()"', "root()"],
            path,
          )
        ).code,
      ).toBe(0);
      expect((await jj(["git", "remote", "list"], path)).out.trim()).toBe("");
      expect((await ws(["add", "candidate"], path)).code).toBe(0);
      const before = (
        await jj(
          ["operation", "log", "--limit", "1", "--no-graph", "-T", "id"],
          path,
        )
      ).out;
      const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
      expect(dry.code, dry.err).toBe(0);
      if (names.length === 1) {
        expect(dry.out).toContain("\tws\tremovable\t");
        expect(dry.out).toContain(`trunk source: ${names[0]}`);
        expect(dry.out).not.toContain("missing trunk setting");
      } else {
        expect(dry.out).toContain("\tkeep\t");
        expect(dry.out).toContain(`${names.length} local candidate bookmarks`);
        expect(dry.out).toContain(
          `missing trunk setting; set [ws].trunk in agx.toml: trunk = "alpha"`,
        );
      }
      expect(
        (
          await jj(
            ["operation", "log", "--limit", "1", "--no-graph", "-T", "id"],
            path,
          )
        ).out,
      ).toBe(before);
    });
  }

  test("real jj trunk wins over local alpha and explicit root disables fallback", async () => {
    const path = await repo();
    expect(
      (await jj(["bookmark", "create", "alpha", "-r", "root()"], path)).code,
    ).toBe(0);
    expect(
      (
        await jj(
          ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"],
          path,
        )
      ).code,
    ).toBe(0);
    expect((await ws(["add", "precedence"], path)).code).toBe(0);
    const dry = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain("\tws\tremovable\t");
    expect(dry.out).toContain("trunk source: main");
    await Bun.write(
      join(path, "agx.toml"),
      'schema = 1\n[ws]\ntrunk = "root()"\n',
    );
    expect((await jj(["commit", "-m", "explicit root trunk"], path)).code).toBe(
      0,
    );
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    const explicit = await ws(
      ["gc", "--dry-run", "--include-unrecorded"],
      path,
    );
    expect(explicit.code, explicit.err).toBe(0);
    expect(explicit.out).toContain("\tkeep\t");
    expect(explicit.out).toContain("trunk source: root()");
    expect(explicit.out).not.toContain("local candidate bookmarks");
  });
});
