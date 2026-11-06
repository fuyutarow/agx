import { lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fromThrowable } from "neverthrow";
import {
  AGX_WORKER_ENV,
  AGX_WORKER_VALUE,
} from "../../../shared/src/worker-env.ts";

const WORKER_ENV_KEYS = [
  // Process location and locale keep command lookup and text behavior consistent.
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  // User and terminal identity let interactive tools identify their expected host context.
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  // The run-owned temp directory agx removes when the run ends.
  "TMPDIR",
  "TMP",
  "TEMP",
  // Shared package cache selected by the dispatcher, also used as a Codex writable root.
  "BUN_INSTALL_CACHE_DIR",
  "JULIA_DEPOT_PATH",
  // mise's active shell and explicit roots keep declared tool config and data discoverable.
  "MISE_ACTIVATE_SHIMS",
  "MISE_SHELL",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_CACHE_DIR",
  "MISE_INSTALLS_DIR",
  // XDG locations resolve user config, state, data, and cache for agx and systemd services.
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // Custom CA paths keep HTTPS clients on the user's configured trust store.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // rip and repo tools need the user's recovery graveyard locations.
  "GRAVEYARD",
  "RIP_GRAVEYARD",
  // The dispatcher session is explicitly attributed to workers; coordinator IDs stay excluded.
  "AGX_DISPATCHER_SESSION",
  // Provider credentials let workers use the coordinator's authenticated model services.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

/** The one shared-cache declaration: environment values and writable roots use these same paths. */
export function workerSharedCaches(
  source: NodeJS.ProcessEnv = process.env,
): { key?: string; root: string }[] {
  const depot = resolve(
    source.JULIA_DEPOT_PATH?.split(":").find((entry) => entry !== "") ??
      join(source.HOME ?? homedir(), ".julia"),
  );
  return [
    {
      key: "BUN_INSTALL_CACHE_DIR",
      root: resolve(
        source.BUN_INSTALL_CACHE_DIR ??
          join(source.HOME ?? homedir(), ".bun", "install", "cache"),
      ),
    },
    {
      root: resolve(
        source.XDG_CACHE_HOME ?? join(source.HOME ?? homedir(), ".cache"),
        "cocoindex-code",
      ),
    },
    ...["compiled", "logs", "scratchspaces"].map((directory) => ({
      root: join(depot, directory),
    })),
  ];
}

/**
 * The writable roots for a workspace-write worker, from one declaration: the shared caches and the
 * run dir. The codex route passes exactly this list; the claude route extends it with the temp
 * roots in claudeWorkspaceWriteSettings, so both routes read the same source.
 */
export function workerWritableRoots(input: {
  runDir?: string | undefined;
  source?: NodeJS.ProcessEnv | undefined;
}): string[] {
  const roots = [
    ...workerSharedCaches(input.source ?? process.env).map(
      (cache) => cache.root,
    ),
    ...(input.runDir === undefined ? [] : [resolve(input.runDir)]),
    ...((input.source ?? process.env).TMPDIR === undefined
      ? []
      : [resolve((input.source ?? process.env).TMPDIR ?? "")]),
  ];
  return [...new Set(roots)];
}

/**
 * The workspace-relative paths the Claude Code sandbox protects from writes. A sandbox that is
 * killed leaves an empty read-only placeholder at each one it mounted; this is the one list of
 * those names, read by the cleanup below.
 */
export const CLAUDE_SANDBOX_PROTECTED_PATHS: readonly string[] = [
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".gitconfig",
  ".gitmodules",
  ".mcp.json",
  ".ripgreprc",
  ".idea",
  ".vscode",
  ".claude/commands",
  ".claude/agents",
  ".claude/skills",
  ".claude/hooks",
  ".claude/settings.json",
  ".claude/settings.local.json",
];

/**
 * Remove the placeholders a claude sandbox left in the workspace. Only a protected name that is
 * absent from the pre-run snapshot and is now a regular empty file is removed; a path that existed
 * before the run, a directory, a non-empty file and any other name stay. Returns the removed
 * paths, sorted. An unreadable snapshot (undefined) removes nothing.
 */
export function removeClaudeSandboxStubs(
  cwd: string,
  before: ReadonlyMap<string, unknown> | undefined,
): string[] {
  if (before === undefined) return [];
  const removed: string[] = [];
  for (const path of CLAUDE_SANDBOX_PROTECTED_PATHS) {
    if (before.has(path)) continue;
    const absolute = join(resolve(cwd), path);
    const done = fromThrowable(() => {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size > 0) return false;
      unlinkSync(absolute);
      return true;
    })();
    if (done.isOk() && done.value) removed.push(path);
  }
  return removed.toSorted();
}

