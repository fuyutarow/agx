// forgetting unjudged workspaces and discovering repositories. Split from workspace.test.ts so that the gate runs the parts side by side.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import {} from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import {
  scratch,
  records,
  baseEnv,
  ws,
  jj,
  setRecords,
  repo,
  wsDir,
  stateTestEnv,
} from "./workspace-fixture.ts";

setDefaultTimeout(60_000);

describe("SEP-WS-FORGET-UNJUDGED-1023", () => {
  for (const caller of ["gc", "rm"] as const) {
    for (const state of [
      "unjudged",
      "accepted-pending",
      "accepted-landed",
      "rejected",
      "running",
    ] as const) {
      test(`${caller}: ${state} run gates forget and directory removal`, async () => {
        const path = await repo('trunk = "main"\n');
        setRecords([]);
        expect((await ws(["add", "guarded"], path)).code).toBe(0);
        const dir = wsDir(path, "guarded");
        const main = (
          await jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"], path)
        ).out.trim();
        let commit = main;
        if (state === "accepted-pending") {
          // Accepted content in the current working-copy chain must survive.
          await Bun.write(join(dir, "pending.txt"), "unlanded\n");
          commit = (
            await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], dir)
          ).out.trim();
        }
        let decision: string | undefined;
        if (state.startsWith("accepted")) decision = "accept";
        if (state === "rejected") decision = "reject";
        setRecords([
          {
            id: "latest",
            started_at: "2026-10-23T01:00:00Z",
            state: state === "running" ? "running" : "ended",
            ended_at: "2020-01-01T00:00:00Z",
            outcome: "ok",
            workspace: dir,
            judgment: decision === undefined ? null : { decision },
            end_commit: commit,
          },
        ]);
        const allowed = state === "accepted-landed" || state === "rejected";
        let args = ["rm", "guarded"];
        if (caller === "gc")
          args = ["gc", "--apply", "--abandoned", "--include-unrecorded"];
        const result = await ws(args, path);
        expect(result.code, result.out + result.err).toBe(
          allowed || caller === "gc" ? 0 : 1,
        );
        expect(existsSync(dir), result.out + result.err).toBe(!allowed);
        const names = (
          await jj(["--ignore-working-copy", "workspace", "list"], path)
        ).out;
        expect(names.includes("ws_guarded:")).toBe(!allowed);
        let reason = "unlanded";
        if (state === "unjudged") reason = "unjudged";
        if (state === "running") reason = "live or continuing";
        if (!allowed) expect(result.out + result.err).toContain(reason);
        setRecords([]);
      });
    }
  }

  test("latest run wins regardless of inventory order; cwd and continuation links retain work", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "latest"], path)).code).toBe(0);
    const dir = wsDir(path, "latest");
    const old = {
      id: "old",
      state: "ended",
      workspace: dir,
      judgment: { decision: "reject" },
      started_at: "2026-10-22T00:00:00Z",
    };
    const fresh = {
      id: "new",
      state: "ended",
      cwd: join(dir, "nested"),
      judgment: null,
      started_at: "2026-10-23T00:00:00Z",
    };
    for (const rows of [
      [old, fresh],
      [fresh, old],
    ]) {
      setRecords(rows);
      const result = await ws(["gc", "--apply", "--abandoned"], path);
      expect(result.out).toContain("run new is unjudged");
      expect(existsSync(dir)).toBe(true);
    }
    setRecords([old, { ...fresh, cwd: "/elsewhere", continues: "old" }]);
    expect((await ws(["rm", "latest"], path)).err).toContain(
      "run new is unjudged",
    );
    setRecords([fresh, { ...old, started_at: "2026-10-24T00:00:00Z" }]);
    expect((await ws(["rm", "latest"], path)).code).toBe(0);
    setRecords([]);
  });

  test("failed readiness retains a workspace if readiness published an unjudged run", async () => {
    const command = `printf '%s' '[{"id":"during-ready","state":"ended","workspace":"PLACEHOLDER","judgment":null}]' > ${JSON.stringify(records)}; exit 9`;
    const path = await repo('trunk = "main"\n');
    const dir = wsDir(path, "rollback");
    await Bun.write(
      join(path, "agx.toml"),
      `schema = 1\n[ws]\ntrunk = "main"\nready = [${JSON.stringify(command.replace("PLACEHOLDER", dir))}]\n`,
    );
    expect(
      (await jj(["commit", "-m", "rollback readiness policy"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    setRecords([]);
    const result = await ws(["add", "rollback"], path);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("unjudged");
    expect(existsSync(dir)).toBe(true);
    expect(
      (await jj(["--ignore-working-copy", "workspace", "list"], path)).out,
    ).toContain("ws_rollback");
    setRecords([]);
  });

  test("accepted inventory without end_commit permits an empty child of trunk", async () => {
    const path = await repo('trunk = "main"\n');
    setRecords([]);
    expect((await ws(["add", "ancestry"], path)).code).toBe(0);
    const dir = wsDir(path, "ancestry");
    setRecords([
      {
        id: "accepted",
        state: "ended",
        workspace: dir,
        judgment: { decision: "accept" },
      },
    ]);
    const removed = await ws(["rm", "ancestry"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    setRecords([]);
  });
});

import * as stateFs from "node:fs/promises";
import { tmpdir as stateTmpdir } from "node:os";
import {
  stateDir as resolvedStateDir,
  stateRefusal,
} from "../src/state-dir.ts";

test("single state directory precedence and retired startup checks preserve data", async () => {
  const root = await stateFs.mkdtemp(
    join(stateTmpdir(), "agx-state-contract-"),
  );
  await using _cleanup = {
    [Symbol.asyncDispose]: () =>
      stateFs.rm(root, { recursive: true, force: true }),
  };
  {
    const env = { HOME: root, XDG_STATE_HOME: "", AGX_STATE_DIR: "" };
    expect(resolvedStateDir(env)).toBe(join(root, ".local/state/agx"));
    expect(resolvedStateDir({ ...env, XDG_STATE_HOME: root })).toBe(
      join(root, "agx"),
    );
    const explicit = join(root, "custom");
    expect(
      resolvedStateDir({
        ...env,
        XDG_STATE_HOME: root,
        AGX_STATE_DIR: explicit,
      }),
    ).toBe(explicit);
    expect(await stateRefusal(env)).toBeUndefined();
    await stateFs.mkdir(join(root, "agx-next"));
    await stateFs.writeFile(join(root, "agx-next/sentinel"), "unchanged");
    const migrationEnv = { ...env, XDG_STATE_HOME: root };
    expect(await stateRefusal(migrationEnv)).toBeUndefined();
    expect(
      await stateRefusal({ ...migrationEnv, AGX_STATE_DIR: explicit }),
    ).toBeUndefined();
    for (const override of [
      {},
      { AGX_NEXT_STATE_DIR: "" },
      { AGX_NEXT_STATE_DIR: "retired" },
    ]) {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/ws.ts"), "--help"],
        {
          env: { ...stateTestEnv(), ...migrationEnv, ...override },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [out, err, code] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(out).not.toBe("");
      expect(err).toBe("");
    }
    expect(
      await stateFs.readFile(join(root, "agx-next/sentinel"), "utf8"),
    ).toBe("unchanged");
    expect(await stateFs.readdir(root)).toEqual(["agx-next"]);
    await stateFs.mkdir(join(root, "agx"));
    expect(await stateRefusal(migrationEnv)).toBeUndefined();
  }
});

describe("AGX-GC-DISCOVER-REPOS-1025", () => {
  // measured 6753ms on the census of alpha under host load
  test("state and all records discover no-L2 repositories; unreachable roots stay intact", async () => {
    const stateRepo = await repo('trunk = "main"\nkeep = ["ws_protected"]\n');
    const recordRepo = await repo('trunk = "main"\n');
    const missingRepo = await repo('trunk = "main"\n');
    const env = baseEnv({ AGX_STATE_DIR: join(scratch, "discover-state") });
    setRecords([]);
    expect((await ws(["add", "protected"], stateRepo, env)).code).toBe(0);
    expect((await ws(["add", "missing"], missingRepo, env)).code).toBe(0);
    // Historical workspace, created before the new creation index exists.
    expect(
      (
        await ws(
          ["add", "historic"],
          recordRepo,
          baseEnv({ AGX_STATE_DIR: join(scratch, "old-state") }),
        )
      ).code,
    ).toBe(0);
    setRecords([
      {
        id: "old-record",
        state: "ended",
        cwd: recordRepo,
        workspace: wsDir(recordRepo, "historic"),
      },
    ]);
    const args = ["gc", "--all", "--dry-run", "--include-unrecorded", "--json"];
    const dry = await ws(args, stateRepo, env);
    expect(dry.code, dry.err).toBe(0);
    const schema = jsonOf(
      z.object({
        repositories: z.array(
          z.object({
            root: z.string(),
            sources: z.array(z.string()),
            status: z.string(),
            counts: z.object({ total: z.number() }),
          }),
        ),
        counts: z.object({ total: z.number() }),
        discovery: z.object({
          state: z.number(),
          record: z.number(),
          L2: z.number(),
          note: z.string(),
        }),
        rows: z.array(z.array(z.string())),
      }),
    );
    const checked = schema.safeParse(dry.out);
    expect(checked.success, dry.out).toBe(true);
    if (!checked.success) return;
    const parsed = checked.data;
    expect(parsed.repositories).toHaveLength(3);
    expect(parsed.discovery).toMatchObject({ state: 2, record: 1, L2: 0 });
    expect(parsed.discovery.note).toContain("unindexed historical");
    expect(parsed.counts.total).toBe(3);
    expect(
      parsed.repositories.find((r) => r.root === recordRepo)?.sources,
    ).toEqual(["record"]);
    expect(
      parsed.rows.some(
        (r) => r[0] === wsDir(stateRepo, "protected") && r[2] === "keep",
      ),
    ).toBe(true);
    expect(
      parsed.rows.some((r) => r[0] === wsDir(recordRepo, "historic")),
    ).toBe(true);
    rmSync(missingRepo, { recursive: true, force: true });
    const missing = await ws(args, stateRepo, env);
    expect(missing.code).toBe(1);
    const missingParsed = schema.safeParse(missing.out);
    expect(missingParsed.success, missing.out).toBe(true);
    if (!missingParsed.success) return;
    const unreachable = missingParsed.data.repositories.find(
      (r) => r.root === missingRepo,
    );
    expect(unreachable).toMatchObject({
      status: "unreachable",
      sources: ["state"],
      counts: { total: 0 },
    });
    expect(existsSync(wsDir(missingRepo, "missing"))).toBe(true);
    const real = await ws(
      ["gc", "--apply", "--all", "--include-unrecorded", "--json"],
      stateRepo,
      env,
    );
    expect(real.code).toBe(1);
    expect(existsSync(wsDir(stateRepo, "protected"))).toBe(true);
    expect(existsSync(wsDir(missingRepo, "missing"))).toBe(true);
    setRecords([]);
  });
});
