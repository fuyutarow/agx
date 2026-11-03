// Bash deny rules a claude-route worker inherits from its workspace and user Claude settings.
// Read-only: the permissions themselves are never changed here.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fromThrowable } from "neverthrow";
import { z } from "../../shared/src/zod.ts";

const SettingsSchema = z.object({
  permissions: z.object({ deny: z.array(z.unknown()).optional() }).optional(),
});

/** The settings files Claude Code reads for a worker in `cwd`, project files first. */
function settingsFiles(cwd: string, home: string): string[] {
  const project = resolve(cwd, ".claude");
  return [
    join(project, "settings.json"),
    join(project, "settings.local.json"),
    join(home, ".claude", "settings.json"),
  ];
}

/** The deny entries of one settings file; a missing or malformed file contributes none. */
function denyEntries(file: string): unknown[] {
  const text = fromThrowable(() => readFileSync(file, "utf8"))();
  if (text.isErr()) return [];
  const json = fromThrowable(() => JSON.parse(text.value))();
  if (json.isErr()) return [];
  const parsed = SettingsSchema.safeParse(json.value);
  if (!parsed.success) return [];
  return parsed.data.permissions?.deny ?? [];
}

/** A Bash deny rule as the command pattern it names, or undefined for other tools' rules. */
function bashPattern(rule: unknown): string | undefined {
  if (typeof rule !== "string") return undefined;
  const trimmed = rule.trim();
  if (trimmed === "Bash") return "all Bash";
  const match = /^Bash\((.*)\)$/s.exec(trimmed);
  if (match === null) return undefined;
  const spec = (match[1] ?? "").trim();
  if (spec === "") return "all Bash";
  return spec.endsWith(":*") ? `${spec.slice(0, -2)} *` : spec;
}

/**
 * The effective Bash deny patterns for a worker in `cwd`: the project settings, the project local
 * settings, then the user settings, deduplicated in that order. Empty when none deny Bash.
 */
export function claudeBashDenies(
  cwd: string,
  home: string = process.env.HOME ?? homedir(),
): string[] {
  const patterns = settingsFiles(cwd, home)
    .flatMap(denyEntries)
    .map(bashPattern)
    .filter((pattern): pattern is string => pattern !== undefined);
  return [...new Set(patterns)];
}

/** The one line naming the denied Bash patterns for a claude-route brief; empty when none. */
export function claudeBashDenyLines(cwd: string, home?: string): string[] {
  const patterns = claudeBashDenies(cwd, home);
  if (patterns.length === 0) return [];
  return [
    `Bash denies: ${patterns.join(", ")}. Your workspace's Claude permissions deny these; choose other commands instead of trying them.`,
  ];
}
