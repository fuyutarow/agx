import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  claudeWorkspaceWriteSettings,
  workerSharedCaches,
  workerWritableRoots,
} from "../src/workers/environment.ts";

// Every path here is inside a temporary directory the test creates and removes.
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "agx-test-claude-roots-"));
  const home = join(base, "home");
  const runDir = join(base, "state", "runs", "run-1");
  const runTemp = join(base, "cache", "agx", "tmp", "run-1");
  const mainCheckout = join(base, "main");
  await mkdir(home, { recursive: true });
  await mkdir(join(mainCheckout, ".jj", "repo"), { recursive: true });
  await mkdir(join(mainCheckout, ".git"), { recursive: true });
  const source = {
    HOME: home,
    PATH: process.env.PATH,
    BUN_INSTALL_CACHE_DIR: join(home, ".bun", "install", "cache"),
    JULIA_DEPOT_PATH: join(home, ".julia-depot"),
    XDG_CACHE_HOME: join(home, ".cache"),
  } satisfies NodeJS.ProcessEnv;
  return {
    base,
    home,
    runDir,
    runTemp,
    mainCheckout,
    source,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

describe("claude workspace-write sandbox roots", () => {
  test("allowWrite holds the run dir, the system temp dir and each shared cache root", async () => {
    const f = await fixture();
    try {
      const settings = claudeWorkspaceWriteSettings({
        runDir: f.runDir,
        runTemp: f.runTemp,
        source: f.source,
      });
      const allow = settings.sandbox.filesystem.allowWrite;
      expect(allow).toContain(resolve(f.runDir));
      expect(allow).toContain(resolve(f.runTemp));
      expect(allow).toContain("/tmp");
      for (const cache of workerSharedCaches(f.source))
        expect(allow).toContain(cache.root);
      expect(settings.permissions.additionalDirectories).toEqual([
        resolve(f.runDir),
      ]);
    } finally {
      await f.cleanup();
    }
  });

  test("claude allowWrite is the run temp, the system temp, then the codex list (caches plus run dir)", async () => {
    const f = await fixture();
    try {
      const codexRoots = workerWritableRoots({
        runDir: f.runDir,
        source: f.source,
      });
      expect(codexRoots).toEqual([
        ...workerSharedCaches(f.source).map((cache) => cache.root),
        resolve(f.runDir),
      ]);
      const settings = claudeWorkspaceWriteSettings({
        runDir: f.runDir,
        runTemp: f.runTemp,
        source: f.source,
      });
      expect(settings.sandbox.filesystem.allowWrite).toEqual([
        resolve(f.runTemp),
        "/tmp",
        ...codexRoots,
      ]);
    } finally {
      await f.cleanup();
    }
  });

  test("neither route can write the VCS store or the main checkout", async () => {
    const f = await fixture();
    try {
      const allow = claudeWorkspaceWriteSettings({
        runDir: f.runDir,
        runTemp: f.runTemp,
        source: f.source,
      }).sandbox.filesystem.allowWrite;
      const protectedPaths = [
        join(f.mainCheckout, ".jj"),
        join(f.mainCheckout, ".jj", "repo"),
        join(f.mainCheckout, ".git"),
        f.mainCheckout,
      ].map((path) => resolve(path));
      // The fixture main checkout sits under os.tmpdir(), which is /tmp on the router, so the
      // system temp root is exempt from the containment check. Equality still applies to it.
      for (const root of allow) {
        for (const protectedPath of protectedPaths) {
          expect(root === protectedPath).toBe(false);
          if (root !== "/tmp")
            expect(protectedPath.startsWith(`${root}/`)).toBe(false);
        }
      }
    } finally {
      await f.cleanup();
    }
  });

  test("the shared list has no duplicate roots", async () => {
    const f = await fixture();
    try {
      const roots = workerWritableRoots({ runDir: f.runDir, source: f.source });
      expect(new Set(roots).size).toBe(roots.length);
    } finally {
      await f.cleanup();
    }
  });
});
