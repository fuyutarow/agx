import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  stat,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

setDefaultTimeout(60_000);
const scratch = await mkdtemp(join(tmpdir(), "ws-gc-lock-scope-"));
const ws = join(import.meta.dir, "../src/ws.ts");
const realJj = Bun.which("jj");
afterAll(() => rm(scratch, { recursive: true, force: true }));
let count = 0;

async function fixture(slugs: string[]) {
  const root = join(scratch, String(++count));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const lock = `${repo}.ws.lock`;
  await mkdir(bin, { recursive: true });
  const env = {
    ...subprocessEnvironment(),
    JJ_CONFIG: "",
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    AGX_STATE_DIR: join(root, "state/agx"),
    RIP_GRAVEYARD: join(root, "graveyard"),
    GRAVEYARD: join(root, "graveyard"),
    JJ_USER: "test",
    JJ_EMAIL: "test@example.com",
  };
  const run = async (cmd: string[], cwd = repo) => {
    const child = Bun.spawn(cmd, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(45_000),
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  const jj = (args: string[], cwd = repo) =>
    run([realJj ?? "jj", ...args], cwd);
  // These lock-scope fixtures exercise collection races, not the default grace policy.
  const command = (args: string[]) =>
    run([
      process.execPath,
      ws,
      ...args,
      ...(args[0] === "gc" && !args.includes("--grace-minutes")
        ? ["--grace-minutes", "0"]
        : []),
    ]);
  const commandWithEnv = (args: string[]) => {
    const commandEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };
    const child = Bun.spawn(
      [
        process.execPath,
        ws,
        ...args,
        ...(args[0] === "gc" && !args.includes("--grace-minutes")
          ? ["--grace-minutes", "0"]
          : []),
      ],
      {
        cwd: repo,
        env: commandEnv,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(45_000),
      },
    );
    return Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([out, err, code]) => ({ out, err, code }));
  };
  const shim = async (name: string, body: string) => {
    const file = join(bin, name);
    await Bun.write(file, `#!/usr/bin/env bun\n${body}\n`);
    await chmod(file, 0o755);
  };
  await mkdir(env.HOME);
  await mkdir(join(root, "config", "jj", "repos"), { recursive: true });
  expect((await jj(["git", "init", repo], root)).code).toBe(0);
  expect(
    (
      await jj(
        [
          "config",
          "set",
          "--repo",
          'revset-aliases."trunk()"',
          "bookmarks(main)",
        ],
        repo,
      )
    ).code,
  ).toBe(0);
  await Bun.write(join(repo, "a.txt"), "base\n");
  await Bun.write(join(repo, "agx.toml"), 'schema = 1\n[ws]\ntrunk = "main"\n');
  expect((await jj(["commit", "-m", "base"])).code).toBe(0);
  expect((await jj(["bookmark", "create", "main", "-r", "@-"])).code).toBe(0);
  const dir = (slug: string) => join(`${repo}.ws`, `ws_${slug}`);
  await mkdir(`${repo}.ws`);
  for (const slug of slugs)
    expect(
      (
        await jj([
          "workspace",
          "add",
          "--name",
          `ws_${slug}`,
          "-r",
          "main",
          dir(slug),
        ])
      ).code,
    ).toBe(0);
  await shim("stat", 'process.stdout.write("ext4\\n");');
  await shim("agx", 'process.stdout.write("[]");');
  return { root, repo, lock, run, jj, command, commandWithEnv, shim, dir };
}

async function waitFor(file: string) {
  const deadline = performance.now() + 30_000;
  while (!(await Bun.file(file).exists()) && performance.now() < deadline)
    await Bun.sleep(20);
  expect(await Bun.file(file).exists(), `gate ${file}`).toBe(true);
}

const delegateJj = `const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"}); process.exitCode = await child.exited;`;

// Include contents and metadata, so even a rewritten identical cache is a mutation.
async function snapshot(root: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const name of (await readdir(root)).toSorted()) {
    const path = join(root, name);
    const info = await lstat(path);
    let content: unknown;
    if (info.isDirectory()) content = await snapshot(path);
    else if (info.isSymbolicLink()) content = await readlink(path);
    else content = Bun.hash(await Bun.file(path).arrayBuffer()).toString();
    rows.push([
      name,
      info.mode,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
      content,
    ]);
  }
  return rows;
}

