import { existsSync } from "node:fs";

/** Re-enter the running image even if its installed path has been removed. */
export function selfExecutable(
  exists: (path: string) => boolean = existsSync,
): string {
  if (process.platform === "linux" && exists("/proc/self/exe"))
    return "/proc/self/exe";
  return process.execPath;
}