/**
 * Network egress of a workspace-write worker, one declaration for both routes. The codex route
 * passes it as sandbox_workspace_write.network_access (codex.ts); the claude route grants all
 * domains plus the web tools when it is true. `[route] no_egress` is not applied on either route.
 */
export const WORKSPACE_WRITE_NETWORK_ACCESS = true;

/** The web tools a claude workspace-write worker is allowed exactly when network egress is granted. */
export const CLAUDE_WEB_TOOLS: readonly string[] = ["WebFetch", "WebSearch"];

/** The --allowed-tools value (one comma-separated string) of a claude workspace-write worker. */
export function claudeWorkspaceWriteAllowedTools(): string {
  return [
    "Bash",
    ...(WORKSPACE_WRITE_NETWORK_ACCESS ? CLAUDE_WEB_TOOLS : []),
  ].join(",");
}

/**
 * The read scope of a claude workspace-write worker, matching codex workspace-write, which
 * restricts writes and not reads: the Read tool (and the Glob and Grep tools, which follow Read
 * rules) may open any absolute path. A permissions.allow rule grants read only; writes stay with
 * the sandbox allowWrite roots and the run dir. Deny rules declared by the repository still win.
 */
export const CLAUDE_READ_ALLOW: readonly string[] = ["Read(//**)"];

/**
 * Claude settings for a workspace-write worker. allowWrite is the run's temp directory, the system
 * temp directory, then the shared writable roots (the codex list), which already holds the run dir.
 * Codex gets its temp directory from its own sandbox defaults, so only the claude route lists it.
 * Read-only and none sandboxes do not use these settings.
 */
export function claudeWorkspaceWriteSettings(input: {
  runDir: string;
  runTemp: string;
  source?: NodeJS.ProcessEnv | undefined;
}): {
  permissions: { additionalDirectories: string[]; allow: string[] };
  sandbox: {
    enabled: true;
    autoAllowBashIfSandboxed: true;
    allowUnsandboxedCommands: false;
    failIfUnavailable: true;
    filesystem: { allowWrite: string[] };
    network?: { allowedDomains: string[] };
  };
} {
  const shared = workerWritableRoots({
    runDir: input.runDir,
    source: input.source,
  });
  return {
    permissions: {
      additionalDirectories: [resolve(input.runDir)],
      allow: [...CLAUDE_READ_ALLOW],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        allowWrite: [...new Set([resolve(input.runTemp), "/tmp", ...shared])],
      },
      ...(WORKSPACE_WRITE_NETWORK_ACCESS
        ? { network: { allowedDomains: ["*"] } }
        : {}),
    },
  };
}

/** Build the complete child environment; coordinator and vendor session state never crosses. */
export function workerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of WORKER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      key.startsWith("AGX_") &&
      key !== "AGX_MSG_FROM" &&
      key !== "AGX_XMSG_BOUND_CLAUDE_TARGET" &&
      value !== undefined
    )
      environment[key] = value;
  }
  environment[AGX_WORKER_ENV] = AGX_WORKER_VALUE;
  return environment;
}