for (const existingState of [false, true])
  // measured 5277ms on the census of alpha under host load
  test(`AGX-GC-DRYRUN-READONLY-PARENT-1025: single and all with ${existingState ? "existing" : "missing"} state`, async () => {
    const f = await fixture(["readonly"]);
    // Freeze only the human age column; real jj reads still determine every verdict.
    await f.shim(
      "jj",
      `
const args = process.argv.slice(2).map(arg => arg.replaceAll('self.target().committer().timestamp().ago()', '"fixture age"'));
${delegateJj}`,
    );
    const state = join(f.root, "state/agx");
    if (existingState) {
      await Bun.write(
        join(state, "workspace-index.jsonl"),
        JSON.stringify({ root: f.repo, workspace: f.dir("readonly") }) + "\n",
      );
      await Bun.write(
        join(state, "workspace-verdicts.json"),
        '{"sentinel":"unchanged"}\n',
      );
    }
    await Bun.write(
      join(f.root, "config/agx/repos/fixture.toml"),
      `schema = 1\nroot = ${JSON.stringify(f.repo)}\n`,
    );
    const args = ["gc", "--dry-run", "--include-unrecorded", "--json"];
    const before = await snapshot(f.root);
    const writable = [];
    for (const scope of [["--repo", f.repo], ["--all"]]) {
      const result = await f.command([...args, ...scope]);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain("removable");
      writable.push(result);
      expect(await snapshot(f.root)).toEqual(before);
    }
    const protectedDirs = [f.root, `${f.repo}.ws`, join(f.root, "config")];
    if (existingState) protectedDirs.push(state);
    for (const dir of protectedDirs) await chmod(dir, 0o555);
    await (async () => {
      const readonlyBefore = await snapshot(f.root);
      for (const [index, scope] of [["--repo", f.repo], ["--all"]].entries()) {
        const result = await f.command([...args, ...scope]);
        expect(result.code, result.err).toBe(0);
        const expected = writable[index];
        expect(expected).toBeDefined();
        if (expected === undefined) return;
        expect(result).toEqual(expected);
        expect(await snapshot(f.root)).toEqual(readonlyBefore);
      }
    })().finally(() => {
      for (const dir of protectedDirs) chmodSync(dir, 0o755);
    });
  }, 11000);

test("WS-GC-LOCK-SCOPE: dry runs neither acquire a held lock nor snapshot dirty files", async () => {
  const f = await fixture(["dirty"]);
  await Bun.write(join(f.dir("dirty"), "pending.txt"), "unsnapshotted\n");
  const op = [
    "--ignore-working-copy",
    "op",
    "log",
    "--no-graph",
    "-n",
    "1",
    "-T",
    "id",
  ];
  const before = await f.jj(op);
  const owner = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    what: "agx ws add fixture-holder",
    since: Temporal.Now.instant().toString(),
  });
  await Bun.write(join(f.lock, "owner.json"), owner);
  await f.shim(
    "jj",
    `
const args = process.argv.slice(2);
if (!args.includes("--ignore-working-copy")) { process.stderr.write("unexpected write"); process.exit(9); }
${delegateJj}`,
  );
  const dry = await f.command(["gc", "--dry-run", "--include-unrecorded"]);
  expect(dry.code, dry.err).toBe(0);
  expect(await Bun.file(join(f.lock, "owner.json")).text()).toBe(owner);
  expect(
    await stat(`${f.lock}.waiters`).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect((await f.jj(op)).out).toBe(before.out);
  expect(await Bun.file(join(f.dir("dirty"), "pending.txt")).text()).toBe(
    "unsnapshotted\n",
  );
});

// measured 31580ms on the census of alpha under host load
test("WS-GC-LOCK-SCOPE: add acquires while the aggregate read-only classification is delayed", async () => {
  const f = await fixture(["a", "b", "c", "d", "e", "f"]);
  for (const slug of ["a", "b", "c", "d", "e", "f"]) {
    await Bun.write(join(f.dir(slug), "a.txt"), `${slug} has pending work\n`);
    expect((await f.jj(["status"], f.dir(slug))).code).toBe(0);
  }
  const gate = join(f.root, "classifying");
  await f.shim(
    "jj",
    `
const args = process.argv.slice(2);
if (args.includes("log") && args.some(arg => arg.includes("::working_copies()"))) {
  const holder = Bun.file(${JSON.stringify(join(f.lock, "owner.json"))});
  if (await holder.exists() && (await holder.text()).includes('"what":"agx ws gc')) { process.stderr.write("classification holds store lock"); process.exit(9); }
  await Bun.write(${JSON.stringify(gate)}, "started");
  await Bun.sleep(700);
}
${delegateJj}`,
  );
  const gc = f.commandWithEnv(["gc", "--include-unrecorded"]);
  await waitFor(gate);
  const started = performance.now();
  const added = await f.commandWithEnv(["add", "admitted"]);
  expect(added.code, added.err).toBe(0);
  expect(performance.now() - started).toBeLessThan(7_000);
  expect(await Bun.file(join(f.dir("admitted"), "a.txt")).exists()).toBe(true);
  const collected = await gc;
  expect(collected.code, collected.err).toBe(0);
  expect(collected.out).not.toContain("classification holds store lock");
}, 64000);

