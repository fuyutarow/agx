import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { writeChangeset } from "../changeset/changeset.ts";
import { applyChangesets } from "../changeset/apply.ts";
import { jsonOf, z } from "../zod.ts";
import { attempt } from "../shared/src/attempt.ts";
import {
  build as productionBuild,
  changelogSection,
  packageInfo,
  platform,
  packages,
  suiteNotes,
  suiteTargets,
  suiteArchiveName,
  repository,
  run as productionRun,
  publishCI,
  publish,
  machineSwap,
} from "./release.ts";

import { fixtureRun, fixtureRun as run } from "./fixture-runner.ts";

const build = (pkg: string, target: string | undefined, root: string) =>
  productionBuild(pkg, target, root, run);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(pkg = "agx-status") {
  const root = await mkdtemp(join(tmpdir(), "package-release-"));
  roots.push(root);
  const dir = join(root, "tools", pkg);
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@agx/${pkg}`,
      version: "2.3.4",
      bin:
        pkg === "xmsg"
          ? { "agx-msg": "src/main.ts", xmsg: "src/main.ts" }
          : { [pkg]: "src/main.ts" },
    }),
  );
  await Bun.write(
    join(dir, "src/main.ts"),
    'process.stdout.write("fixture executable\\n");\n',
  );
  await Bun.write(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## 2.3.4\n\n- This version only.\n\n## 2.3.3\n\n- Earlier version.\n",
  );
  await Bun.write(join(root, "tools/agx/package.json"), '{"version":"2.3.4"}');
  await Bun.write(
    join(root, "CHANGELOG.md"),
    await Bun.file(join(dir, "CHANGELOG.md")).text(),
  );
  await Bun.write(join(root, "package.json"), '{"version":"99.99.99"}');
  await mkdir(join(root, "tools/release"), { recursive: true });
  for (const file of [
    "build.ts",
    "ci.ts",
    "launcher.ts",
    "publish.ts",
    "release.ts",
    "fixture-runner.ts",
    "fake-gh.ts",
    "machine.ts",
  ])
    await Bun.write(
      join(
        root,
        "tools/release",
        file === "release.ts" ? "implementation.ts" : file,
      ),
      Bun.file(join(import.meta.dir, file)),
    );
  await Bun.write(
    join(root, "tools/release/release.ts"),
    `
import * as release from "./implementation.ts";
import { fixtureRun } from "./fixture-runner.ts";
export const build = (pkg, target) => release.build(pkg, target, ${JSON.stringify(root)}, fixtureRun);
export const publish = (pkg, yes, target, _root, _runner, machine) => release.publish(pkg, yes, target, ${JSON.stringify(root)}, fixtureRun, machine);
export const publishCI = (tag) => release.publishCI(tag === "suite" ? undefined : tag, ${JSON.stringify(root)}, fixtureRun);
`,
  );
  await symlink(join(repository, "tools/zod.ts"), join(root, "tools/zod.ts"));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await Bun.write(join(root, ".gitignore"), "dist/\ncalls\n");
  return { root, dir, pkg };
}

async function preview(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(
        f.root,
        env.RELEASE_TEST_CI === "1"
          ? "tools/release/ci.ts"
          : "tools/release/publish.ts",
      ),
      f.pkg,
      ...args,
    ],
    {
      cwd: f.root,
      env: {
        ...process.env,
        RELEASE_TEST_FAST_LIBRARY: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

async function previewCI(
  f: Awaited<ReturnType<typeof fixture>>,
  env: Record<string, string>,
) {
  // Keep the old publisher CLI as a test-only envelope for the runner-side function.
  const result = await preview(f, [], { ...env, RELEASE_TEST_CI: "1" });
  return result;
}

async function git(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const result = await run(["git", ...args], f.root, true);
  expect(result.exit, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function gitSuiteFixture() {
  const f = await suiteFixture();
  await git(f, ["init", "-b", "alpha"]);
  await git(f, ["config", "user.email", "release-test@example.invalid"]);
  await git(f, ["config", "user.name", "Release test"]);
  await git(f, ["add", "-A"]);
  await git(f, ["commit", "-m", "fixture"]);
  const alpha = await git(f, ["rev-parse", "HEAD"]);
  await git(f, ["update-ref", "refs/remotes/origin/alpha", alpha]);
  return { ...f, alpha };
}

const realGit = { RELEASE_TEST_REAL_GIT: "1" };

const fakeGhProductionRun: typeof productionRun = (cmd, cwd, options) =>
  productionRun(
    [process.execPath, join(import.meta.dir, "fake-gh.ts"), ...cmd.slice(1)],
    cwd,
    options,
  );
const completionRun: typeof productionRun = (cmd, cwd, options) =>
  cmd[0] === "gh" && cmd[1] === "release"
    ? fakeGhProductionRun(cmd, cwd, options)
    : installProductionRun(cmd, cwd, options);
const installProductionRun: typeof productionRun = async (
  cmd,
  cwd,
  options,
) => {
  const record = async (args: string[]) => {
    const path = join(process.env.RELEASE_TEST_LOG_ROOT ?? cwd, "calls");
    await Bun.write(
      path,
      `${await Bun.file(path)
        .text()
        .catch(() => "")}${JSON.stringify(args)}\n`,
    );
  };
  if (cmd[0] === "gh" && cmd[1] === "release" && cmd[2] === "view") {
    await record(cmd.slice(1));
    const assets = suiteTargets.map((target) => ({
      name: suiteArchiveName("2.3.4", target)._unsafeUnwrap(),
      state: "uploaded",
      size: 32,
    }));
    return process.env.RELEASE_TEST_GH_MODE === "machine-missing"
      ? {
          exit: 0,
          stdout: JSON.stringify({ assets: [], isDraft: true }),
          stderr: "",
        }
      : {
          exit: 0,
          stdout: JSON.stringify({ assets, isDraft: false }),
          stderr: "",
        };
  }
  if (cmd[0] === "gh" && cmd[1] === "api") {
    await record(cmd.slice(1));
    return { exit: 0, stdout: "alpha\n", stderr: "" };
  }
  if (cmd[0] === "curl") {
    await record(cmd.slice(1));
    const previous = Number(process.env.RELEASE_TEST_FORMULA_OLD_COUNT ?? 0);
    if (previous > 0) {
      process.env.RELEASE_TEST_FORMULA_OLD_COUNT = String(previous - 1);
      await Bun.write(
        join(process.env.RELEASE_TEST_LOG_ROOT ?? cwd, "polled"),
        "formula not ready\n",
      );
      return {
        exit: 0,
        stdout: 'class Agx < Formula\n  version "2.3.3"\nend\n',
        stderr: "",
      };
    }
    if (process.env.RELEASE_TEST_FORMULA_FAIL === "1")
      return { exit: 1, stdout: "", stderr: "formula fetch failed\n" };
    return {
      exit: 0,
      stdout: `class Agx < Formula\n  version "2.3.4"\nend\n`,
      stderr: "",
    };
  }
  if (cmd[0] === "/home/linuxbrew/.linuxbrew/bin/brew") {
    await record(cmd);
    if (cmd[1] === "list")
      return process.env.RELEASE_TEST_BREW_ABSENT === "1"
        ? { exit: 1, stdout: "", stderr: "not installed\n" }
        : { exit: 0, stdout: "agx\n", stderr: "" };
    if (cmd[1] === "--prefix")
      return {
        exit: 0,
        stdout: `${process.env.RELEASE_TEST_BREW_PREFIX}\n`,
        stderr: "",
      };
    if (
      cmd[1] === "update" &&
      process.env.RELEASE_TEST_PIPE_CHILD_PID !== undefined
    ) {
      const child = Bun.spawn(
        [process.execPath, "-e", "await Bun.sleep(300000)"],
        { stdout: "inherit", stderr: "inherit" },
      );
      await Bun.write(
        process.env.RELEASE_TEST_PIPE_CHILD_PID,
        String(child.pid),
      );
      child.unref();
    }
    if (
      cmd[1] === "update" &&
      process.env.RELEASE_TEST_BREW_DELAY_MS !== undefined
    )
      await Bun.sleep(Number(process.env.RELEASE_TEST_BREW_DELAY_MS));
    if (cmd[1] === "update" && process.env.RELEASE_TEST_BREW_FAIL === "1")
      return { exit: 1, stdout: "", stderr: "brew update failed\n" };
    return { exit: 0, stdout: "", stderr: "" };
  }
  if (cmd[0] === "which" && cmd[1] === "agx") {
    await record(cmd);
    return {
      exit: 0,
      stdout: `${process.env.RELEASE_TEST_NON_BREW_PATH === "1" ? "/usr/local/bin/agx" : `${process.env.RELEASE_TEST_BREW_PREFIX}/bin/agx`}\n`,
      stderr: "",
    };
  }
  if (cmd[0] === "agx" && cmd[1] === "-V") {
    await record(cmd);
    return {
      exit: 0,
      stdout:
        cwd === process.env.RELEASE_TEST_STALE_DIR
          ? "agx 2.3.3\n"
          : "agx 2.3.4\n",
      stderr: "",
    };
  }
  if (cmd[0] === "gh" && cmd[1] === "workflow" && cmd[2] === "run") {
    await record(cmd.slice(1));
    return process.env.RELEASE_TEST_WORKFLOW_FAIL === "1"
      ? { exit: 1, stdout: "", stderr: "workflow dispatch fixture failure" }
      : { exit: 0, stdout: "", stderr: "" };
  }
  if (cmd[0] === "gh" && cmd[1] === "run" && cmd[2] === "list") {
    await record(cmd.slice(1));
    let urls: { url: string }[] = [];
    if (process.env.RELEASE_TEST_NO_RUN !== "1") {
      const url =
        cmd[cmd.indexOf("--workflow") + 1] === "update-formulas.yml"
          ? "https://github.com/fuyutarow/homebrew-tap/actions/runs/456"
          : "https://github.com/fuyutarow/agx/actions/runs/123";
      urls = [{ url }];
    }
    return {
      exit: 0,
      stdout: JSON.stringify(urls),
      stderr: "",
    };
  }
  return cmd[0] === "gh" && cmd[1] === "release"
    ? fakeGhProductionRun(cmd, cwd, options)
    : fixtureRun(cmd, cwd);
};

test("brew update completes while a descendant holds output pipes for five minutes", async () => {
  const f = await suiteFixture();
  const pidPath = join(f.root, "pipe-child.pid");
  const previous = process.env.RELEASE_TEST_PIPE_CHILD_PID;
  const mode = process.env.RELEASE_TEST_GH_MODE;
  process.env.RELEASE_TEST_PIPE_CHILD_PID = pidPath;
  process.env.RELEASE_TEST_GH_MODE = "success";
  await (async () => {
    for (const complete of [
      () => machineSwap("2.3.4", {}, f.root, installProductionRun),
    ]) {
      await (async () => {
        const started = performance.now();
        const result = await complete();
        expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
        expect(performance.now() - started).toBeLessThan(1500);
        const pid = Number(await Bun.file(pidPath).text());
        expect(pid).toBeGreaterThan(0);
        expect(process.kill(pid, 0)).toBe(true);
      })().finally(() => {
        if (existsSync(pidPath)) {
          process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
          rmSync(pidPath);
        }
      });
    }
  })().finally(() => {
    if (previous === undefined) delete process.env.RELEASE_TEST_PIPE_CHILD_PID;
    else process.env.RELEASE_TEST_PIPE_CHILD_PID = previous;
    if (mode === undefined) delete process.env.RELEASE_TEST_GH_MODE;
    else process.env.RELEASE_TEST_GH_MODE = mode;
  });
}, 10_000);

test("publish and machine survive a three-minute fake brew update", async () => {
  const f = await suiteFixture();
  const realTime = process.env.RELEASE_TEST_SLOW_INSTALL === "1";
  const oldDelay = process.env.RELEASE_TEST_BREW_DELAY_MS;
  const oldMode = process.env.RELEASE_TEST_GH_MODE;
  process.env.RELEASE_TEST_BREW_DELAY_MS = realTime ? "180000" : "180";
  process.env.RELEASE_TEST_GH_MODE = "success";
  await (async () => {
    const started = performance.now();
    const results = await Promise.all([
      publish("suite", true, undefined, f.root, installProductionRun),
      machineSwap(
        "2.3.4",
        { formulaSeconds: 300 },
        f.root,
        installProductionRun,
      ),
    ]);
    for (const result of results)
      expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
    if (realTime) expect(performance.now() - started).toBeGreaterThan(120_000);
  })().finally(() => {
    if (oldDelay === undefined) delete process.env.RELEASE_TEST_BREW_DELAY_MS;
    else process.env.RELEASE_TEST_BREW_DELAY_MS = oldDelay;
    if (oldMode === undefined) delete process.env.RELEASE_TEST_GH_MODE;
    else process.env.RELEASE_TEST_GH_MODE = oldMode;
  });
}, 200_000);

test("formula timeout reports the target version before Homebrew", async () => {
  const f = await suiteFixture();
  const previous = process.env.RELEASE_TEST_FORMULA_FAIL;
  const mode = process.env.RELEASE_TEST_GH_MODE;
  process.env.RELEASE_TEST_FORMULA_FAIL = "1";
  process.env.RELEASE_TEST_GH_MODE = "success";
  await (async () => {
    const result = await machineSwap(
      "2.3.4",
      { formulaSeconds: 0.05 },
      f.root,
      installProductionRun,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain(
        "Formula/agx.rb on alpha did not name 2.3.4 within 50 ms",
      );
    }
    for (const formulaSeconds of [0, -1, NaN, Infinity, 3_000_000]) {
      const invalid = await machineSwap(
        "2.3.4",
        { formulaSeconds },
        f.root,
        () => {
          expect.unreachable("invalid input must not spawn");
        },
      );
      expect(invalid.isErr() && invalid.error).toContain(
        "invalid formula interval",
      );
    }
  })().finally(() => {
    if (previous === undefined) delete process.env.RELEASE_TEST_FORMULA_FAIL;
    else process.env.RELEASE_TEST_FORMULA_FAIL = previous;
    if (mode === undefined) delete process.env.RELEASE_TEST_GH_MODE;
    else process.env.RELEASE_TEST_GH_MODE = mode;
  });
});

test("publish and machine allow three-minute fake CI with a scaled command clock", async () => {
  const f = await suiteFixture();
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const limits: number[] = [];
  // One millisecond represents one second: the old 120 s limit kills this
  // 180 s fake CI; the asset deadline permits it. No real gh is executed.
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    limits.push(ms);
    return originalTimeout(Math.ceil(ms / 1000));
  });
  const oldDelay = process.env.RELEASE_TEST_CI_DELAY_MS;
  const oldMode = process.env.RELEASE_TEST_GH_MODE;
  process.env.RELEASE_TEST_CI_DELAY_MS = "180";
  process.env.RELEASE_TEST_GH_MODE = "success";
  await (async () => {
    for (const complete of [
      () => publish("suite", true, undefined, f.root, completionRun),
      () => machineSwap("2.3.4", {}, f.root, completionRun),
    ]) {
      const result = await complete();
      expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
    }
    expect(limits).toHaveLength(2);
    expect(limits.every((limit) => limit > 899_000 && limit <= 900_000)).toBe(
      true,
    );
    const ordinary = await productionRun(
      [process.execPath, "-e", "await Bun.sleep(180)"],
      f.root,
    );
    expect(limits.at(-1)).toBe(120_000);
    expect(ordinary.exit).toBe(124);
    expect(ordinary.stderr).toContain("Command timed out after");
    expect(ordinary.stderr).toContain("ms (limit 120000 ms)");
    expect(ordinary.stderr).toContain("await Bun.sleep(180)");
  })().finally(() => {
    timeout.mockRestore();
    if (oldDelay === undefined) delete process.env.RELEASE_TEST_CI_DELAY_MS;
    else process.env.RELEASE_TEST_CI_DELAY_MS = oldDelay;
    if (oldMode === undefined) delete process.env.RELEASE_TEST_GH_MODE;
    else process.env.RELEASE_TEST_GH_MODE = oldMode;
  });
});

test("fake gh starts the tap formula workflow before brew and PATH checks", async () => {
  const f = await suiteFixture();
  const consumer = join(f.root, "consumer with spaces");
  await mkdir(consumer);
  const result = await machineSwap(
    "2.3.4",
    { waitSeconds: 0, verifyIn: [consumer] },
    f.root,
    installProductionRun,
  );
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  const calls = (await Bun.file(join(f.root, "calls")).text())
    .trim()
    .split("\n");
  const assetWait = calls.findIndex((line) =>
    line.startsWith('["release","view"'),
  );
  const trigger = calls.findIndex((line) =>
    line.startsWith('["workflow","run"'),
  );
  const runList = calls.findIndex((line) => line.startsWith('["run","list"'));
  expect(trigger).toBeGreaterThan(assetWait);
  expect(runList).toBeGreaterThan(trigger);
  expect(calls[trigger]).toBe(
    JSON.stringify([
      "workflow",
      "run",
      "update-formulas.yml",
      "-R",
      "fuyutarow/homebrew-tap",
      "-f",
      "tool=agx",
    ]),
  );
  const callsText = calls.join("\n");
  expect(callsText).toContain(
    JSON.stringify(["/home/linuxbrew/.linuxbrew/bin/brew", "update"]),
  );
  expect(callsText).toContain(
    JSON.stringify([
      "/home/linuxbrew/.linuxbrew/bin/brew",
      "upgrade",
      "fuyutarow/tap/agx",
    ]),
  );
  expect(callsText).toContain(JSON.stringify(["which", "agx"]));
  expect(callsText).toContain(JSON.stringify(["agx", "-V"]));
  expect(callsText).not.toContain("mise");
});

test("asset deadline bounds a stuck fake gh and names the command", async () => {
  const f = await suiteFixture();
  const previous = process.env.RELEASE_TEST_CI_DELAY_MS;
  process.env.RELEASE_TEST_CI_DELAY_MS = "180";
  await (async () => {
    const result = await machineSwap(
      "2.3.4",
      { waitSeconds: 0.05 },
      f.root,
      fakeGhProductionRun,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("timed out after 50 ms");
      expect(result.error).toContain("fake-gh.ts");
      expect(result.error).toContain("'release' 'view' 'v2.3.4'");
    }
  })().finally(() => {
    if (previous === undefined) delete process.env.RELEASE_TEST_CI_DELAY_MS;
    else process.env.RELEASE_TEST_CI_DELAY_MS = previous;
  });
});

test("command fixtures refuse network Git and unknown processes and intercept gh", async () => {
  const f = await fixture();
  for (const cmd of [
    ["git", "fetch", "https://example.invalid/repo"],
    ["git", "push", "origin", "alpha"],
    ["git", "ls-remote", "origin"],
    ["curl", "https://example.invalid"],
  ]) {
    const result = await run(cmd, f.root, true);
    expect(result.exit).toBe(98);
    expect(result.stderr).toContain("Forbidden");
  }
  const github = await run(
    ["gh", "release", "create", "fixture"],
    f.root,
    true,
  );
  expect(github.exit).toBe(99);
  expect(await Bun.file(join(f.root, "calls")).text()).toContain(
    '["release","create","fixture"]',
  );
});

test("package versions, tags and archive names ignore the repository version", async () => {
  const f = await fixture();
  const info = await packageInfo("agx-status", f.root);
  expect(info.isOk() && info.value.tag).toBe("v2.3.4");
  const result = await build("agx-status", undefined, f.root);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return;
  expect(result.value.archive).toEndWith(
    `agx-status-2.3.4-${process.platform}-${process.arch}.tar.gz`,
  );
  expect(result.value.sha256).toMatch(/^[a-f\d]{64}$/u);
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  expect(listing.exit).toBe(0);
  expect(listing.stdout.trim().split("\n").toSorted()).toEqual([
    "bin/",
    "bin/agx-status",
  ]);
  const executable = await run(
    [join(f.root, "dist/agx-status/bin/agx-status")],
    f.root,
  );
  expect(executable.exit).toBe(0);
  expect(executable.stdout).toBe("fixture executable\n");
});

test("xmsg archive compiles agx-msg once and preserves its hard-link alias", async () => {
  const f = await fixture("xmsg");
  await mkdir(join(f.root, "dist/xmsg/bin"), { recursive: true });
  await Bun.write(join(f.root, "dist/xmsg/bin/stale"), "old");
  const result = await build("xmsg", undefined, f.root);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return;
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  expect(listing.stdout.trim().split("\n").toSorted()).toEqual([
    "bin/",
    "bin/agx-msg",
    "bin/xmsg",
  ]);
  await messagingAlias(f.root, result.value.archive);
  const calls = (await Bun.file(join(f.root, "calls")).text())
    .trim()
    .split("\n");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/bin/agx-msg");
});

test("messaging manifests require explicit commands sharing a source", async () => {
  const f = await fixture("xmsg");
  for (const bin of [
    undefined,
    {},
    { xmsg: "src/main.ts" },
    { "agx-msg": "src/main.ts" },
    { "agx-msg": "", xmsg: "" },
    { "agx-msg": "src/main.ts", xmsg: "src/other.ts" },
  ]) {
    await Bun.write(
      join(f.dir, "package.json"),
      JSON.stringify({ version: "2.3.4", bin }),
    );
    const result = await build("xmsg", undefined, f.root);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toContain("Invalid package.json for xmsg");
    expect(await Bun.file(join(f.root, "calls")).exists()).toBe(false);
    expect(await Bun.file(join(f.root, "dist/xmsg/bin/agx-msg")).exists()).toBe(
      false,
    );
  }
});

test("current messaging manifest preserves both command entries", async () => {
  const info = await packageInfo("xmsg");
  expect(info.isOk()).toBe(true);
  if (info.isOk())
    expect(info.value.commands).toEqual({
      "agx-msg": "src/xmsg.ts",
      xmsg: "src/xmsg.ts",
    });
});

test("unknown packages exit 2 without producing an archive", async () => {
  const f = await fixture("agx-usehooks");
  await Bun.write(join(f.dir, "package.json"), '{"version":"1.0.0"}');
  for (const pkg of ["unknown", "../agx-status"]) {
    const result = await run(
      [process.execPath, join(f.root, "tools/release/build.ts"), pkg],
      f.root,
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("Unknown package");
  }
});

test("publish defaults to dry-run without building or uploading", async () => {
  const f = await suiteFixture();
  for (const pkg of packages) {
    const path = join(f.root, "tools", pkg, "CHANGELOG.md");
    await Bun.write(
      path,
      (await Bun.file(path).text()) + "\n## 2.3.2\n\n- Oldest version.\n",
    );
  }
  await Bun.write(
    join(f.root, "CHANGELOG.md"),
    await Bun.file(join(f.root, "tools/agx/CHANGELOG.md")).text(),
  );
  const result = await preview(f, [], { RELEASE_TEST_PREVIOUS: "1" });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("DRY RUN");
  expect(result.stdout).toContain("'git' 'push' '--atomic'");
  expect(result.stdout).toContain("refs/tags/v2.3.4:refs/tags/v2.3.4");
  const calls = await Bun.file(join(f.root, "calls")).text();
  expect(calls).not.toContain('["tag"');
  expect(calls).not.toContain('["release"');
  expect(calls).not.toContain("--compile");
  expect(
    await Bun.file(join(f.root, "dist/suite/release-notes.md")).exists(),
  ).toBe(false);
});

test("publish reads precisely the dated section produced by release:version", async () => {
  const f = await suiteFixture();
  expect(
    (
      await writeChangeset(f.root, "agx-status", "minor", "New release entry.")
    ).isOk(),
  ).toBe(true);
  await rm(join(f.root, "tools/agx-usehooks/.changes"), {
    recursive: true,
    force: true,
  });
  const applied = await applyChangesets(f.root, "agx-status", "2026-10-23");
  expect(applied.isOk(), applied.isErr() ? applied.error.message : "").toBe(
    true,
  );
  expect(applied.isOk() && applied.value.version).toBe("2.4.0");
  const result = await preview(f);
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("'git' 'tag' 'v2.4.0'");
  expect(
    await Bun.file(join(f.dir, ".changes/new-release-entry.md")).exists(),
  ).toBe(false);
});

test("publish accepts detached alpha and an ahead alpha but refuses a different HEAD", async () => {
  const f = await gitSuiteFixture();
  await git(f, ["checkout", "--detach", f.alpha]);
  const hostileHome = await mkdtemp(join(tmpdir(), "release-hostile-home-"));
  roots.push(hostileHome);
  // Parsing this config would fail immediately if the runner consulted HOME.
  await Bun.write(join(hostileHome, ".gitconfig"), "[invalid config\n");
  const atAlpha = await preview(f, ["--dry-run"], {
    ...realGit,
    HOME: hostileHome,
  });
  expect(atAlpha.exit, atAlpha.stderr).toBe(0);
  expect(atAlpha.stdout).toContain("DRY RUN");
  await rm(join(f.root, "dist"), { recursive: true, force: true });

  await git(f, ["checkout", "-b", "other"]);
  await Bun.write(join(f.root, "other.txt"), "other commit\n");
  await git(f, ["add", "other.txt"]);
  await git(f, ["commit", "-m", "other"]);
  const other = await git(f, ["rev-parse", "HEAD"]);
  await git(f, ["checkout", "--detach", other]);
  const detachedElsewhere = await preview(f, ["--dry-run"], realGit);
  expect(detachedElsewhere.exit).toBe(2);
  expect(detachedElsewhere.stderr).toContain(`HEAD ${other}`);
  expect(detachedElsewhere.stderr).toContain(`refs/heads/alpha ${f.alpha}`);

  await git(f, ["update-ref", "refs/heads/alpha", other]);
  await git(f, ["checkout", "--detach", other]);
  const aheadOfOrigin = await preview(f, ["--dry-run"], realGit);
  expect(aheadOfOrigin.exit, aheadOfOrigin.stderr).toBe(0);
});

test("explicit dry-run refuses dirty copies, existing tags and missing version entries", async () => {
  const f = await suiteFixture();
  const dirty = await preview(f, ["--dry-run"], { RELEASE_TEST_DIRTY: "1" });
  expect(dirty.exit).toBe(2);
  expect(dirty.stderr).toContain("dirty");
  const tagged = await preview(f, ["--dry-run"], { RELEASE_TEST_TAG: "1" });
  expect(tagged.exit).toBe(2);
  expect(tagged.stderr).toContain("Tag already exists: v2.3.4");
  await Bun.write(
    join(f.root, "CHANGELOG.md"),
    "## 2.3.40\n\n- Wrong version\n",
  );
  const missing = await preview(f, ["--dry-run"]);
  expect(missing.exit).toBe(2);
  expect(missing.stderr).toContain("no entry for 2.3.4");
});

test("execution requires --yes; conflicting flags and excess arguments refuse", async () => {
  const f = await suiteFixture();
  for (const args of [["--yes", "--dry-run"], ["extra"]]) {
    const result = await preview(f, args);
    expect(result.exit).toBe(2);
  }
  const result = await preview(f, ["--yes"]);
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("Release stopped");
  expect(await Bun.file(join(f.root, "calls")).text()).toContain(
    '["tag","v2.3.4",',
  );
});

const ghStateSchema = z.object({
  draft: z.boolean(),
  attempts: z.record(z.string(), z.number()),
  assets: z.array(
    z.object({ name: z.string(), state: z.string(), size: z.number() }),
  ),
});

async function ghState(root: string, library = false) {
  const parsed = jsonOf(ghStateSchema).safeParse(
    await Bun.file(
      join(root, library ? "gh-usehooks-state.json" : "gh-state.json"),
    ).text(),
  );
  expect(parsed.success).toBe(true);
  return parsed.success
    ? parsed.data
    : { draft: true, attempts: {}, assets: [] };
}

for (const mode of ["success", "retry"]) {
  test(`publish creates an empty draft, checks separate uploads and publishes (${mode})`, async () => {
    const f = await suiteFixture();
    const result = await previewCI(f, { RELEASE_TEST_GH_MODE: mode });
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stdout).toStartWith("PUBLISHED\n");
    const state = await ghState(f.root);
    expect(state.draft).toBe(false);
    expect(state.assets).toHaveLength(4);
    expect(state.assets.map((asset) => asset.name).toSorted()).toEqual(
      suiteTargets
        .map((target) => suiteArchiveName("2.3.4", target)._unsafeUnwrap())
        .toSorted(),
    );
    const libraryState = await ghState(f.root, true);
    expect(libraryState.draft).toBe(false);
    expect(libraryState.assets.map((asset) => asset.name)).toEqual([
      "agx-usehooks-2.3.4.tgz",
    ]);
    for (const asset of state.assets) {
      expect(asset.state).toBe("uploaded");
      expect(asset.size).toBe(
        (await stat(join(f.root, "dist", asset.name))).size,
      );
      expect(state.attempts[asset.name]).toBe(
        mode === "retry" && asset.name.endsWith(".tar.gz") ? 2 : 1,
      );
    }
    const calls = (await Bun.file(join(f.root, "calls")).text()).split("\n");
    const ghCalls = calls.filter((line) => line.startsWith('["release"'));
    expect(ghCalls[0]).toContain(
      '["release","create","usehooks-v2.3.4","--draft"',
    );
    expect(ghCalls[0]).not.toContain(".tar.gz");
    expect(ghCalls[0]).not.toContain(".tgz");
    expect(ghCalls.filter((line) => line.includes('"create"'))).toHaveLength(2);
    expect(ghCalls.at(-2)).toBe(
      '["release","view","v2.3.4","--json","assets"]',
    );
    expect(ghCalls.at(-1)).toBe(
      '["release","edit","v2.3.4","--draft=false","--latest"]',
    );
    const uploads = ghCalls.filter((line) => line.includes('"upload"'));
    expect(uploads).toHaveLength(mode === "retry" ? 9 : 5);
    expect(uploads[0]).not.toContain("--clobber");
    if (mode === "retry") expect(uploads[2]).toContain("--clobber");
  });
}

for (const mode of ["failure", "silent"]) {
  test(`persistent upload failure names asset and preserves a recoverable draft (${mode})`, async () => {
    const f = await suiteFixture();
    const result = await previewCI(f, { RELEASE_TEST_GH_MODE: mode });
    const name = "agx-2.3.4-linux-x64.tar.gz";
    expect(result.exit).toBe(2);
    expect(result.stdout).not.toContain("PUBLISHED");
    expect(result.stderr).toContain(
      `Asset upload failed for ${name} after 3 attempts`,
    );
    expect(result.stderr).toContain(
      mode === "silent"
        ? "no stdout or stderr captured"
        : `HTTP 502: upload failed for ${name}`,
    );
    expect(result.stderr).toContain("exited 1");
    expect(result.stderr).toContain("do not re-create the release");
    expect(result.stderr).toContain(
      `'gh' 'release' 'upload' 'v2.3.4' '${join(f.root, "dist", name)}' '--clobber'`,
    );
    expect(result.stderr).toContain(
      "'gh' 'release' 'view' 'v2.3.4' '--json' 'assets'",
    );
    expect(result.stderr).toContain(
      "'gh' 'release' 'edit' 'v2.3.4' '--draft=false' '--latest'",
    );
    const state = await ghState(f.root);
    expect(state.draft).toBe(true);
    expect(state.attempts[name]).toBe(3);
    const calls = await Bun.file(join(f.root, "calls")).text();
    expect(calls).not.toContain('["release","edit","v2.3.4"');
    expect(calls).not.toContain('["release","view","v2.3.4"');
    // Execute the printed recovery protocol against the SAME fake release.
    const recover = (args: string[]) =>
      productionRun(
        [
          process.execPath,
          join(import.meta.dir, "fake-gh.ts"),
          "release",
          ...args,
        ],
        f.root,
      );
    for (const asset of suiteTargets.map((target) =>
      suiteArchiveName("2.3.4", target)._unsafeUnwrap(),
    )) {
      const uploaded = await recover([
        "upload",
        "v2.3.4",
        join(f.root, "dist", asset),
        "--clobber",
      ]);
      expect(uploaded.exit, uploaded.stderr).toBe(0);
    }
    const inspected = await recover(["view", "v2.3.4", "--json", "assets"]);
    expect(inspected.exit, inspected.stderr).toBe(0);
    const verified = jsonOf(ghStateSchema.pick({ assets: true })).safeParse(
      inspected.stdout,
    );
    expect(verified.success).toBe(true);
    if (!verified.success) return;
    for (const asset of verified.data.assets) {
      expect(asset.state).toBe("uploaded");
      expect(asset.size).toBe(
        (await stat(join(f.root, "dist", asset.name))).size,
      );
    }
    expect(
      (await recover(["edit", "v2.3.4", "--draft=false", "--latest"])).exit,
    ).toBe(0);
    expect((await ghState(f.root)).draft).toBe(false);
    expect(
      (await Bun.file(join(f.root, "calls")).text()).match(
        /\["release","create"/gu,
      ),
    ).toHaveLength(2);
  });
}

for (const mode of ["missing", "wrong-size", "starter", "malformed"]) {
  test(`asset verification refuses publication (${mode})`, async () => {
    const f = await suiteFixture();
    const result = await previewCI(f, { RELEASE_TEST_GH_MODE: mode });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("agx-usehooks-2.3.4.tgz");
    expect(result.stderr).toContain(
      mode === "malformed"
        ? "Cannot verify assets"
        : "Asset verification failed",
    );
    expect(result.stderr).toContain("Draft usehooks-v2.3.4 retained");
    expect(result.stdout).not.toContain("PUBLISHED");
    expect((await ghState(f.root, true)).draft).toBe(true);
    expect(await Bun.file(join(f.root, "calls")).text()).not.toContain(
      '["release","edit"',
    );
  });
}

test("production runner captures stderr and stdout with non-TTY pipes on failure", async () => {
  const f = await fixture();
  const result = await productionRun(
    [
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(262144)); process.stderr.write("pipe-only upload error\\n"); process.exitCode = 1;',
    ],
    f.root,
  );
  expect(result.exit).toBe(1);
  expect(result.stdout).toHaveLength(262144);
  expect(result.stderr).toBe("pipe-only upload error\n");
});

test("target parsing and changelog boundaries", () => {
  expect(platform("bun-linux-x64-baseline").isOk()).toBe(true);
  expect(platform("bun-darwin-arm64").isOk()).toBe(true);
  expect(platform("../../bad").isErr()).toBe(true);
  expect(
    changelogSection(
      "## [2.3.4] - today\n\n- Entry\n## 2.3.3\n- Old",
      "2.3.4",
    ).isOk(),
  ).toBe(true);
  expect(changelogSection("## 2.3.4\n\n## 2.3.3\n- Old", "2.3.4").isErr()).toBe(
    true,
  );
});

async function libraryFixture() {
  const f = await fixture("agx-usehooks");
  for (const path of ["tools/shared", "agents/hooks/vendor"])
    await cp(join(repository, path), join(f.root, path), { recursive: true });
  await cp(join(repository, "tools/agx-usehooks/src"), join(f.dir, "src"), {
    recursive: true,
  });
  for (const file of ["package.json", "README.md", "tsconfig.release.json"])
    await Bun.write(
      join(f.dir, file),
      Bun.file(join(repository, "tools/agx-usehooks", file)),
    );
  const manifest = await Bun.file(join(f.dir, "package.json")).text();
  await Bun.write(
    join(f.dir, "package.json"),
    manifest.replace(/"version": "[^"\n]+"/u, '"version": "2.3.4"'),
  );
  await Bun.write(
    join(f.root, "tsconfig.json"),
    Bun.file(join(repository, "tsconfig.json")),
  );
  await Bun.write(
    join(f.dir, "tests/should-not-ship.ts"),
    "throw new Error('test');",
  );
  await Bun.write(join(f.dir, ".changes/should-not-ship.md"), "pending change");
  return f;
}

// Two compiler runs plus bundle, pack, two tar reads, two installs and import.
// Budget each real command separately; leave time for fixture I/O and cleanup.
const libraryCommandTimeout = 60_000;
const libraryTestTimeout = 9 * libraryCommandTimeout + 10_000;

test(
  "library tarball installs offline, imports and supplies checked public declarations",
  async () => {
    const libraryRun = (cmd: string[], cwd: string) =>
      fixtureRun(cmd, cwd, false, libraryCommandTimeout);
    const f = await libraryFixture();
    const result = await productionBuild(f.pkg, undefined, f.root, libraryRun);
    expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
    if (result.isErr()) return;
    expect(result.value.archive).toEndWith("agx-usehooks-2.3.4.tgz");
    expect(result.value.sha256).toMatch(/^[a-f\d]{64}$/u);
    const listing = await libraryRun(
      ["tar", "-tzf", result.value.archive],
      f.root,
    );
    expect(listing.exit).toBe(0);
    const files = listing.stdout.trim().split("\n");
    for (const file of [
      "package.json",
      "index.js",
      "README.md",
      "CHANGELOG.md",
      "types/tools/agx-usehooks/src/index.d.ts",
      "types/agents/hooks/vendor/deps.d.ts",
    ])
      expect(files).toContain(`package/${file}`);
    expect(
      files.every((file) =>
        /^package\/(?:package\.json|index\.js|README\.md|CHANGELOG\.md|types\/.+\.d\.ts)$/u.test(
          file,
        ),
      ),
    ).toBe(true);
    expect(listing.stdout).not.toMatch(/(?:tests|\.changes)\//u);
    const packed = await libraryRun(
      ["tar", "-xOzf", result.value.archive, "package/package.json"],
      f.root,
    );
    expect(packed.exit, packed.stderr).toBe(0);
    const manifest = jsonOf(
      z.object({
        dependencies: z.record(z.string(), z.string()),
        peerDependencies: z.record(z.string(), z.string()),
        peerDependenciesMeta: z.record(
          z.string(),
          z.object({ optional: z.boolean() }),
        ),
      }),
    ).safeParse(packed.stdout);
    expect(manifest.success, packed.stdout).toBe(true);
    if (!manifest.success) return;
    expect(
      Object.keys(manifest.data.dependencies).filter(
        (name) => name.startsWith("@types/") || name === "typescript",
      ),
    ).toEqual([]);
    expect(manifest.data.dependencies.neverthrow).toBe("8.2.0");
    expect(manifest.data.dependencies.zod).toBe("4.6.5");
    expect(manifest.data.peerDependencies["@types/node"]).toBe("*");
    expect(manifest.data.peerDependenciesMeta["@types/node"]).toEqual({
      optional: true,
    });
    const consumer = await mkdtemp(join(tmpdir(), "library-consumer-"));
    roots.push(consumer);
    await Bun.write(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        type: "module",
        private: true,
        devDependencies: { "@types/node": "22.20.2" },
      }),
    );
    // Lock an older major BEFORE adding the tarball. Both installs must use
    // cached packages only: registry access must never turn this check green.
    const baseline = await libraryRun(
      [process.execPath, "install", "--offline"],
      consumer,
    );
    expect(baseline.exit, baseline.stdout + baseline.stderr).toBe(0);
    expect(await Bun.file(join(consumer, "bun.lock")).exists()).toBe(true);
    const nodeVersion = async () => {
      const parsed = jsonOf(z.object({ version: z.string() })).safeParse(
        await Bun.file(
          join(consumer, "node_modules/@types/node/package.json"),
        ).text(),
      );
      expect(parsed.success).toBe(true);
      return parsed.success ? parsed.data.version : undefined;
    };
    const before = await nodeVersion();
    expect(before).toBe("22.20.2");
    const installed = await libraryRun(
      [process.execPath, "add", "--offline", result.value.archive],
      consumer,
    );
    expect(installed.exit, installed.stderr).toBe(0);
    expect(await nodeVersion()).toBe(before);
    const lockfile = await Bun.file(join(consumer, "bun.lock")).text();
    expect(lockfile).toContain("@types/node@22.20.2");
    // A nested newer copy would also defeat the consumer's ownership of Node types.
    expect(lockfile.match(/@types\/node@\d+\.[\d.]+/gu)).toEqual([
      "@types/node@22.20.2",
    ]);
    await Bun.write(
      join(consumer, "consumer.ts"),
      `
import { onPrompt, runningRuns, RunSchema, type HookContext, type Run } from "agx-usehooks";
const ctx: HookContext = { cwd: "/tmp", repoRoot: "/tmp", payload: {} };
const runs: Run[] = await runningRuns(ctx, { stateDirs: [] });
// @ts-expect-error public Run.row must remain a string
const invalid: Run = { id: "fixture", lane: "test", row: 123 };
void invalid;
if (runs.length !== 0 || typeof onPrompt !== "function" || !RunSchema.safeParse({ id: "fixture", lane: "test", row: "fixture" }).success) throw new Error("public API failed");
`,
    );
    const imported = await libraryRun(
      [process.execPath, "consumer.ts"],
      consumer,
    );
    expect(imported).toEqual({ exit: 0, stdout: "", stderr: "" });
    const typed = await libraryRun(
      [
        process.execPath,
        "x",
        "--bun",
        "--offline",
        "--package",
        "typescript@6.0.3",
        "tsc",
        "--noEmit",
        "--strict",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        "esnext",
        "consumer.ts",
      ],
      consumer,
    );
    expect(typed.exit, typed.stdout + typed.stderr).toBe(0);
  },
  libraryTestTimeout,
);

test("single member publishing refuses with suite pointer", async () => {
  const f = await fixture();
  for (const pkg of packages) {
    const result = await preview({ ...f, pkg });
    expect(result.exit).toBe(2);
    expect(result.stderr).toBe("FATAL: Use release:publish -- suite\n");
  }
});

async function suiteFixture() {
  const f = await libraryFixture();
  process.env.RELEASE_TEST_LOG_ROOT = f.root;
  const brewPrefix = join(f.root, "homebrew");
  const formulaBin = join(brewPrefix, "Cellar/agx/2.3.4/bin");
  await mkdir(formulaBin, { recursive: true });
  await mkdir(join(brewPrefix, "bin"), { recursive: true });
  await Bun.write(join(formulaBin, "agx"), "fake Homebrew agx\n");
  await symlink(join(formulaBin, "agx"), join(brewPrefix, "bin/agx"));
  process.env.RELEASE_TEST_BREW_PREFIX = brewPrefix;
  for (const pkg of packages) {
    if (pkg === "agx-usehooks") continue;
    const dir = join(f.root, "tools", pkg);
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        version: "2.3.4",
        bin:
          pkg === "xmsg"
            ? { "agx-msg": "src/main.ts", xmsg: "src/main.ts" }
            : { [pkg]: "src/main.ts" },
      }),
    );
    await Bun.write(
      join(dir, "src/main.ts"),
      `process.stdout.write("${pkg === "xmsg" ? "agx msg" : pkg} 2.3.4\\n");`,
    );
    await Bun.write(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## 2.3.4\n\n- This version only.\n\n## 2.3.3\n\n- Earlier version.\n",
    );
  }
  return { ...f, pkg: "suite", dir: join(f.root, "tools/agx") };
}

test("release contract: dist holds only the built version", async () => {
  const f = await suiteFixture();
  const dist = join(f.root, "dist");
  await mkdir(dist, { recursive: true });
  const staleSuite = join(dist, "agx-2.3.3-linux-x64.tar.gz");
  const staleLibrary = join(dist, "agx-usehooks-2.3.3.tgz");
  const currentMember = join(dist, "agx-worker-2.3.4-linux-x64.tar.gz");
  const note = join(dist, "release-notes.txt");
  await Bun.write(staleSuite, "older suite archive");
  await Bun.write(staleLibrary, "older library archive");
  await Bun.write(currentMember, "current version archive");
  await Bun.write(note, "keep non-archive files");

  const result = await build("suite", undefined, f.root);
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  if (result.isErr()) return;

  const archives = (await readdir(dist, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".tar.gz") || entry.name.endsWith(".tgz")),
    )
    .map((entry) => entry.name)
    .toSorted();
  expect(archives).toEqual(
    [basename(result.value.archive), basename(currentMember)].toSorted(),
  );
  expect(await Bun.file(staleSuite).exists()).toBe(false);
  expect(await Bun.file(staleLibrary).exists()).toBe(false);
  expect(await Bun.file(currentMember).text()).toBe("current version archive");
  expect(await Bun.file(note).text()).toBe("keep non-archive files");
}, 30_000);

test("release contract: size", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-size-"));
  roots.push(root);
  await symlink(join(repository, "tools"), join(root, "tools"));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));

  const result = await productionBuild("suite", undefined, root, productionRun);
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  if (result.isErr()) return;

  const archiveSize = (await stat(result.value.archive)).size;
  expect(archiveSize).toBeLessThan(100_000_000);
  const info = await packageInfo("agx", root);
  expect(info.isOk(), info.isErr() ? info.error : "").toBe(true);
  if (info.isErr()) return;

  const names = [...packages]
    .filter((pkg) => pkg !== "agx-usehooks")
    .concat("agx-msg");
  const files = await Promise.all(
    names.map((name) => stat(join(root, "dist/suite/bin", name))),
  );
  expect(new Set(files.map((file) => `${file.dev}:${file.ino}`)).size).toBe(1);
  expect(files[0]?.nlink).toBe(names.length);
  for (const name of names) {
    const version = await productionRun(
      [join(root, "dist/suite/bin", name), "--version"],
      root,
    );
    expect(version.exit, version.stderr).toBe(0);
    expect(version.stdout).toBe(
      `${name === "agx-msg" || name === "xmsg" ? "agx msg" : name} ${info.value.version}\n`,
    );
  }
}, 600_000);

test("suite archive contains all commands with member versions and only its platform asset", async () => {
  const f = await suiteFixture();
  const result = await build("suite", undefined, f.root);
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  if (result.isErr()) return;
  expect(result.value.assets).toHaveLength(1);
  const listing = await run(["tar", "-tzf", result.value.archive], f.root);
  const names = [...packages]
    .filter((pkg) => pkg !== "agx-usehooks")
    .concat("agx-msg");
  expect(listing.stdout.trim().split("\n").toSorted()).toEqual(
    ["bin/", ...names.map((name) => `bin/${name}`)].toSorted(),
  );
  const files = await Promise.all(
    names.map((name) => stat(join(f.root, "dist/suite/bin", name))),
  );
  expect(new Set(files.map((file) => `${file.dev}:${file.ino}`)).size).toBe(1);
  expect(files[0]?.nlink).toBe(names.length);
  for (const name of names) {
    const version = await run(
      [join(f.root, "dist/suite/bin", name), "--version"],
      f.root,
    );
    expect(version.exit).toBe(0);
    expect(version.stdout).toBe(
      `${name === "agx-msg" || name === "xmsg" ? "agx msg" : name} 2.3.4\n`,
    );
  }
  await messagingAlias(f.root, result.value.archive, names.length);
  const calls = (await Bun.file(join(f.root, "calls")).text()).split("\n");
  const suiteCompiles = calls.filter(
    (line) => line.includes("--compile") && line.includes("launcher.ts"),
  );
  expect(suiteCompiles).toHaveLength(1);
  expect(suiteCompiles[0]).toContain("/tools/release/launcher.ts");
  expect(suiteCompiles[0]).toContain("/bin/agx");
  for (const target of suiteTargets) {
    const built = await build("suite", target, f.root);
    expect(built.isOk()).toBe(true);
    if (built.isOk())
      await messagingAlias(f.root, built.value.archive, names.length);
  }
  const archives = await Array.fromAsync(
    new Bun.Glob("*.tar.gz").scan(join(f.root, "dist")),
  );
  expect(archives).toHaveLength(4);
}, 30_000);

test("suite notes reject unavailable history", async () => {
  const f = await suiteFixture();
  expect((await suiteNotes(f.root, "v0.0.0", run)).isErr()).toBe(true);
});

async function messagingAlias(
  root: string,
  archive: string,
  expectedLinkCount = 2,
) {
  const extracted = join(root, "dist", "extracted");
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  const unpacked = await run(["tar", "-xzf", archive, "-C", extracted], root);
  expect(unpacked.exit, unpacked.stderr).toBe(0);
  const canonical = join(extracted, "bin/agx-msg");
  const alias = join(extracted, "bin/xmsg");
  const [original, linked] = await Promise.all([stat(canonical), stat(alias)]);
  expect(linked.dev).toBe(original.dev);
  expect(linked.ino).toBe(original.ino);
  expect(linked.nlink).toBe(expectedLinkCount);
  const a = await run([canonical, "--version"], root);
  const b = await run([alias, "--version"], root);
  expect(a.exit).toBe(0);
  expect(b).toEqual(a);
}

test("suite archive names carry mise OS and architecture tokens", () => {
  expect(
    suiteTargets.map((target) =>
      suiteArchiveName("2.3.4", target)._unsafeUnwrap(),
    ),
  ).toEqual([
    "agx-2.3.4-linux-x64.tar.gz",
    "agx-2.3.4-linux-arm64.tar.gz",
    "agx-2.3.4-darwin-x64.tar.gz",
    "agx-2.3.4-darwin-arm64.tar.gz",
  ]);
});

test("suite publishing rejects a partial target before building", async () => {
  const f = await suiteFixture();
  const result = await preview(f, ["--target", "bun-linux-x64"]);
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("all supported platforms");
  expect(await Bun.file(join(f.root, "calls")).exists()).toBe(false);
});

test("local publication pushes once and never builds or uploads", async () => {
  const f = await suiteFixture();
  const priorMode = process.env.RELEASE_TEST_GH_MODE;
  process.env.RELEASE_TEST_GH_MODE = "success";
  const result = await publish(
    "suite",
    true,
    undefined,
    f.root,
    installProductionRun,
  ).finally(() => {
    if (priorMode === undefined) delete process.env.RELEASE_TEST_GH_MODE;
    else process.env.RELEASE_TEST_GH_MODE = priorMode;
  });
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  const calls = (await Bun.file(join(f.root, "calls")).text())
    .trim()
    .split("\n");
  expect(calls.join("\n")).toContain('"--atomic"');
  expect(
    calls.filter((line) =>
      line.startsWith('["workflow","run","update-formulas.yml"'),
    ),
  ).toHaveLength(1);
  expect(calls.join("\n")).not.toContain("--compile");
  expect(
    await Bun.file(join(f.root, "dist/agx-2.3.4-linux-x64.tar.gz")).exists(),
  ).toBe(false);
});

test("CI refuses mismatched tags before building", async () => {
  const f = await suiteFixture();
  const result = await publishCI("v9.9.9", f.root, run);
  expect(result.isErr()).toBe(true);
  expect(await Bun.file(join(f.root, "calls")).exists()).toBe(false);
});

test("workflow dispatch checks out the input tag and preserves tag push builds", async () => {
  const source = await Bun.file(
    join(repository, ".github/workflows/release.yml"),
  ).text();
  const yaml = await attempt((): unknown => Bun.YAML.parse(source));
  expect(yaml.ok).toBe(true);
  if (!yaml.ok) return;
  const parsed = z
    .object({
      on: z.object({
        push: z.object({ tags: z.array(z.string()) }),
        workflow_dispatch: z.object({
          inputs: z
            .object({
              tag: z.object({
                required: z.literal(true),
                type: z.literal("string"),
              }),
            })
            .strict(),
        }),
      }),
      permissions: z.object({ contents: z.literal("write") }),
      concurrency: z.object({ group: z.string() }),
      jobs: z.object({
        release: z.object({
          steps: z.array(
            z.object({
              uses: z.string().optional(),
              run: z.string().optional(),
              with: z.record(z.string(), z.unknown()).optional(),
              env: z.record(z.string(), z.string()).optional(),
            }),
          ),
        }),
      }),
    })
    .safeParse(yaml.value);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const workflow = parsed.data;
  expect(workflow.on.push.tags).toEqual(["v[0-9]*", "usehooks-v[0-9]*"]);
  const checkout = workflow.jobs.release.steps.find(
    (step) => step.uses === "actions/checkout@v4",
  );
  const tagRef =
    "${{ inputs.tag && format('refs/tags/{0}', inputs.tag) || github.ref }}";
  expect(checkout?.with?.ref).toBe(tagRef);
  expect(checkout?.with?.["fetch-depth"]).toBe(0);
  expect(workflow.concurrency.group).toBe(`release-${tagRef}`);
  const buildStep = workflow.jobs.release.steps.find(
    (step) => step.run === 'bun tools/release/ci.ts "$RELEASE_TAG"',
  );
  expect(buildStep?.env?.RELEASE_TAG).toBe(
    "${{ inputs.tag || github.ref_name }}",
  );
});

for (const mode of ["success", "machine-missing"]) {
  test(`publish prints manual dispatch recovery before asset wait (${mode})`, async () => {
    const f = await suiteFixture();
    const priorMode = process.env.RELEASE_TEST_GH_MODE;
    const priorNoRun = process.env.RELEASE_TEST_NO_RUN;
    process.env.RELEASE_TEST_GH_MODE = mode;
    process.env.RELEASE_TEST_NO_RUN = "1";
    const result = await publish(
      "suite",
      true,
      undefined,
      f.root,
      installProductionRun,
      { waitSeconds: 0 },
    ).finally(() => {
      if (priorMode === undefined) delete process.env.RELEASE_TEST_GH_MODE;
      else process.env.RELEASE_TEST_GH_MODE = priorMode;
      if (priorNoRun === undefined) delete process.env.RELEASE_TEST_NO_RUN;
      else process.env.RELEASE_TEST_NO_RUN = priorNoRun;
    });
    expect(result.isOk(), result.isErr() ? result.error : "").toBe(
      mode === "success",
    );
    const calls = (await Bun.file(join(f.root, "calls")).text())
      .trim()
      .split("\n");
    expect(
      calls.findIndex((line) => line.startsWith('["run","list"')),
    ).toBeLessThan(
      calls.findIndex((line) => line.startsWith('["release","view"')),
    );
  });
}

for (const tag of ["v2.3.4", "usehooks-v2.3.4"]) {
  test(`CI tag ${tag} builds only its exact asset list`, async () => {
    const f = await suiteFixture();
    const result = await previewCI(
      { ...f, pkg: tag },
      { RELEASE_TEST_GH_MODE: "success" },
    );
    expect(result.exit, result.stderr).toBe(0);
    const library = tag.startsWith("usehooks-");
    const state = await ghState(f.root, library);
    expect(state.assets.map((asset) => asset.name).toSorted()).toEqual(
      library
        ? ["agx-usehooks-2.3.4.tgz"]
        : suiteTargets
            .map((target) => suiteArchiveName("2.3.4", target)._unsafeUnwrap())
            .toSorted(),
    );
    const calls = await Bun.file(join(f.root, "calls")).text();
    const creates = calls
      .trim()
      .split("\n")
      .filter((line) => line.startsWith('["release","create"'));
    expect(creates).toEqual([
      JSON.stringify([
        "release",
        "create",
        tag,
        "--draft",
        "--title",
        tag,
        "--notes-file",
        join(f.root, "dist/suite/release-notes.md"),
        "--verify-tag",
      ]),
    ]);
    expect(calls).not.toContain('["tag"');
  });
}

test("CI suite release fails if any platform upload is missing", async () => {
  const f = await suiteFixture();
  const result = await previewCI(
    { ...f, pkg: "v2.3.4" },
    { RELEASE_TEST_GH_MODE: "missing" },
  );
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("agx-2.3.4-linux-x64.tar.gz");
  expect(result.stderr).toContain("Asset verification failed");
  expect((await ghState(f.root)).draft).toBe(true);
  expect(await Bun.file(join(f.root, "calls")).text()).not.toContain(
    '["release","edit"',
  );
});

test("tap workflow dispatch failure warns but does not fail machine brew completion", async () => {
  const f = await suiteFixture();
  const priorFailure = process.env.RELEASE_TEST_WORKFLOW_FAIL;
  process.env.RELEASE_TEST_WORKFLOW_FAIL = "1";
  const result = await machineSwap(
    "2.3.4",
    { waitSeconds: 0 },
    f.root,
    installProductionRun,
  ).finally(() => {
    if (priorFailure === undefined)
      delete process.env.RELEASE_TEST_WORKFLOW_FAIL;
    else process.env.RELEASE_TEST_WORKFLOW_FAIL = priorFailure;
  });
  expect(result.isOk(), result.isErr() ? result.error : "").toBe(true);
  const calls = (await Bun.file(join(f.root, "calls")).text())
    .trim()
    .split("\n");
  expect(
    calls.some((line) =>
      line.startsWith('["workflow","run","update-formulas.yml"'),
    ),
  ).toBe(true);
  expect(calls.some((line) => line.startsWith('["run","list"'))).toBe(false);
  expect(calls).toContain(
    JSON.stringify(["/home/linuxbrew/.linuxbrew/bin/brew", "update"]),
  );
});

for (const mode of [
  "success",
  "machine-delayed",
  "machine-missing",
  "stale",
  "brew-failure",
  "non-brew-path",
  "brew-absent",
]) {
  test(`machine completion: ${mode}`, async () => {
    const f = await suiteFixture();
    const consumer = join(f.root, "consumer with spaces");
    await mkdir(consumer);
    await Bun.write(
      join(consumer, "mise.toml"),
      '[tools]\n"github:fuyutarow/agx" = "old"\n',
    );
    await Bun.write(join(consumer, "mise.lock"), "sentinel lock\n");
    const before = await readdir(consumer, { recursive: true });
    const content = await Promise.all(
      before.map((name) => Bun.file(join(consumer, name)).text()),
    );
    const result = await preview(
      f,
      [
        "--yes",
        "--verify-in",
        consumer,
        "--verify-in",
        consumer,
        "--wait-seconds",
        mode === "machine-delayed" ? "1" : "0",
        "--poll-seconds",
        "0.01",
      ],
      {
        RELEASE_TEST_GH_MODE: mode.startsWith("machine-") ? mode : "success",
        RELEASE_TEST_FORMULA_OLD_COUNT: mode === "machine-delayed" ? "1" : "0",
        RELEASE_TEST_STALE_DIR: mode === "stale" ? consumer : "",
        RELEASE_TEST_BREW_FAIL: mode === "brew-failure" ? "1" : "0",
        RELEASE_TEST_BREW_ABSENT: mode === "brew-absent" ? "1" : "0",
        RELEASE_TEST_NON_BREW_PATH: mode === "non-brew-path" ? "1" : "0",
      },
    );
    expect(await readdir(consumer, { recursive: true })).toEqual(before);
    expect(
      await Promise.all(
        before.map((name) => Bun.file(join(consumer, name)).text()),
      ),
    ).toEqual(content);
    const calls = await Bun.file(join(f.root, "calls")).text();
    if (mode === "machine-missing") {
      expect(result.exit).toBe(1);
      expect(result.stderr).toContain("asset-wait in");
      expect(result.stderr).toContain("agx-2.3.4-linux-x64.tar.gz");
      expect(calls).not.toContain('"update"');
      expect(calls).not.toContain('"workflow","run","update-formulas.yml"');
    } else {
      const trigger = calls.indexOf('"workflow","run","update-formulas.yml"');
      expect(trigger).toBeGreaterThan(-1);
      if (mode === "stale") {
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain(`verify in ${consumer}`);
        expect(result.stderr).toContain("agx 2.3.3");
      } else if (mode === "brew-failure") {
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain("brew update in");
      } else if (mode === "non-brew-path") {
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain("/usr/local/bin/agx");
      } else {
        expect(result.exit, result.stderr).toBe(0);
        const okLines = result.stdout
          .split("\n")
          .filter((line) => line.startsWith("OK "));
        expect(okLines).toHaveLength(2);
        expect(okLines.some((line) => line.includes(consumer))).toBe(true);
        expect(result.stdout.split(`OK ${consumer}: agx 2.3.4`)).toHaveLength(
          2,
        );
        expect(calls).toContain(JSON.stringify(["agx", "-V"]));
        expect(
          mode !== "brew-absent" ||
            calls.includes(
              JSON.stringify([
                "/home/linuxbrew/.linuxbrew/bin/brew",
                "install",
                "fuyutarow/tap/agx",
              ]),
            ),
        ).toBe(true);
        expect(
          mode !== "machine-delayed" ||
            (await Bun.file(join(f.root, "polled")).exists()),
        ).toBe(true);
      }
    }
  });
}
