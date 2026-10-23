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
  realGit = process.env.RELEASE_TEST_REAL_GIT === "1",
) {
  const [binary, ...args] = cmd;
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
    await Bun.write(
      outfile,
      `#!${process.execPath}\n${await Bun.file(entry).text()}`,
    );
    await chmod(outfile, 0o755);
    return success;
  }
  if (binary === "gh" || (binary === "git" && args[0] === "tag")) {
    await appendFile(join(cwd, "calls"), JSON.stringify(args) + "\n");
    return { ...success, exit: 99 };
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
  if (binary !== "git" && binary !== "tar" && !localBun && !localExecutable)
    return refused(`Forbidden fixture command: ${JSON.stringify(cmd)}`);
  const child = Bun.spawn(cmd, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "commit.gpgSign",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "protocol.allow",
      GIT_CONFIG_VALUE_2: "never",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
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