test("WS-GC-LOCK-SCOPE: waiting add gets the next turn after one removal; wait names holder and time", async () => {
  const f = await fixture(["a"]);
  const gate = join(f.root, "removing");
  const events = join(f.root, "events.jsonl");
  await Bun.write(events, "");
  await f.shim(
    "jj",
    `
const args = process.argv.slice(2);
if (args.includes("add")) {
  const file = Bun.file(${JSON.stringify(events)});
  await Bun.write(file, await file.text() + JSON.stringify("add acquired") + "\\n");
}
if (args.includes("forget") && args.includes("ws_a")) {
  const file = Bun.file(${JSON.stringify(events)});
  await Bun.write(file, await file.text() + JSON.stringify("removal") + "\\n");
  await Bun.write(${JSON.stringify(gate)}, "started");
  const {readdir} = await import("node:fs/promises");
  const {join} = await import("node:path");
  const waiterDir = ${JSON.stringify(`${f.lock}.waiters`)};
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const entries = await readdir(waiterDir).catch(() => []);
    const queued = await Promise.all(entries.map(entry => Bun.file(join(waiterDir, entry)).text().catch(() => "")));
    if (queued.some(owner => owner.includes('"what":"agx ws add admitted"'))) break;
    await Bun.sleep(20);
  }
  await Bun.sleep(6_200);
}
${delegateJj}`,
  );
  const gc = f.command(["gc", "--include-unrecorded"]);
  await waitFor(gate);
  const started = performance.now();
  const added = await f.command(["add", "admitted"]);
  const elapsed = performance.now() - started;
  expect(added.code, added.err).toBe(0);
  expect(
    elapsed,
    `${added.err}\n${await Bun.file(events).text()}`,
  ).toBeLessThan(13_000);
  expect(added.err).toMatch(
    /waiting [5-9]\d*s for agx ws gc ws_a \(pid \d+, host .+, since .+\) on /u,
  );
  const collected = await gc;
  expect(collected.code, collected.err).toBe(0);
  const order = (await Bun.file(events).text()).trim().split("\n");
  expect(order.indexOf(JSON.stringify("add acquired"))).toBe(1);
  expect(
    await stat(`${f.lock}.waiters`).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("WS-GC-LOCK-SCOPE: changed working copy and run verdicts are re-checked while locked", async () => {
  for (const change of ["file", "untracked", "run"] as const) {
    const f = await fixture(["changed"]);
    const gate = join(f.root, "rechecked");
    const initial = join(f.root, "initial-classification");
    const row = [
      {
        id: "new-run",
        state: "running",
        workspace: f.dir("changed"),
        cwd: f.dir("changed"),
        continues: null,
      },
    ];
    if (change === "run") {
      await f.shim(
        "agx",
        `
const locked = await Bun.file(${JSON.stringify(join(f.lock, "owner.json"))}).exists();
const previous = Bun.file(${JSON.stringify(initial)});
const recheck = await previous.exists() && locked;
await Bun.write(previous, "first inventory seen");
if (recheck) await Bun.write(${JSON.stringify(gate)}, "under lock");
process.stdout.write(JSON.stringify(recheck ? ${JSON.stringify(row)} : []));`,
      );
    } else {
      await f.shim(
        "jj",
        `
const args = process.argv.slice(2);
if (args.includes("log") && args.some(arg => arg.includes("::working_copies()"))) {
  const previouslyClassified = await Bun.file(${JSON.stringify(initial)}).exists();
  const locked = await Bun.file(${JSON.stringify(join(f.lock, "owner.json"))}).exists();
  if (!previouslyClassified) await Bun.write(${JSON.stringify(initial)}, "first classification seen");
  else if (locked) {
  await Bun.write(${JSON.stringify(join(f.dir("changed"), change === "file" ? "a.txt" : "pending.txt"))}, "keep this work\\n");
  await Bun.write(${JSON.stringify(gate)}, "under lock");
  }
}
${delegateJj}`,
      );
    }
    const collected = await f.commandWithEnv(["gc", "--include-unrecorded"]);
    expect(collected.code, collected.err).toBe(0);
    expect(await Bun.file(gate).text()).toBe("under lock");
    const reason = {
      file: "unsnapshotted working-copy changes: yes: bytes differ at a.txt",
      untracked: "untracked content: 1 files (pending.txt)",
      run: "live or continuing run new-run",
    };
    expect(collected.out).toContain(reason[change]);
    expect(collected.out).not.toContain("\tcollected\t");
    expect(await Bun.file(join(f.dir("changed"), "a.txt")).exists()).toBe(true);
    expect(
      (await f.jj(["--ignore-working-copy", "workspace", "list"])).out,
    ).toContain("ws_changed");
  }
});

test("WS-GC-LOCK-SCOPE: gc skips a repository locked by add", async () => {
  const f = await fixture(["kept"]);
  await Bun.write(
    join(f.lock, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      what: "agx ws add owner",
      since: Temporal.Now.instant().toString(),
    }),
  );
    const collected = await f.commandWithEnv(["gc", "--include-unrecorded"]);
  expect(collected.code, collected.err).toBe(0);
  expect(collected.out).toContain("agx ws add owner");
  expect(collected.out).toContain("collection skipped");
  expect(await Bun.file(join(f.dir("kept"), "a.txt")).exists()).toBe(true);
  const owner = jsonOf(z.object({ what: z.string() })).safeParse(
    await Bun.file(join(f.lock, "owner.json")).text(),
  );
  expect(owner.success && owner.data.what).toBe("agx ws add owner");
});
