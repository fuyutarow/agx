import { resolve } from "node:path";
import { selfExecutable } from "../../shared/src/self-executable.ts";

/** Re-enter this executable, never another installation found on PATH. */
export function selfCommand(): string[] {
  // Bun embeds the entry under $bunfs in a single-file executable.
  if (Bun.main.startsWith("/$bunfs/")) return [selfExecutable()];
  return [selfExecutable(), resolve(Bun.main)];
}
