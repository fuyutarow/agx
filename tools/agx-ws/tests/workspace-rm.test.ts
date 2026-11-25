// `agx ws rm`. Split from workspace.test.ts so that the gate runs the parts side by side.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { mkdir, chmod, unlink, symlink } from "node:fs/promises";
import {
  scratch,
  bin,
  baseEnv,
  ws,
  jj,
  pushBookmark,
  setRecords,
  seq,
  repo,
  wsDir,
  symlinkTargets,
} from "./workspace-fixture.ts";

setDefaultTimeout(60_000);

describe("agx ws rm", () => {
  test("removes only the removed workspace's tracked and trusted mise entries", async () => {
    const path = await repo(
      'trunk = "main"\nready = ["mise trust -q mise.toml"]\n',
    );
    await Bun.write(join(path, "mise.toml"), '[env]\nWS_FIXTURE = "yes"\n');
    expect(
      (await jj(["commit", "-m", "mise workspace fixture"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@"], path)).code).toBe(
      0,
    );
    const env = baseEnv({
      MISE_STATE_DIR: join(scratch, `mise-state-untrack-${++seq.n}`),
    });
    expect((await ws(["add", "removed"], path, env)).code).toBe(0);
    expect((await ws(["add", "live"], path, env)).code).toBe(0);

    const removedDir = wsDir(path, "removed");
    const liveDir = wsDir(path, "live");
    const trackedDir = join(env.MISE_STATE_DIR ?? "", "tracked-configs");
    const trustedDir = join(env.MISE_STATE_DIR ?? "", "trusted-configs");
    const trackedTargets = (): string[] => symlinkTargets(trackedDir);
    const trustedTargets = (): string[] => symlinkTargets(trustedDir);
    const removedConfig = join(removedDir, "mise.toml");
    const liveConfig = join(liveDir, "mise.toml");
    expect(trackedTargets()).toContain(removedConfig);
    expect(trackedTargets()).toContain(liveConfig);
    expect(trustedTargets()).toContain(removedConfig);
    expect(trustedTargets()).toContain(liveConfig);

    const result = await ws(["rm", "removed"], path, env);
    expect(result.code, result.err).toBe(0);
    expect(trackedTargets()).not.toContain(removedConfig);
    expect(trustedTargets()).not.toContain(removedConfig);
    expect(trackedTargets()).toContain(liveConfig);
    expect(trustedTargets()).toContain(liveConfig);
  });

  test("removes matching mise links when mise is absent from PATH", async () => {
    const path = await repo(
      'trunk = "main"\nready = ["mise trust -q mise.toml"]\n',
    );
    await Bun.write(join(path, "mise.toml"), '[env]\nWS_FIXTURE = "yes"\n');
    expect(
      (await jj(["commit", "-m", "mise no-command fixture"], path)).code,
    ).toBe(0);
    expect((await jj(["bookmark", "set", "main", "-r", "@"], path)).code).toBe(
      0,
    );
    const env = baseEnv({
      MISE_STATE_DIR: join(scratch, `mise-state-no-command-${++seq.n}`),
    });
    expect((await ws(["add", "no-command"], path, env)).code).toBe(0);

    const misePath = Bun.which("mise");
    expect(misePath).not.toBeNull();
    const noMiseBin = join(scratch, `no-mise-bin-${seq.n}`);
    mkdirSync(noMiseBin);
    for (const command of ["bun", "jj", "rip"]) {
      const resolved = Bun.which(command);
      expect(resolved).not.toBeNull();
      await symlink(realpathSync(resolved ?? ""), join(noMiseBin, command));
    }
    const withoutMise = [
      noMiseBin,
      ...(env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => !existsSync(join(directory, "mise"))),
    ].join(delimiter);
    const dir = wsDir(path, "no-command");
    const config = join(dir, "mise.toml");
    const state = env.MISE_STATE_DIR ?? "";
    const removed = await ws(["rm", "no-command"], path, {
      ...env,
      PATH: withoutMise,
    });
    expect(removed.code, removed.err).toBe(0);
    expect(removed.err).toContain("mise command cleanup skipped");
    expect(symlinkTargets(join(state, "tracked-configs"))).not.toContain(
      config,
    );
    expect(symlinkTargets(join(state, "trusted-configs"))).not.toContain(
      config,
    );
  });

  test("removes a landed workspace: forgotten and ripped", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "clean"], path);
    const r = await ws(["rm", "clean"], path);
    expect(r.code).toBe(0);
    expect(existsSync(wsDir(path, "clean"))).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_clean",
    );
  });

  test("removes a workspace whose only non-trunk change is on a remote bookmark", async () => {
    const path = await repo('trunk = "main"\n');
    expect((await ws(["add", "pushed"], path)).code).toBe(0);
    const dir = wsDir(path, "pushed");
    await Bun.write(join(dir, "pushed.txt"), "remote has this\n");
    expect((await jj(["commit", "-m", "pushed work"], dir)).code).toBe(0);
    await pushBookmark(dir, "feature-pushed");
    const removed = await ws(["rm", "pushed"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("refuses an unlanded commit and an uncommitted edit; nothing is lost", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "dirty"], path);
    const dir = wsDir(path, "dirty");
    writeFileSync(join(dir, "work.txt"), "w\n");
    const edit = await ws(["rm", "dirty"], path);
    expect(edit.code).toBe(1);
    expect(edit.err).toContain("unlanded");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
    await jj(["commit", "-m", "work"], dir);
    const committed = await ws(["rm", "dirty"], path);
    expect(committed.code).toBe(1);
    expect(committed.err).toContain("work");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).toContain("ws_dirty");
  });

  test("uses the registered commit when the workspace-local @ cannot be read", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "registered-fallback"], path);
    const dir = wsDir(path, "registered-fallback");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-local-log-failure");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log")) {
  process.stderr.write("injected missing workspace @\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const removed = await ws(
      ["rm", "registered-fallback"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("preserves disk edits when local @ fails but the registered revision resolves", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "registered-disk-diff"], path);
    const dir = wsDir(path, "registered-disk-diff");
    await Bun.write(join(dir, "a.txt"), "unlanded disk edit\n");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-local-log-failure-with-diff");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log")) {
  process.stderr.write("injected missing workspace @\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const refused = await ws(
      ["rm", "registered-disk-diff"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("tracked files differ from main: a.txt");
    expect(existsSync(dir)).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe(
      "unlanded disk edit\n",
    );
  });

  test("refuses broken-workspace removal when a trunk-tracked file differs on disk", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "broken-diff"], path);
    const dir = wsDir(path, "broken-diff");
    await Bun.write(join(dir, "a.txt"), "changed on disk\n");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-broken-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const local = process.cwd() === ${JSON.stringify(dir)} && args.includes("log");
