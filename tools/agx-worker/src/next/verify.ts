import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fromThrowable } from "neverthrow";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { exitWithError } from "./exit.ts";
import {
  InspectionTimeout,
  InspectionUnavailable,
} from "../../../shared/src/agx-config.ts";

export const MISE_ENV_TIMEOUT_MS = 60_000;

/** Pin command lookup only for a compiled suite executable with both suite binaries. */
export function ownSuiteDirectory(
  execPath: string,
  main: string,
): string | undefined {
  if (!main.startsWith("/$bunfs/")) return undefined;
  return fromThrowable(() => {
    const executable = realpathSync(execPath);
    if (!["agx", "agx-worker"].includes(basename(executable))) return null;
    const directory = dirname(executable);
    accessSync(join(directory, "agx"), constants.X_OK);
    accessSync(join(directory, "agx-worker"), constants.X_OK);
    return directory;
  })().unwrapOr(null) ?? undefined;
}

export function withSuitePath(
  env: NodeJS.ProcessEnv,
  directory: string | undefined,
): NodeJS.ProcessEnv {
  if (directory === undefined) return env;
  return { ...env, PATH: `${directory}:${env.PATH ?? "/usr/bin:/bin"}` };
}

export const VerifyKind = z.enum([
  "passed",
  "failed",
  "unrunnable",
  "killed",
  "interrupted",
]);
export type VerifyKind = z.output<typeof VerifyKind>;

/** Shell conventions also cover signals received by a nested check process. */
export function verifyKind(exit: number, signal?: string | null): VerifyKind {
  if ((signal !== undefined && signal !== null) || (exit > 128 && exit <= 192))
    return "killed";
  if (exit === 126 || exit === 127) return "unrunnable";
  return exit === 0 ? "passed" : "failed";
}

export const VerifyResult = z
  .looseObject({
    cmd: z.string(),
    exit: z.number(),
    log_path: z.string(),
    kind: VerifyKind.optional(),
    source: z.literal("[verify].always").optional(),
  })
  .transform((result) => ({
    ...result,
    kind: result.kind ?? verifyKind(result.exit),
  }));

/**
 * Which verify round the reported `verify` exits belong to, and how the rounds before it ended.
 * The recorded `verify` field keeps its shape; this is a separate, optional field.
 */
export const VerifyRound = z.object({
  round: z.number().int().positive(),
  of: z.number().int().positive(),
  earlier: z.array(
    z.object({
      round: z.number().int().positive(),
      exits: z.array(z.number()),
    }),
  ),
});
export type VerifyRound = z.output<typeof VerifyRound>;

/** Round numbers are 1-based; every round's logs are verify-round-K-NN.log. */
export function verifyLogName(round: number, index: number): string {
  return `verify-round-${round}-${String(index + 1).padStart(2, "0")}.log`;
}

/** Build the round summary from the rounds that ended before the reported one. */
export function verifyRoundOf(
  round: number,
  earlier: readonly (readonly { exit: number }[])[],
): VerifyRound {
  return {
    round,
    of: round,
    earlier: earlier.slice(0, round - 1).map((results, index) => ({
      round: index + 1,
      exits: results.map((result) => result.exit),
    })),
  };
}

/** `round 2 of 2: 0,0 (round 1: 0,1)`; without a round record, the bare exits. */
export function verifyText(
  exits: readonly number[],
  round: VerifyRound | undefined,
): string {
  if (exits.length === 0) return "not run";
  const list = exits.join(",");
  if (round === undefined) return list;
  const earlier =
    round.earlier.length === 0
      ? ""
      : ` (${round.earlier.map((entry) => `round ${entry.round}: ${entry.exits.join(",")}`).join("; ")})`;
  return `round ${round.round} of ${round.of}: ${list}${earlier}`;
}

/** Space-separated key=value form for `agx worker ls` lines; empty without a round record. */
export function verifyRoundFields(round: VerifyRound | undefined): string {
  if (round === undefined) return "";
  return [
    ` verify_round=${round.round}/${round.of}`,
    ...round.earlier.map(
      (entry) => ` verify_round_${entry.round}_exits=${entry.exits.join(",")}`,
    ),
  ].join("");
}

/** Assemble once at the entry point, including services with only /usr/bin:/bin. */
export function verificationEnvironment(
  cwd: string,
  source: NodeJS.ProcessEnv,
  temp: NodeJS.ProcessEnv,
  onFailure?: (reason: string) => void,
  timeoutMs = MISE_ENV_TIMEOUT_MS,
): NodeJS.ProcessEnv | InspectionUnavailable {
  // A dispatched unit already received its complete command environment.
  // Repository mise configuration must not replace the dispatchers command lookup.
  if (source.AGX_WORKER_PATH_SOURCE === "dispatcher")
    return { ...source, ...temp, PATH: source.PATH };
  const home = source.HOME;
  const paths = (source.PATH ?? "/usr/bin:/bin").split(":");
  if (home !== undefined) {
    paths.push(
      join(home, ".local/bin"),
      join(home, ".cargo/bin"),
      join(home, ".bun/bin"),
    );
  }
  const prefixFile =
    source.AGX_BREW_PREFIX_FILE ??
    (home === undefined
      ? undefined
      : join(
          source.XDG_CONFIG_HOME ?? join(home, ".config"),
          "agx/brew-prefix",
        ));
  if (prefixFile !== undefined && existsSync(prefixFile)) {
    const prefix = readFileSync(prefixFile, "utf8").trim();
    if (prefix !== "") paths.push(join(prefix, "bin"), join(prefix, "sbin"));
  }
  const base = { ...source, PATH: [...new Set(paths)].join(":"), ...temp };
  const mise = Bun.which("mise", { PATH: base.PATH });
  if (mise === null) return base;
  const started = performance.now();
  const result = Bun.spawnSync([mise, "env", "--json"], {
    cwd,
    env: base,
    stdin: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (
    result.signalCode === "SIGKILL" &&
    performance.now() - started >= timeoutMs
  )
    return new InspectionTimeout(
      "MISE_ENV_TIMEOUT_MS",
      timeoutMs,
      [mise, "env", "--json"],
      cwd,
    );
  const parsed = jsonOf(z.record(z.string(), z.string())).safeParse(
    result.stdout.toString(),
  );
  if (result.exitCode === 75)
    return new InspectionUnavailable(
      result.stderr.toString().trim() === ""
        ? `inspection unavailable; command=${JSON.stringify([mise, "env", "--json"])}; cwd=${cwd}; exit=75; no stderr`
        : result.stderr
            .toString()
            .trim()
            .replaceAll(/[\r\n]+/gu, "; "),
    );
  if (result.exitCode !== 0 || !parsed.success) {
    if (onFailure !== undefined) {
      onFailure(
        `cannot assemble repository mise environment: ${(result.stderr.toString().trim() === "" ? undefined : result.stderr.toString().trim()) ?? "mise env returned invalid JSON"}`,
      );
      return base;
    }
    return exitWithError(
      "agx: cannot assemble repository mise environment\n",
      2,
    );
  }
  return { ...base, ...parsed.data, ...temp };
}
