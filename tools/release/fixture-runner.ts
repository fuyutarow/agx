// Test-only command boundary. Unknown commands fail before they can spawn.
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const refused = (stderr: string) => ({ exit: 98, stdout: "", stderr });
const success = { exit: 0, stdout: "", stderr: "" };
const gitCommands = new Set([
  "init",
  "config",
  "add",
  "commit",
  "rev-parse",
  "update-ref",
  "checkout",
  "status",
  "show-ref",
  "describe",
  "show",
]);

export async function fixtureRun(
  cmd: string[],
  cwd: string,
  realGitOrOptions: boolean | { deadline?: number } = process.env
    .RELEASE_TEST_REAL_GIT === "1",
  timeout = 10_000,
) {
  const realGit =
    typeof realGitOrOptions === "boolean"
      ? realGitOrOptions
      : process.env.RELEASE_TEST_REAL_GIT === "1";
  const [binary, ...args] = cmd;
  const logRoot = process.env.RELEASE_TEST_LOG_ROOT ?? cwd;
  if (
    process.env.RELEASE_TEST_GH_MODE !== undefined &&
    binary === "gh" &&
    args[0] === "api"
  ) {
    await appendFile(join(logRoot, "calls"), JSON.stringify(args) + "\n");
    return { ...success, stdout: "alpha\n" };
  }
  if (process.env.RELEASE_TEST_GH_MODE !== undefined && binary === "curl") {
    await appendFile(join(logRoot, "calls"), JSON.stringify(args) + "\n");
    const old = Number(process.env.RELEASE_TEST_FORMULA_OLD_COUNT ?? 0);
    if (old > 0) {
      process.env.RELEASE_TEST_FORMULA_OLD_COUNT = String(old - 1);
      await Bun.write(join(logRoot, "polled"), "formula not ready\n");
      return {
        ...success,
        stdout: 'class Agx < Formula\n  version "2.3.3"\nend\n',
      };
    }
    return process.env.RELEASE_TEST_FORMULA_FAIL === "1"
      ? { exit: 1, stdout: "", stderr: "formula fetch failed\n" }
      : { ...success, stdout: 'class Agx < Formula\n  version "2.3.4"\nend\n' };
  }
  if (
    process.env.RELEASE_TEST_GH_MODE !== undefined &&
    binary === "/home/linuxbrew/.linuxbrew/bin/brew"
  ) {
    await appendFile(join(logRoot, "calls"), JSON.stringify(cmd) + "\n");
    if (args[0] === "list")
      return process.env.RELEASE_TEST_BREW_ABSENT === "1"
        ? { exit: 1, stdout: "", stderr: "not installed\n" }
        : { ...success, stdout: "agx\n" };
    if (args[0] === "--prefix")
      return {
        ...success,
        stdout: `${process.env.RELEASE_TEST_BREW_PREFIX}\n`,
      };
    if (args[0] === "update" && process.env.RELEASE_TEST_BREW_FAIL === "1")
      return { exit: 1, stdout: "", stderr: "brew update failed\n" };
    return success;
  }
  if (
    process.env.RELEASE_TEST_GH_MODE !== undefined &&
    binary === "which" &&
    args[0] === "agx"
  ) {
    await appendFile(join(logRoot, "calls"), JSON.stringify(cmd) + "\n");
    return {
      ...success,
      stdout: `${process.env.RELEASE_TEST_NON_BREW_PATH === "1" ? "/usr/local/bin/agx" : `${process.env.RELEASE_TEST_BREW_PREFIX}/bin/agx`}\n`,
    };
  }
  if (
    process.env.RELEASE_TEST_GH_MODE !== undefined &&
    binary === "agx" &&
    args[0] === "-V"
  ) {
    await appendFile(join(logRoot, "calls"), JSON.stringify(cmd) + "\n");
    return {
      ...success,
      stdout:
        cwd === process.env.RELEASE_TEST_STALE_DIR
          ? "agx 2.3.3\n"
          : "agx 2.3.4\n",
    };
  }
  if (
    binary === "git" &&
    args[0] === "push" &&
    !realGit &&
    process.env.RELEASE_TEST_GH_MODE !== undefined
  ) {
    await appendFile(join(cwd, "calls"), JSON.stringify(args) + "\n");
    return success;
  }
  if (
    binary === "gh" &&
    args[0] === "workflow" &&
    args[1] === "run" &&
    process.env.RELEASE_TEST_GH_MODE !== undefined
  ) {
    await appendFile(join(cwd, "calls"), JSON.stringify(args) + "\n");
    return process.env.RELEASE_TEST_WORKFLOW_FAIL === "1"
      ? { exit: 1, stdout: "", stderr: "workflow dispatch fixture failure\n" }
      : success;
  }
  if (
    binary === "gh" &&
    args[0] === "run" &&
    process.env.RELEASE_TEST_GH_MODE !== undefined
  ) {
    await appendFile(join(cwd, "calls"), JSON.stringify(args) + "\n");
    return {
      ...success,
      stdout: JSON.stringify(
        process.env.RELEASE_TEST_NO_RUN === "1"
          ? []
          : [{ url: "https://github.com/fuyutarow/agx/actions/runs/123" }],
      ),
    };
  }
  const fakeGh =
    binary === "gh" && process.env.RELEASE_TEST_GH_MODE !== undefined;
  // Publish tests exercise planning and preconditions. The dedicated library test
  // below this boundary still builds and checks the real public declarations.
  const fastLibrary =
    process.env.RELEASE_TEST_FAST_LIBRARY === "1" &&
    binary === process.execPath;
  if (fastLibrary && args[0] === "build" && !args.includes("--compile")) {
    const outfile = args[args.indexOf("--outfile") + 1];
    if (outfile === undefined) return refused("Missing library outfile");
    await Bun.write(outfile, "export {};\n");
    return success;
  }
  if (fastLibrary && args[0] === "x" && args.includes("--listFiles")) {
    const outDir = args[args.indexOf("--outDir") + 1];
    if (outDir === undefined) return refused("Missing declaration outDir");
    await Bun.write(
      join(outDir, "tools/agx-usehooks/src/index.d.ts"),
      "export {};\n",
    );
    return success;
  }
  if (
    binary === process.execPath &&
    args[0] === "build" &&
    args[1] === "--compile"
  ) {
    const entry = args[2];
    const outfile = args[args.indexOf("--outfile") + 1];
    if (entry === undefined || outfile === undefined)
      return refused("Invalid compile fixture");
    await appendFile(join(cwd, "calls"), JSON.stringify(cmd) + "\n");
    await mkdir(dirname(outfile), { recursive: true });
    const fixtureEntry = entry.endsWith("/tools/release/launcher.ts")
      ? [
          "const command = process.argv[1]?.split('/').at(-1) ?? '';",
          "const name = command === 'xmsg' || command === 'agx-msg' ? 'agx msg' : command;",
          "process.stdout.write(name + ' 2.3.4\\n');",
        ].join("\n")
      : await Bun.file(entry).text();
    await Bun.write(outfile, `#!${process.execPath}\n${fixtureEntry}`);
    await chmod(outfile, 0o755);
    return success;
  }
  if ((binary === "gh" && !fakeGh) || (binary === "git" && args[0] === "tag")) {
    await appendFile(join(cwd, "calls"), JSON.stringify(args) + "\n");
    return {
      ...success,
      exit: process.env.RELEASE_TEST_GH_MODE !== undefined ? 0 : 99,
    };
  }
  if (binary === "git" && !gitCommands.has(args[0] ?? ""))
    return refused(`Forbidden Git command: ${JSON.stringify(cmd)}`);
  if (binary === "git" && !realGit) return fakeGit(args, cwd);

  const localBun =
    binary === process.execPath &&
    ((args[0] === "build" && !args.includes("--compile")) ||
      (args[0] === "x" && args.includes("--offline")) ||
      (args[0] === "pm" &&
        args[1] === "pack" &&
        args.includes("--ignore-scripts")) ||
      ((args[0] === "install" || args[0] === "add") &&
        (args.includes("--offline") || args.includes("--prefer-offline"))) ||
      args[0] === "consumer.ts" ||
      (args[0]?.endsWith("/tools/release/build.ts") ?? false));
  const localExecutable = binary?.startsWith(join(cwd, "dist") + "/") ?? false;
  if (
    binary !== "git" &&
    binary !== "tar" &&
    !localBun &&
    !localExecutable &&
    !fakeGh
  )
    return refused(`Forbidden fixture command: ${JSON.stringify(cmd)}`);
  const started = performance.now();
  const child = Bun.spawn(
    fakeGh
      ? [process.execPath, join(import.meta.dir, "fake-gh.ts"), ...args]
      : cmd,
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "commit.gpgSign",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "protocol.allow",
        GIT_CONFIG_VALUE_2: "never",
        GIT_CONFIG_COUNT: "3",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (process.env.RELEASE_TEST_TIMINGS === "1")
    console.error(
      JSON.stringify({
        cmd,
        ms: Math.round(performance.now() - started),
        exit,
      }),
    );
  return { exit, stdout, stderr };
}
async function fakeGit(args: string[], cwd: string) {
  await appendFile(join(cwd, "calls"), JSON.stringify(args) + "\n");
  if (args[0] === "status")
    return {
      ...success,
      stdout: process.env.RELEASE_TEST_DIRTY === "1" ? " M changed\n" : "",
    };
  if (args[0] === "show-ref")
    return {
      ...success,
      exit:
        args.at(-1) === "refs/remotes/origin/alpha" &&
        process.env.RELEASE_TEST_REMOTE !== "1"
          ? 1
          : Number(process.env.RELEASE_TEST_TAG !== "1"),
    };
  if (args[0] === "describe")
    return process.env.RELEASE_TEST_PREVIOUS === "1"
      ? { ...success, stdout: "v2.3.2" }
      : { ...success, exit: 128 };
  if (args[0] === "show")
    return { ...success, stdout: JSON.stringify({ version: "2.3.2" }) };
  if (args[0] === "rev-parse")
    return {
      ...success,
      stdout: "0123456789012345678901234567890123456789\n",
    };
  return refused(`Unimplemented Git fixture: ${JSON.stringify(args)}`);
}
