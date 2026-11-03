import { resolve } from "node:path";

/** Re-enter this executable, never another installation found on PATH. */
export function selfCommand(): string[] {
  // Bun embeds the entry under $bunfs in a single-file executable.
  // process.execPath is the absolute runtime executable in both modes.
  if (Bun.main.startsWith("/$bunfs/")) return [process.execPath];
  return [process.execPath, resolve(Bun.main)];
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
