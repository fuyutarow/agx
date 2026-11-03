import { resolve } from "node:path";

/** Re-enter this executable, never another installation found on PATH. */
export function selfCommand(runtime?: {
  execPath: string;
  main: string;
}): string[] {
  const execPath = runtime?.execPath ?? process.execPath;
  const main = runtime?.main ?? Bun.main;
  // Bun embeds the entry under $bunfs in a single-file executable.
  // process.execPath is the absolute runtime executable in both modes.
  if (main.startsWith("/$bunfs/")) return [execPath];
  return [execPath, resolve(main)];
}

/**
 * Homebrew replaces Cellar versions during upgrades; the opt link survives them.
 * A lone `<prefix>/Cellar/agx/<version>/bin/agx-worker` maps to
 * `<prefix>/opt/agx/bin/agx-worker`; every other command is returned unchanged.
 */
export function stableCommand(command: readonly string[]): string[] {
  const out = [...command];
  if (out.length !== 1) return out;
  const cellar = /^(.*)\/Cellar\/agx\/[^/]+\/bin\/agx-worker$/u.exec(
    out[0] ?? "",
  );
  if (cellar?.[1] !== undefined) out[0] = `${cellar[1]}/opt/agx/bin/agx-worker`;
  return out;
}

/** The only command other code may use to re-enter agx-worker or record one for later spawning. */
export function stableSelfCommand(
  runtime?: Parameters<typeof selfCommand>[0],
): string[] {
  return stableCommand(selfCommand(runtime));
}
