import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGX_WORKER_ENV } from "../../shared/src/worker-env.ts";
import {
  workerEnvironment,
  workerSharedCaches,
} from "../src/workers/environment.ts";

const WORKER_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BUN_INSTALL_CACHE_DIR",
  "JULIA_DEPOT_PATH",
  "MISE_ACTIVATE_SHIMS",
  "MISE_SHELL",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_CACHE_DIR",
  "MISE_INSTALLS_DIR",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GRAVEYARD",
  "RIP_GRAVEYARD",
  "AGX_DISPATCHER_SESSION",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

describe("worker environment", () => {
  test("shared caches default to narrow roots under the worker home", () => {
    for (const home of [undefined, "/worker-home"]) {
      expect(workerSharedCaches({ HOME: home })).toEqual([
        {
          key: "BUN_INSTALL_CACHE_DIR",
          root: join(home ?? homedir(), ".bun", "install", "cache"),
        },
        { root: join(home ?? homedir(), ".cache", "cocoindex-code") },
        ...["compiled", "logs", "scratchspaces"].map((dir) => ({
          root: join(home ?? homedir(), ".julia", dir),
        })),
      ]);
    }
  });

  test("shared caches resolve overrides without granting the whole XDG cache home", () => {
    expect(
      workerSharedCaches({
        BUN_INSTALL_CACHE_DIR: "relative-bun-cache",
        XDG_CACHE_HOME: "relative-xdg-cache",
      }),
    ).toEqual([
      { key: "BUN_INSTALL_CACHE_DIR", root: resolve("relative-bun-cache") },
      { root: resolve("relative-xdg-cache", "cocoindex-code") },
      ...["compiled", "logs", "scratchspaces"].map((dir) => ({
        root: join(homedir(), ".julia", dir),
      })),
    ]);
  });

  test.each(["/first:/second", ":/first:/second"])(
    "selects the first non-empty Julia depot from %s",
    (path) => {
      const roots = workerSharedCaches({
        HOME: "/home-fixture",
        JULIA_DEPOT_PATH: path,
      }).map((cache) => cache.root);
      expect(roots.slice(2)).toEqual(
        ["compiled", "logs", "scratchspaces"].map((dir) => join("/first", dir)),
      );
      for (const forbidden of [
        "/first",
        "/second",
        "/home-fixture",
        ...["packages", "registries", "artifacts"].map((dir) =>
          join("/first", dir),
        ),
      ])
        expect(roots).not.toContain(forbidden);
    },
  );

  test("forwards the complete declared allow-list and AGX namespace", () => {
    const source = Object.fromEntries(
      [...WORKER_ENV_KEYS, "AGX_EXTRA_SETTING", "UNLISTED_SETTING"].map(
        (key) => [key, `${key}-fixture`],
      ),
    );
    const environment = workerEnvironment(source);

    expect(Object.keys(environment).toSorted()).toEqual(
      [...WORKER_ENV_KEYS, "AGX_EXTRA_SETTING", AGX_WORKER_ENV].toSorted(),
    );
    for (const key of WORKER_ENV_KEYS)
      expect(environment[key]).toBe(`${key}-fixture`);
    expect(environment.AGX_EXTRA_SETTING).toBe("AGX_EXTRA_SETTING-fixture");
    expect(environment[AGX_WORKER_ENV]).toBe("1");
    expect(environment.UNLISTED_SETTING).toBeUndefined();
  });

  test("excludes coordinator continuation and vendor session state", () => {
    const environment = workerEnvironment({
      TASK_CONTINUATION_SLOT: "/coordinator/continuation",
      CLAUDE_CODE_SESSION_ID: "coordinator-claude-session",
      CODEX_SESSION_ID: "coordinator-codex-session",
    });

    expect(environment.TASK_CONTINUATION_SLOT).toBeUndefined();
    expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(environment.CODEX_SESSION_ID).toBeUndefined();
  });
});
