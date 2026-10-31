import { resolve } from "node:path";

/** Re-enter this executable, never another installation found on PATH. */
export function selfCommand(): string[] {
  // Bun embeds the entry under $bunfs in a single-file executable.
  // process.execPath is the absolute runtime executable in both modes.
  if (Bun.main.startsWith("/$bunfs/")) return [process.execPath];
  return [process.execPath, resolve(Bun.main)];
}
