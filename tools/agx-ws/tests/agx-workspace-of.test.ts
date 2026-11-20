// The jj-commit trunk guard recognizes the workspaces agx ws add creates; before, it looked for a
// `<repo>-arm-*` name that no current workspace has, so a commit from `<repo>.ws/ws_<slug>` passed.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgxWorkspaceOf } from "../src/workspace.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

setDefaultTimeout(60_000);
const scratch = mkdtempSync(join(tmpdir(), "agx-ws-of-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("only <parent>/<repo>.ws/ws_<slug> is an agx workspace of <parent>/<repo>", () => {
  expect(isAgxWorkspaceOf("/w/dotfiles", "/w/dotfiles.ws/ws_br-migrate")).toBe(
    true,
  );
  expect(isAgxWorkspaceOf("/w/dotfiles/", "/w/dotfiles.ws/ws_a/")).toBe(true);
  // The retired arm naming, another repository's workspace area, and non-ws_ names are not.
  expect(isAgxWorkspaceOf("/w/dotfiles", "/w/dotfiles-arm-1")).toBe(false);
  expect(isAgxWorkspaceOf("/w/dotfiles", "/w/agx.ws/ws_a")).toBe(false);
  expect(isAgxWorkspaceOf("/w/dotfiles", "/w/dotfiles.ws/scratch")).toBe(false);
  expect(isAgxWorkspaceOf("/w/dotfiles", "/w/dotfiles")).toBe(false);
  expect(isAgxWorkspaceOf("/w/dotfiles", "/w/dotfiles.ws/ws_a/sub")).toBe(
    false,
  );
});

test("jj-commit in an agx workspace refuses to pick trunk without an explicit bookmark", async () => {
  const env = subprocessEnvironment({
    HOME: scratch,
    JJ_USER: "fixture",
    JJ_EMAIL: "fixture@example.invalid",
  });
  delete env.BOOKMARK;
  const repo = join(scratch, "repo");
  const run = async (cmd: string[], cwd: string) => {
    const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { code, stderr };
  };
  expect((await run(["jj", "git", "init", repo], scratch)).code).toBe(0);
  mkdirSync(join(scratch, "repo.ws"));
  const workspace = join(scratch, "repo.ws", "ws_fixture");
  expect(
    (
      await run(
        ["jj", "workspace", "add", "--name", "ws_fixture", workspace],
        repo,
      )
    ).code,
  ).toBe(0);
  const commit = await run(
    [process.execPath, join(import.meta.dir, "../../jj-commit.ts")],
    workspace,
  );
  expect(commit.stderr).toContain(
    "agx workspace commit needs an explicit target",
  );
  expect(commit.code).toBe(1);
  // Naming trunk explicitly is refused too, and both refusals name a route this repository has:
  // it defines no land task, so trunk moves in the main checkout.
  const trunk = await run(
    [
      process.execPath,
      join(import.meta.dir, "../../jj-commit.ts"),
      "--bookmark",
      "alpha",
    ],
    workspace,
  );
  expect(trunk.stderr).toContain(
    "cannot move trunk bookmark 'alpha' from an agx workspace",
  );
  expect(trunk.code).toBe(1);
  for (const refusal of [commit.stderr, trunk.stderr]) {
    expect(refusal).toContain(`in the main checkout ${repo} run`);
    expect(refusal).toContain("mise run push");
    expect(refusal).not.toContain("mise run land");
  }
});