const registered = args.includes("log") && args.some((arg) => arg.includes("broken-diff@"));
if (local || registered) {
  process.stderr.write("injected missing working-copy revision\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const refused = await ws(
      ["rm", "broken-diff"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("injected missing working-copy revision");
    expect(existsSync(dir)).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("changed on disk\n");
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_broken-diff",
    );
  });

  test("refuses a broken workspace when its registered revision cannot be judged", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "broken-clean"], path);
    const dir = wsDir(path, "broken-clean");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-broken-clean-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
const local = process.cwd() === ${JSON.stringify(dir)} && args.includes("log");
const registered = args.includes("log") && args.some((arg) => arg.includes("broken-clean@"));
if (local || registered) {
  process.stderr.write("injected missing working-copy revision\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const removed = await ws(
      ["rm", "broken-clean"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(removed.code).toBe(1);
    expect(removed.err).toContain("injected missing working-copy revision");
    expect(existsSync(dir)).toBe(true);
    expect((await jj(["workspace", "list"], path)).out).toContain(
      "ws_broken-clean",
    );
  });

  test("removes unregistered broken directories only when trunk files match", async () => {
    const path = await repo();
    const changed = wsDir(path, "orphan-changed");
    const clean = wsDir(path, "orphan-clean");
    await mkdir(changed, { recursive: true });
    await mkdir(clean, { recursive: true });
    await Bun.write(join(changed, "a.txt"), "unlanded disk edit\n");
    await Bun.write(join(clean, "a.txt"), "a\n");
    const refused = await ws(["rm", "orphan-changed"], path);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("tracked files differ from trunk(): a.txt");
    expect(existsSync(changed)).toBe(true);
    const removed = await ws(["rm", "orphan-clean"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(clean)).toBe(false);
  });

  test("gc classifies from aggregate revisions without a local @ query", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "missing-revision"], path);
    setRecords([]);
    const dir = wsDir(path, "missing-revision");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-missing-working-copy-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("log") && args.includes("@")) {
  process.stderr.write("working copy revision missing\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const report = await ws(
      ["gc", "--dry-run", "--include-unrecorded"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(report.code, report.err).toBe(0);
    expect(report.out).toContain(`${dir}\tws\tremovable\t`);
  });

  test("gc classifies from aggregate revisions without a local status query", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "status-missing-revision"], path);
    setRecords([]);
    const dir = wsDir(path, "status-missing-revision");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    const wrapper = join(scratch, "jj-status-missing-working-copy-revision");
    await mkdir(wrapper);
    await Bun.write(
      join(wrapper, "jj"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(dir)} && args.includes("status")) {
  process.stderr.write("working copy revision missing\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], {stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;
`,
    );
    await chmod(join(wrapper, "jj"), 0o755);
    const report = await ws(
      ["gc", "--dry-run", "--include-unrecorded"],
      path,
      baseEnv({ PATH: `${wrapper}:${bin}:${process.env.PATH}` }),
    );
    expect(report.code, report.err).toBe(0);
    expect(report.out).toContain(`${dir}\tws\tremovable\t`);
  });

  test("gc reports broken metadata when jj no longer has the workspace checkout pointer", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "missing-checkout-pointer"], path);
    await ws(["add", "healthy"], path);
    setRecords([]);
    const dir = wsDir(path, "missing-checkout-pointer");
    const healthy = wsDir(path, "healthy");
    await unlink(join(dir, ".jj", "working_copy", "checkout"));
    const report = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(report.code, report.err).toBe(1);
    expect(report.out).toContain(`${dir}\tws\tbroken\t`);
    expect(report.out).toContain("workspace metadata is invalid");
    expect(report.out).toContain(`${healthy}\tws\tremovable\t`);
  });

  test("gc reports broken when jj cannot resolve a corrupted checkout id", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "corrupt-checkout-id"], path);
    await ws(["add", "healthy"], path);
    setRecords([]);
    const dir = wsDir(path, "corrupt-checkout-id");
    const healthy = wsDir(path, "healthy");
    await Bun.write(
      join(dir, ".jj", "working_copy", "checkout"),
      "not-a-jj-checkout-id\n",
    );
    const status = await jj(["--ignore-working-copy", "status"], dir);
    expect(status.code).not.toBe(0);
    const report = await ws(["gc", "--dry-run", "--include-unrecorded"], path);
    expect(report.code, report.err).toBe(1);
    expect(report.out).toContain(`${dir}\tws\tbroken\t`);
    expect(report.out).toContain(
      "checkout does not identify ws_corrupt-checkout-id",
    );
    expect(report.out).toContain(`${healthy}\tws\tremovable\t`);
  });

  test("rm forgets and buries a registered workspace with a missing checkout pointer", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "missing-checkout-rm"], path);
    const dir = wsDir(path, "missing-checkout-rm");
    await unlink(join(dir, ".jj", "working_copy", "checkout"));
    const removed = await ws(["rm", "missing-checkout-rm"], path);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect((await jj(["workspace", "list"], path)).out).not.toContain(
      "ws_missing-checkout-rm",
    );
  });

  test("refuses when the graveyard is RAM-backed", async () => {
    const path = await repo('trunk = "main"\n');
    await ws(["add", "ram"], path);
    const r = await ws(["rm", "ram"], path, baseEnv({ FAKE_FS: "ramfs" }));
    expect(r.code).toBe(1);
    expect(existsSync(wsDir(path, "ram"))).toBe(true);
  });
});
