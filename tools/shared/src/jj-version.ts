import { fromThrowable } from "neverthrow";

/** The map literal used by workspace list requires jj 0.46.0. */
export const MIN_JJ_VERSION = "0.46.0";

let checked = false;

/** Refuse before invoking a template, including through the read-only runner. */
export function requireJjTemplateVersion(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    checked ||
    argv[0] !== "jj" ||
    (!argv.includes("-T") && !argv.includes("--template"))
  )
    return;
  const probe = fromThrowable(() =>
    Bun.spawnSync(["jj", "--version"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }),
  )();
  const result = probe.isOk() ? probe.value : undefined;
  const found = (result?.stdout?.toString() ?? "")
    .trim()
    .replaceAll(/[\r\n]+/gu, " ");
  const match = /^jj (\d+)\.(\d+)\.(\d+)/u.exec(found);
  const version = match?.slice(1).map(Number);
  const supported =
    result?.exitCode === 0 &&
    version !== undefined &&
    ((version[0] ?? 0) > 0 || (version[1] ?? 0) >= 46);
  if (!supported) {
    process.stderr.write(
      `agx: jj ${MIN_JJ_VERSION} or newer required; found ${found === "" ? "unknown" : found}\n`,
    );
    process.exit(2);
  }
  checked = true;
}
