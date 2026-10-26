import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGE_LAND_ENV } from "../src/change.ts";

const entry = join(import.meta.dir, "../src/agx.ts");

test("change contract: single mover", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-change-single-mover-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  try {
    expect((await git(root, ["init", "--bare", remote])).code).toBe(0);
    expect((await git(root, ["init", repo])).code).toBe(0);
    expect(
      (await git(repo, ["config", "user.name", "Change Contract"])).code,
    ).toBe(0);
    expect(
      (
        await git(repo, [
          "config",
          "user.email",
          "change-contract@example.invalid",
        ])
      ).code,
    ).toBe(0);
    await writeFile(join(repo, "story.txt"), "first\n");
    expect((await git(repo, ["add", "story.txt"])).code).toBe(0);
    expect((await git(repo, ["commit", "-m", "initial"])).code).toBe(0);
    expect((await git(repo, ["branch", "-M", "alpha"])).code).toBe(0);
    expect((await git(repo, ["remote", "add", "origin", remote])).code).toBe(0);
    expect((await git(repo, ["push", "-u", "origin", "alpha"])).code).toBe(0);

    await writeFile(join(repo, "story.txt"), "second\n");
    expect((await git(repo, ["add", "story.txt"])).code).toBe(0);
    expect((await git(repo, ["commit", "-m", "second"])).code).toBe(0);

    const hook = join(repo, ".git", "hooks", "pre-push");
    await writeFile(
      hook,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} change hook pre-push "$@"\n`,
    );
    await chmod(hook, 0o755);

    const before = await git(root, [
      "--git-dir",
      remote,
      "rev-parse",
      "refs/heads/alpha",
    ]);
    expect(before.code).toBe(0);
    const refused = await git(repo, ["push", "origin", "alpha"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("agx change hook pre-push");
    expect(refused.stderr).toContain("use agx change land");
    const afterRefusal = await git(root, [
      "--git-dir",
      remote,
      "rev-parse",
      "refs/heads/alpha",
    ]);
    expect(afterRefusal.stdout.trim()).toBe(before.stdout.trim());

    const landed = await git(repo, ["push", "origin", "alpha"], {
      [CHANGE_LAND_ENV]: "1",
    });
    expect(landed.code, landed.stderr).toBe(0);

    expect((await git(repo, ["checkout", "-b", "side"])).code).toBe(0);
    await writeFile(join(repo, "side.txt"), "side\n");
    expect((await git(repo, ["add", "side.txt"])).code).toBe(0);
    expect((await git(repo, ["commit", "-m", "side"])).code).toBe(0);
    const side = await git(repo, ["push", "-u", "origin", "side"]);
    expect(side.code, side.stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
