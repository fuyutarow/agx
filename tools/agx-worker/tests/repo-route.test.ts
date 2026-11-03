import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadRoster } from "../src/roster/load.ts";
import { routeFilterLabel } from "../src/roster/index.ts";

const catalogPath = join(import.meta.dir, "../src/roster/catalog.toml");
const examplePath = join(import.meta.dir, "../src/roster/policy.example.toml");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A git repository with an untracked agx.toml; the loader reads the working copy then. */
async function repoWith(repoToml: string | undefined): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agx-repo-route-"));
  tempDirs.push(directory);
  const init = Bun.spawn(["git", "init", "-q", directory], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await init.exited).toBe(0);
  if (repoToml !== undefined)
    await writeFile(join(directory, "agx.toml"), repoToml, "utf8");
  return directory;
}

/** The user policy: the shipped example (codex-only routes and the shipped default). */
async function userPolicy(): Promise<string> {
  const example = await readFile(examplePath, "utf8");
  const directory = await mkdtemp(join(tmpdir(), "agx-user-policy-"));
  tempDirs.push(directory);
  const policyPath = join(directory, "agx.toml");
  await writeFile(policyPath, example, "utf8");
  return policyPath;
}

const CLAUDE_ROW = "haiku-low";
const CODEX_ROW = "luna-high";

describe("repository [route] override", () => {
  test("repo A with [route] yields the repo routes and default", async () => {
    const policyPath = await userPolicy();
    const repoRoot = await repoWith(
      `schema = 1\n[route]\nallow = ["claude"]\ndefault = "${CLAUDE_ROW}"\n`,
    );
    const loaded = await loadRoster({ catalogPath, policyPath, repoRoot });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.auto.routes).toEqual(["claude"]);
    expect(loaded.value.default).toBe(CLAUDE_ROW);
    expect(routeFilterLabel(loaded.value.auto)).toBe('routes=["claude"]');
  });

  test("keys the repo does not declare stay user-global", async () => {
    const policyPath = await userPolicy();
    const repoRoot = await repoWith(
      `schema = 1\n[route]\nallow = ["claude"]\ndefault = "${CLAUDE_ROW}"\n`,
    );
    const loaded = await loadRoster({ catalogPath, policyPath, repoRoot });
    const user = await loadRoster({
      catalogPath,
      policyPath,
      repoRoot: await repoWith("schema = 1\n"),
    });
    expect(loaded.ok && user.ok).toBe(true);
    if (!loaded.ok || !user.ok) return;
    expect(loaded.value.auto.on_window_exhausted).toEqual(
      user.value.auto.on_window_exhausted,
    );
  });

  test("repo B without [route] keeps the user policy routes", async () => {
    const policyPath = await userPolicy();
    const repoRoot = await repoWith("schema = 1\n");
    const loaded = await loadRoster({ catalogPath, policyPath, repoRoot });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.auto.routes).toEqual(["codex"]);
    expect(loaded.value.default).toBe(CODEX_ROW);
  });

  test("the override of one repo does not leak into another", async () => {
    const policyPath = await userPolicy();
    const repoA = await repoWith(
      `schema = 1\n[route]\nallow = ["claude"]\ndefault = "${CLAUDE_ROW}"\n`,
    );
    const repoB = await repoWith("schema = 1\n");
    const a = await loadRoster({ catalogPath, policyPath, repoRoot: repoA });
    const b = await loadRoster({ catalogPath, policyPath, repoRoot: repoB });
    expect(a.ok && a.value.auto.routes).toEqual(["claude"]);
    expect(b.ok && b.value.auto.routes).toEqual(["codex"]);
  });

  test("a default on a route the effective allow excludes is rejected naming the repo agx.toml", async () => {
    const policyPath = await userPolicy();
    const repoRoot = await repoWith(
      `schema = 1\n[route]\ndefault = "${CLAUDE_ROW}"\n`,
    );
    const loaded = await loadRoster({ catalogPath, policyPath, repoRoot });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toContain("non-excluded row on an allowed route");
      expect(loaded.error).toContain(join(repoRoot, "agx.toml"));
    }
  });

  test.each([
    ['schema = 1\n[route]\nallow = ["gemini"]\n', "route.allow"],
    [
      'schema = 1\n[route]\nexclude = ["luna-low"]\n',
      "route.exclude: unknown key",
    ],
    ["schema = 1\nbogus = 1\n", "bogus: unknown key"],
    ["schema = 1\n[ws]\nbogus = 1\n", "ws.bogus: unknown key"],
  ])(
    "an invalid repo agx.toml is rejected before any effect: %j",
    async (text, message) => {
      const policyPath = await userPolicy();
      const repoRoot = await repoWith(text);
      const loaded = await loadRoster({ catalogPath, policyPath, repoRoot });
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error).toContain(message);
        expect(loaded.error).toContain(join(repoRoot, "agx.toml"));
      }
    },
  );
});
