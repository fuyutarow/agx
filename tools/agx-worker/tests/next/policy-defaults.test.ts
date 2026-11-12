import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoster } from "../../src/roster/index.ts";

const example = await readFile(
  new URL("../../src/roster/policy.example.toml", import.meta.url),
  "utf8",
);
const cases = [
  ["route.allow", /^allow = .*\n/mu],
  ["route.on_window_exhausted", /^on_window_exhausted = .*\n/mu],
  ["route.exclude", /^exclude = .*\n/mu],
  ["route.max_task_chars", /^max_task_chars = .*\n/mu],
  ["route.timeout_ms", /^timeout_ms = .*\n/mu],
  ["route.pick_temperature", /^pick_temperature = .*\n/mu],
  ["route.jev.api", /^api = .*\n/mu],
  ["route.jev.url", /^url = .*\n/mu],
  ["route.jev.model", /^model = .*\n/mu],
  ["claude_run.max_budget_usd", /^max_budget_usd = .*\n/mu],
  ["claude_run.max_turns", /^max_turns = .*\n/mu],
  ["claude_run.reason", /^reason = .*\n/mu],
] as const;
for (const [key, line] of cases)
  test(`requires ${key}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agx-required-policy-"));
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      rmSync(root, { recursive: true, force: true });
    });
    {
      const path = join(root, "policy.toml");
      await writeFile(path, example.replace(line, ""));
      const result = await loadRoster({ policyPath: path, repoRoot: root });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(key);
        expect(result.error).toContain("example:");
      }
    }
  });
test("complete example loads; absent policy fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-required-policy-"));
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  {
    const path = join(root, "policy.toml");
    await writeFile(path, example);
    expect((await loadRoster({ policyPath: path, repoRoot: root })).ok).toBe(
      true,
    );
    const absent = await loadRoster({
      policyPath: join(root, "absent"),
      repoRoot: root,
    });
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.error).toContain("absent");
      expect(absent.error).toContain("policy.example.toml");
    }
  }
});
