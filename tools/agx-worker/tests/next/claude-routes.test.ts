import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/next/route.ts";
import { loadRoster } from "../../src/roster/index.ts";
import { runClaude } from "../../src/workers/run-claude.ts";

const example = readFileSync(
  new URL("../../src/roster/policy.example.toml", import.meta.url),
  "utf8",
);
const names = [
  "HOME",
  "XDG_CONFIG_HOME",
  "AGX_CONFIG",
  "AGX_STATE_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "TYPESAFE_API_KEY",
  "PATH",
  "JEV_URL",
] as const;
const saved = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup(allow = '["codex", "claude-session"]') {
  const root = mkdtempSync(join(tmpdir(), "agx-claude-routes-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  const fnox = join(root, "bin", "fnox");
  writeFileSync(fnox, `#!/bin/sh\necho called >> '${root}/fnox.log'\nexit 1\n`);
  chmodSync(fnox, 0o755);
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.AGX_STATE_DIR = join(root, "state");
  process.env.PATH = `${join(root, "bin")}:${saved.PATH ?? ""}`;
  process.env.AGX_CONFIG = join(root, "policy.toml");
  writeFileSync(
    process.env.AGX_CONFIG,
    example
      .replace(/^allow = .*$/mu, `allow = ${allow}`)
      .replace(
        '"claude-session" = "stop"',
        '"claude-session" = "stop", "claude-api" = "continue"',
      ),
  );
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.TYPESAFE_API_KEY = "fixture";
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: {
          worker: { choice: "localized", probabilities: { localized: 1 } },
        },
      }),
  });
  servers.push(server);
  process.env.JEV_URL = `http://127.0.0.1:${server.port}/`;
  return root;
}
test("session-only routing neither calls fnox nor picks API even with a key", async () => {
  const root = setup();
  process.env.ANTHROPIC_API_KEY = "secret";
  expect((await route("localized work", [], 600)).route).not.toBe("claude-api");
  expect(existsSync(join(root, "fnox.log"))).toBe(false);
  delete process.env.ANTHROPIC_API_KEY;
  expect((await route("localized work", [], 600)).route).not.toBe("claude-api");
  expect(existsSync(join(root, "fnox.log"))).toBe(false);
});
test("declared API with a key is preferred; marker filters it", async () => {
  const root = setup('["codex", "claude-session", "claude-api"]');
  process.env.ANTHROPIC_API_KEY = "secret";
  expect((await route("localized work", [], 600)).route).toBe("claude-api");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "claude-credits-unavailable"),
    "unavailable",
  );
  expect((await route("localized work", [], 600)).route).not.toBe("claude-api");
});
test("API without a key is filtered and old route is rejected", async () => {
  const root = setup('["codex", "claude-api"]');
  expect((await route("localized work", [], 600)).route).toBe("codex");
  writeFileSync(
    process.env.AGX_CONFIG!,
    example.replace(/^allow = .*$/mu, 'allow = ["claude"]'),
  );
  const loaded = await loadRoster({ repoRoot: root });
  expect(loaded.ok).toBe(false);
  if (!loaded.ok)
    expect(loaded.error).toContain(
      'route "claude" was split: write "claude-api" or "claude-session"',
    );
});
test("session subprocess strips both credentials without fnox", async () => {
  const root = setup();
  process.env.ANTHROPIC_API_KEY = "secret";
  process.env.ANTHROPIC_AUTH_TOKEN = "token";
  const bin = join(root, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s:%s' "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" > '${root}/seen'\necho '{"result":"ok"}'\n`,
  );
  chmodSync(bin, 0o755);
  const result = await runClaude({
    target: root,
    prompt: "test",
    model: "test",
    permissionMode: "plan",
    maxTurns: 1,
    timeoutMs: 10000,
    safeMode: false,
    bare: false,
    claudeBin: bin,
    route: "claude-session",
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, "seen"), "utf8")).toBe(":");
  expect(existsSync(join(root, "fnox.log"))).toBe(false);
});
