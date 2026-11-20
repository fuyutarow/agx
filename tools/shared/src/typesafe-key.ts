// The TypeSafe (Jev) API key, found in ONE place for every caller: dispatch's auto pick and, later,
// repo-retrieve's judge. Zero-dep like the hooks (Bun only).
//
// Order: TYPESAFE_API_KEY in the environment (a caller under `fnox exec`), then `fnox get` (the
// machine's secret store: macOS Keychain on the Mac, an age file on WSL — ~/.config/fnox), then the
// legacy ~/.config/typesafe/.env. Each miss is named, so "no key" always says where it looked, and
// a fnox miss says which kind it was, because each kind has a different repair command.
// The key is returned to the caller only; it is never printed, logged or put in argv.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Why fnox gave no value. */
export type FnoxMiss =
  | { kind: "not-installed" }
  | { kind: "no-config" }
  | { kind: "no-secret" }
  | { kind: "failed"; detail: string };

export type KeyLookup =
  | { ok: true; key: string; source: "env" | "fnox" | "file" }
  | { ok: false; reason: string; fnox: FnoxMiss; recover?: string };

const legacyFile = (): string =>
  join(process.env.HOME ?? homedir(), ".config/typesafe/.env");

const fnoxBin = (): string | null =>
  Bun.which("fnox", { PATH: process.env.PATH ?? "" });

function fnoxRun(args: string[]) {
  return Bun.spawnSync([fnoxBin() ?? "fnox", ...args], {
    cwd: process.env.HOME ?? homedir(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
}

/** fnox's own error text as one bounded line. A failed lookup never holds the value. */
function fnoxError(stderr: string): string {
  const text = stderr
    .replaceAll(process.env.HOME ?? homedir(), "~")
    .replaceAll(/[│×]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const message = /^Error:\s*(?:fnox::\S+(?:\s+\(\S+\))?\s+)?(.*)$/u.exec(
    text,
  )?.[1];
  return (message ?? text).slice(0, 200).trim();
}

function fromFnox(
  name: string,
): { ok: true; key: string } | { ok: false; miss: FnoxMiss } {
  const r = fnoxRun(["get", name]);
  if (r.exitCode !== 0) {
    const error = fnoxError(r.stderr.toString());
    if (error.startsWith("No configuration file found"))
      return { ok: false, miss: { kind: "no-config" } };
    if (/^Secret \S+ not found/u.test(error))
      return { ok: false, miss: { kind: "no-secret" } };
    const exit = `fnox exit ${r.exitCode ?? "killed"}`;
    return {
      ok: false,
      miss: {
        kind: "failed",
        detail: error === "" ? exit : `${exit}: ${error}`,
      },
    };
  }
  const key = r.stdout.toString().trim();
  return key === ""
    ? {
        ok: false,
        miss: { kind: "failed", detail: "fnox returned an empty value" },
      }
    : { ok: true, key };
}

function fromLegacyFile(): string | undefined {
  if (!existsSync(legacyFile())) return undefined;
  const m = /^TYPESAFE_API_KEY=(\S+)$/mu.exec(
    readFileSync(legacyFile(), "utf8"),
  );
  return m?.[1];
}

function missText(name: string, miss: FnoxMiss): string {
  if (miss.kind === "not-installed") return "fnox not installed";
  if (miss.kind === "no-config") return "fnox has no config file";
  if (miss.kind === "no-secret") return `fnox config has no ${name}`;
  return miss.detail;
}

/**
 * The command that repairs a fnox miss for `name`, to run in a terminal. It never holds the value:
 * `fnox set` without a value argument prompts for it with hidden input.
 */
export function fnoxRecovery(name: string, miss: FnoxMiss): string {
  const set = `fnox set -g ${name}`;
  if (miss.kind === "not-installed")
    return `brew install fnox && fnox init -g && ${set}`;
  if (miss.kind === "no-config") return `fnox init -g && ${set}`;
  if (miss.kind === "failed") return "fnox doctor";
  const listed = fnoxRun(["provider", "list"]);
  const providers =
    listed.exitCode === 0
      ? listed.stdout
          .toString()
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^[\w.-]+$/u.test(line))
      : [];
  if (providers.length === 1) return `${set} --provider ${providers[0]}`;
  return providers.length === 0
    ? `fnox provider add --global <name> <type> && ${set} --provider <name>`
    : `${set} --provider <${providers.join("|")}>`;
}

/** Resolve a named secret without exposing it in process arguments or diagnostics. */
export function resolveSecret(
  name: string,
  environment: NodeJS.ProcessEnv,
  file: () => string | undefined,
  fileDescription: string,
): KeyLookup {
  const env = environment[name];
  if (env !== undefined && env !== "")
    return { ok: true, key: env, source: "env" };
  const fnox =
    fnoxBin() === null
      ? { ok: false as const, miss: { kind: "not-installed" as const } }
      : fromFnox(name);
  if (fnox.ok) return { ok: true, key: fnox.key, source: "fnox" };
  const key = file();
  if (key !== undefined) return { ok: true, key, source: "file" };
  return {
    ok: false,
    reason: `no ${name} (env unset; ${missText(name, fnox.miss)}; ${fileDescription})`,
    fnox: fnox.miss,
  };
}

/**
 * The key and where it came from, or why none was found (every place tried is named) and the
 * command that stores it.
 */
export function typesafeKey(): KeyLookup {
  const lookup = resolveSecret(
    "TYPESAFE_API_KEY",
    process.env,
    fromLegacyFile,
    `${legacyFile()} absent or without the key`,
  );
  return lookup.ok
    ? lookup
    : { ...lookup, recover: fnoxRecovery("TYPESAFE_API_KEY", lookup.fnox) };
}
