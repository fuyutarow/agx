// `agx ws add` and `agx ws refresh`. Split from workspace.test.ts so that the gate runs the parts side by side.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { jsonOf, z } from "../../shared/src/zod.ts";
import {
  scratch,
  bin,
  baseEnv,
  run,
  ws,
  jj,
  shim,
  seq,
  repo,
  wsDir,
  listing,
} from "./workspace-fixture.ts";

setDefaultTimeout(60_000);

describe("agx ws add", () => {
  test("JSON output stays machine readable through install chatter and reuse", async () => {
    const chatter =
      "30 packages installed …\n$HOME/consumer.ws/ws_fleet-line-real'\n";
    const command = `printf '%s' '${chatter.replaceAll("'", "'\\''")}'`;
    const path = await repo(`ready = [${JSON.stringify(command)}]\n`);
    const created = await ws(["add", "fleet-line-real", "--json"], path);
    expect(created.code, created.err).toBe(0);
    const createdJson = jsonOf(
      z.looseObject({
        workspace: z.string(),
        base: z.looseObject({
          change_id: z.string(),
          commit_id: z.string(),
          ref: z.string(),
          fetch_succeeded: z.null(),
          fetch: z.literal("no remote"),
        }),
      }),
    ).safeParse(created.out);
    expect(createdJson.success).toBe(true);
    if (!createdJson.success) return;
    expect(createdJson.data).toMatchObject({
      workspace: wsDir(path, "fleet-line-real"),
    });
    expect(created.err).toContain(chatter);
    const reused = await ws(
      ["add", "fleet-line-real", "--reuse", "--json"],
      path,
    );
    expect(reused.code, reused.err).toBe(0);
    const reusedJson = jsonOf(
      z.looseObject({ workspace: z.string() }),
    ).safeParse(reused.out);
    expect(reusedJson.success).toBe(true);
    if (!reusedJson.success) return;
    expect(reusedJson.data).toEqual({
      workspace: wsDir(path, "fleet-line-real"),
      policy_source: "agx.toml (trunk)",
    });
    expect(reused.err).not.toContain(chatter);
  });

  // The remote trunk recovery integration case measured over 11 seconds.
  test("fetches remote trunk, prefers a descendant local trunk, and supports failed-fetch recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-fresh-base-"));
    const bare = join(root, "remote.git");
    const seed = join(root, "seed");
    const path = join(root, "clone");
    const git = async (args: string[], cwd?: string) =>
      run(["git", ...args], cwd ?? root);
    const jjIn = async (args: string[], cwd?: string) => jj(args, cwd ?? path);
    const gitUser = [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
    ];
    expect((await git(["init", "--bare", bare])).code).toBe(0);
    expect((await git(["clone", bare, seed])).code).toBe(0);
    expect(
      (await git([...gitUser, "-C", seed, "switch", "-c", "alpha"])).code,
    ).toBe(0);
    await Bun.write(join(seed, "base.txt"), "base\n");
    await Bun.write(
      join(seed, "agx.toml"),
      'schema = 1\n[ws]\ntrunk = "alpha"\n',
    );
    expect((await git(["-C", seed, "add", "base.txt"])).code).toBe(0);
    expect((await git(["-C", seed, "add", "-f", "agx.toml"])).code).toBe(0);
    expect(
      (await git([...gitUser, "-C", seed, "commit", "-m", "base"])).code,
    ).toBe(0);
    expect(
      (await git(["-C", seed, "push", "-u", "origin", "alpha"])).code,
    ).toBe(0);
    expect(
      (
        await git([
          "--git-dir",
          bare,
          "symbolic-ref",
          "HEAD",
          "refs/heads/alpha",
        ])
      ).code,
    ).toBe(0);
    expect((await jj(["git", "clone", bare, path], root)).code).toBe(0);
    expect(
      (
        await jjIn([
          "config",
          "set",
          "--repo",
          'revset-aliases."trunk()"',
          "bookmarks(alpha)",
        ])
      ).code,
    ).toBe(0);
    expect(await Bun.file(join(path, "agx.toml")).text()).toBe(
      'schema = 1\n[ws]\ntrunk = "alpha"\n',
    );
    expect(
      (await jjIn(["bookmark", "untrack", "alpha", "--remote", "origin"])).code,
    ).toBe(0);
    const base = (
      await jjIn(["log", "--no-graph", "-r", "alpha@origin", "-T", "commit_id"])
    ).out.trim();

    await Bun.write(join(seed, "remote.txt"), "remote\n");
    expect((await git(["-C", seed, "add", "remote.txt"])).code).toBe(0);
    expect(
      (await git([...gitUser, "-C", seed, "commit", "-m", "remote advance"]))
        .code,
    ).toBe(0);
    expect((await git(["-C", seed, "push", "origin", "alpha"])).code).toBe(0);
    const remote = await ws(["add", "remote-new", "--json"], path);
    expect(remote.code, remote.err).toBe(0);
    const receiptSchema = jsonOf(
      z.looseObject({
        workspace: z.string(),
        base: z.looseObject({
          commit_id: z.string(),
          ref: z.string(),
          fetch: z.string(),
        }),
      }),
    );
    const remoteReceipt = receiptSchema.safeParse(remote.out);
    expect(remoteReceipt.success).toBe(true);
    if (!remoteReceipt.success) return;
    expect(remoteReceipt.data.base.commit_id).not.toBe(base);
    expect(remoteReceipt.data.base.ref).toBe("alpha@origin");
    expect(remoteReceipt.data.base.fetch).toBe("succeeded");

    await jjIn(["new", "alpha@origin"]);
    const setLocalAdvance = await jjIn(["bookmark", "set", "alpha", "-r", "@"]);
    expect(setLocalAdvance.code, setLocalAdvance.err).toBe(0);
    const local = await ws(["add", "local-new", "--json"], path);
    expect(local.code, local.err).toBe(0);
    const localReceipt = receiptSchema.safeParse(local.out);
    expect(localReceipt.success).toBe(true);
    if (!localReceipt.success) return;
    expect(localReceipt.data.base.ref).toBe("alpha");
    expect(localReceipt.data.base.commit_id).toBe(
      (
        await jjIn(["log", "--no-graph", "-r", "alpha", "-T", "commit_id"])
      ).out.trim(),
    );

    expect(
      (
        await jjIn([
          "git",
          "remote",
          "set-url",
          "origin",
          join(root, "missing.git"),
        ])
      ).code,
    ).toBe(0);
    const failed = await ws(["add", "fetch-fails", "--json"], path);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain("--no-fetch");
    const unfetched = await ws(
      ["add", "unfetched", "--json", "--no-fetch"],
      path,
    );
    expect(unfetched.code, unfetched.err).toBe(0);
    const unfetchedReceipt = receiptSchema.safeParse(unfetched.out);
    expect(unfetchedReceipt.success).toBe(true);
    if (!unfetchedReceipt.success) return;
    expect(unfetchedReceipt.data.base.fetch).toBe("unfetched");
    expect(unfetchedReceipt.data.base.commit_id).toBe(
      localReceipt.data.base.commit_id,
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("uses sparse . even when the source workspace is narrowed", async () => {
    const path = await repo('ready = ["jj sparse list > sparse.out"]\n');
    await Bun.write(join(path, "artifact.txt"), "tracked artifact\n");
    expect((await jj(["commit", "-m", "artifact"], path)).code).toBe(0);
    expect(
      (
        await jj(
          ["sparse", "set", "--clear", "--add", "a.txt", "--add", "agx.toml"],
          path,
        )
      ).code,
    ).toBe(0);
    const r = await ws(["add", "complete"], path);
    expect(r.code, r.err).toBe(0);
    expect(
      (await jj(["sparse", "list"], wsDir(path, "complete"))).out.trim(),
    ).toBe(".");
    expect(
      await Bun.file(join(wsDir(path, "complete"), "artifact.txt")).text(),
    ).toBe("tracked artifact\n");
    expect(
      await Bun.file(join(wsDir(path, "complete"), "sparse.out")).text(),
    ).toBe(".\n");
  });

  // The workspace refresh integration case measured over 9 seconds.
  test("refreshes a stale source before adding another slug and running readiness", async () => {
    const path = await repo('ready = ["jj status > ready.out"]\n');
    expect((await ws(["add", "source"], path)).code).toBe(0);
    const dir = wsDir(path, "source");
    expect((await jj(["new", "root()"], path)).code).toBe(0);
    await Bun.write(join(path, "destination.txt"), "destination\n");
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
    const rebased = await jj(["rebase", "-s", "main", "-d", "@"], path);
    expect(rebased.code, rebased.err).toBe(0);
    const stale = await jj(["status"], dir);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("working copy is stale");
    const r = await ws(["add", "next"], dir);
    expect(r.code, r.err).toBe(0);
    expect((await jj(["status"], dir)).code).toBe(0);
    expect((await jj(["status"], wsDir(path, "next"))).code).toBe(0);
    expect(
      await Bun.file(join(wsDir(path, "next"), "ready.out")).exists(),
    ).toBe(true);
  });

  // The mise trust integration case measured over 6 seconds.
  test("trusts mise.toml without a readiness declaration", async () => {
    const path = await repo();
    await Bun.write(
      join(path, "mise.toml"),
      '[env]\nWS_TRUST_FIXTURE = "ready"\n',
    );
    expect(
      (await jj(["commit", "-m", "mise without readiness"], path)).code,
    ).toBe(0);
    const r = await ws(["add", "demo"], path);
    expect(r.code, r.err).toBe(0);
    const config = join(wsDir(path, "demo"), "mise.toml");
    const shown = await run(["mise", "trust", "--show"], wsDir(path, "demo"));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`${config}: trusted`);
    expect(r.err).toContain(`ws: ready: trusted ${config}`);
  });

  test.each([
    ["all tools are installed", "0", false],
    ["a tool is missing", "1", true],
  ] as const)(
    "checks mise before install when %s",
    async (_label, code, install) => {
      const path = await repo('ready = ["echo ready > ready.out"]\n');
      await Bun.write(join(path, "mise.toml"), '[tools]\nbun = "1.2.0"\n');
      expect(
        (await jj(["commit", "-m", "mise install fixture"], path)).code,
      ).toBe(0);

      const fakeBin = join(scratch, `fake-mise-${++seq.n}`);
      const log = join(scratch, `fake-mise-${seq.n}.log`);
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, "mise"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1 $2" = "install --dry-run-code" ]; then exit "$MISSING_EXIT"; fi\nexit 0\n`,
      );
      chmodSync(join(fakeBin, "mise"), 0o755);
      const result = await ws(
        ["add", "mise-check"],
        path,
        baseEnv({
          PATH: `${fakeBin}:${bin}:${process.env.PATH}`,
          MISSING_EXIT: code,
        }),
      );
      expect(result.code, result.err).toBe(0);
      const calls = await Bun.file(log).text();
      expect(calls).toContain("install --dry-run-code");
      expect(calls.includes("\ninstall\n")).toBe(install);
      expect(
        await Bun.file(join(wsDir(path, "mise-check"), "ready.out")).exists(),
      ).toBe(true);
    },
  );

  test.each(["mise.toml", ".mise.toml"])(
    "trusts %s before readiness with isolated mise state",
    async (config) => {
      const path = await repo('ready = ["mise env --json > ready.json"]\n');
      await Bun.write(
        join(path, config),
        '[env]\nWS_TRUST_FIXTURE = "ready"\n',
      );
      expect((await jj(["commit", "-m", "mise fixture"], path)).code).toBe(0);
      const r = await ws(["add", "demo"], path);
      expect(r.code, r.err).toBe(0);
      const dir = wsDir(path, "demo");
      expect(r.err).toContain(`ws: ready: trusted ${join(dir, config)}`);
      const shown = await run(["mise", "trust", "--show"], dir);
      expect(shown.code).toBe(0);
      expect(shown.out).toContain(`${join(dir, config)}: trusted`);
      const env = jsonOf(
        z.looseObject({ WS_TRUST_FIXTURE: z.literal("ready") }),
      ).safeParse(await Bun.file(join(dir, "ready.json")).text());
      expect(env.success).toBe(true);
    },
  );

  test("runs declared trust for an additional config before returning the workspace", async () => {
    const path = await repo('ready = ["mise trust -q nested/mise.toml"]\n');
    await Bun.write(
      join(path, "mise.toml"),
      '[env]\nWS_TRUST_FIXTURE = "root"\n',
    );
    await Bun.write(
      join(path, "nested/mise.toml"),
      '[env]\nWS_TRUST_NESTED = "nested"\n',
    );
    expect((await jj(["commit", "-m", "nested mise fixture"], path)).code).toBe(
      0,
    );
    const r = await ws(["add", "nested"], path);
    expect(r.code).toBe(0);
    const dir = wsDir(path, "nested");
    expect(r.err).toContain(`ws: ready: trusted ${join(dir, "mise.toml")}`);
    expect(r.err).toContain("ws: ready: mise trust -q nested/mise.toml");
    const shown = await run(["mise", "trust", "--show"], join(dir, "nested"));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`${join(dir, "mise.toml")}: trusted`);
    expect(shown.out).toContain(`${join(dir, "nested/mise.toml")}: trusted`);
  });

  test("a failed mise trust is loud and rolls back before readiness", async () => {
    const path = await repo('ready = ["echo ran > ready.out"]\n');
    await Bun.write(
      join(path, "mise.toml"),
      '[env]\nWS_TRUST_FIXTURE = "ready"\n',
    );
    expect(
      (await jj(["commit", "-m", "mise failure fixture"], path)).code,
    ).toBe(0);
    // A regular file cannot hold mise's state directory, even when tests run as root.
    const blocked = join(scratch, "blocked-state");
    await Bun.write(blocked, "not a directory\n");
    const r = await ws(
      ["add", "blocked"],
      path,
      baseEnv({ MISE_STATE_DIR: blocked }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("mise trust");
    expect(r.err).toContain("the new workspace was removed");
    expect(r.err).not.toContain("ws: ready: echo ran");
    expect(
      await Bun.file(
        join(wsDir(path, "blocked"), ".jj/working_copy/type"),
      ).exists(),
    ).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_blocked",
    );
  });

  test("creates the declared path, names the workspace after it, runs readiness", async () => {
    const path = await repo(
      'trunk = "main"\nready = ["pwd > ready.out", "echo done >> ready.out"]\n',
    );
    const r = await ws(["add", "alpha"], path);
    expect(r.code).toBe(0);
    const dir = wsDir(path, "alpha");
    expect(r.out.trim()).toBe(join(path, "..", "proj.ws", "ws_alpha"));
    expect(existsSync(join(dir, ".jj"))).toBe(true);
    expect(await Bun.file(join(dir, "ready.out")).text()).toContain("done");
    expect((await jj(["workspace", "list"], path)).out).toContain("ws_alpha");
  });

  test("add and dry-run leave verdict publication to real gc outside the repository and workspace directory", async () => {
    const path = await repo('trunk = "main"\n');
    const state = join(scratch, "explicit-verdict-state");
    const env = baseEnv({ AGX_STATE_DIR: state });
    const verdictPath = join(state, "workspace-verdicts.json");
    const before = listing(join(path, ".."));
    const added = await ws(["add", "s1"], path, env);
    expect(added.code, added.err).toBe(0);
    expect(listing(join(path, "..", "proj.ws"))).toEqual(["ws_s1"]);
    expect(
      listing(join(path, "..")).filter((n) => !before.includes(n)),
    ).toEqual(["proj.ws"]);
    expect(await Bun.file(verdictPath).exists()).toBe(false);
    const observed = await ws(["gc", "--dry-run"], path, env);
    expect(observed.code, observed.err).toBe(0);
    expect(await Bun.file(verdictPath).exists()).toBe(false);
    const collected = await ws(["gc", "--apply"], path, env);
    expect(collected.code, collected.err).toBe(0);
    expect(await Bun.file(verdictPath).exists()).toBe(true);
    const observation = jsonOf(
      z.object({ fleetComplete: z.boolean() }),
    ).safeParse(await Bun.file(verdictPath).text());
    expect(observation).toMatchObject({
      success: true,
      data: { fleetComplete: false },
    });
  });

  test("WS-ADD-HANG: mise exits with retained pipes, then add returns the readiness status", async () => {
    const path = await repo(`ready = ["exit 7"]\n`);
    await Bun.write(join(path, "mise.toml"), "# fixture\n");
    expect((await jj(["commit", "-m", "mise fixture"], path)).code).toBe(0);
    const pidFile = join(scratch, "retained-pipe.pid");
    shim("mise", `sleep 30 & echo $! > "${pidFile}"; exit 0`);
    const r = await ws(["add", "retained-pipe"], path);
    // add returned without waiting for the descendant: the 30-second sleeper is still alive,
    // since signalling a process that has exited throws.
    process.kill(Number(await Bun.file(pidFile).text()), "SIGKILL");
    await unlink(join(bin, "mise"));
    expect(r.code, r.err).toBe(7);
    expect(r.err).toContain("readiness command failed (exit 7): exit 7");
    expect(existsSync(wsDir(path, "retained-pipe"))).toBe(false);
  });

  test("a failing readiness command is loud, non-zero, and leaves no workspace", async () => {
    const path = await repo('ready = ["echo boom >&2; exit 7"]\n');
    const r = await ws(["add", "bad"], path);
    expect(r.code).toBe(7);
    expect(r.err).toContain("exit 7");
    expect(existsSync(wsDir(path, "bad"))).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain("ws_bad");
  });

  test("fails before work on unmet preconditions", async () => {
    const path = await repo();
    expect((await ws(["add", "bad/slug"], path)).code).toBe(1);
    expect((await ws(["add", "x", "--rev", "nope_no_such"], path)).code).toBe(
      1,
    );
    expect(
      (await ws(["add", "x"], path, baseEnv({ FAKE_FS: "tmpfs" }))).err,
    ).toContain("RAM-backed");
    expect(existsSync(join(path, "..", "proj.ws"))).toBe(false);
    writeFileSync(join(path, "agx.toml"), "schema = 1\n[ws]\nready = 3\n");
    expect(
      (await jj(["commit", "-m", "invalid workspace policy"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@-"], path)).code).toBe(
      0,
    );
    expect((await ws(["add", "x"], path)).code).toBe(1);
    expect(existsSync(join(path, "..", "proj.ws"))).toBe(false);
    expect((await ws(["add", "x"], tmpdir())).code).toBe(1);
  });

  test("refuses an existing slug", async () => {
    const path = await repo();
    expect((await ws(["add", "dup"], path)).code).toBe(0);
    expect((await ws(["add", "dup"], path)).code).toBe(1);
    const reused = await ws(["add", "dup", "--reuse"], path);
    expect(reused.code, reused.err).toBe(0);
    expect(reused.out.trim()).toBe(wsDir(path, "dup"));
  });

  test("new workspace slugs use hyphens; legacy names remain refreshable", async () => {
    const path = await repo();
    for (const slug of ["arena_g3", "Arena-G3"]) {
      const refused = await ws(["add", slug], path);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("agx ws add arena-g3");
      expect(await Bun.file(join(wsDir(path, slug), ".jj/repo")).exists()).toBe(
        false,
      );
    }
    const accepted = await ws(["add", "arena-g3"], path);
    expect(accepted.code, accepted.err).toBe(0);
    expect(accepted.out).toContain("ws_arena-g3");
    const legacy = wsDir(path, "old_name");
    expect(
      (await jj(["workspace", "add", "--name", "ws_old_name", legacy], path))
        .code,
    ).toBe(0);
    expect((await ws(["refresh", "old_name"], path)).code).toBe(0);
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_old_name",
    );
  });
});

describe("agx ws refresh", () => {
  test("updates a rebased workspace without rerunning readiness or widening sparse", async () => {
    const path = await repo('ready = ["echo ready >> ready.out"]\n');
    expect((await ws(["add", "stale"], path)).code).toBe(0);
    const dir = wsDir(path, "stale");
    expect(
      (
        await jj(
          ["sparse", "set", "--clear", "--add", "a.txt", "--add", "ready.out"],
          dir,
        )
      ).code,
    ).toBe(0);
    expect((await jj(["new", "root()"], path)).code).toBe(0);
    await Bun.write(join(path, "destination.txt"), "destination\n");
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
    const rebased = await jj(["rebase", "-s", "main", "-d", "@"], path);
    expect(rebased.code, rebased.err).toBe(0);
    expect((await jj(["status"], dir)).err).toContain("working copy is stale");
    const r = await ws(["refresh", "stale"], path);
    expect(r.code, r.err).toBe(0);
    expect((await jj(["status"], dir)).code).toBe(0);
    expect((await jj(["sparse", "list"], dir)).out.trim()).toBe(
      "a.txt\nready.out",
    );
    expect(await Bun.file(join(dir, "ready.out")).text()).toBe("ready\n");
    expect((await ws(["refresh", "stale"], path)).code).toBe(0);
  });

  test("refuses missing and invalid slugs", async () => {
    const path = await repo();
    expect((await ws(["refresh", "missing"], path)).code).toBe(1);
    expect((await ws(["refresh", "bad/slug"], path)).code).toBe(1);
  });
});
