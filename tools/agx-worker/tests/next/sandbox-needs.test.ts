import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxNeeds } from "../../src/next/sandbox-needs.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agx-sandbox-needs-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

test("systemd and known wrapper evidence names exact verify entries without executing them", async () => {
  const { workspace } = await fixture();
  await mkdir(join(workspace, ".git"));
  const warnings = await sandboxNeeds(
    workspace,
    "workspace-write",
    [],
    [
      "systemctl --user status fixture",
      "/bin/systemd-run --user true",
      "agent-resource-run --manifest fixture -- true",
    ],
    ["systemctl --user show fixture"],
  );
  expect(warnings).toHaveLength(4);
  expect(warnings[0]).toContain("verify[0]: systemctl --user status fixture");
  expect(warnings[3]).toContain("[verify].always[0]");
  for (const warning of warnings) {
    expect(warning).toContain("capability=user-systemd-bus");
    expect(warning).toContain("requested=workspace-write");
    expect(warning).toContain("allows=none");
    expect(warning).toContain("sandbox unchanged");
  }
  expect(
    await sandboxNeeds(
      workspace,
      "none",
      [],
      ["systemctl --user status fixture"],
    ),
  ).toEqual([]);
  expect(
    await sandboxNeeds(
      workspace,
      "workspace-write",
      [],
      ["systemctl status fixture", "bun check"],
    ),
  ).toEqual([]);
});

test("external Git worktree and common stores, relative jj pointer, and symlinks are canonicalized", async () => {
  const { root, workspace } = await fixture();
  const external = join(root, "store");
  await mkdir(external);
  await mkdir(join(root, "common"));
  await writeFile(join(external, "commondir"), "../common\n");
  await writeFile(join(workspace, ".git"), "gitdir: ../store\n");
  await mkdir(join(workspace, ".jj"));
  await writeFile(join(workspace, ".jj/repo"), "../../store\n");
  const warnings = await sandboxNeeds(
    workspace,
    "workspace-write",
    ["src/**"],
    ["jj rebase"],
  );
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain(`store=${external}`);
  expect(warnings[0]).toContain("writes[0]: src/**");
  expect(warnings[0]).toContain("verify[0]: jj rebase");
  expect(warnings[1]).toContain(`store=${join(root, "common")}`);
  await rm(join(workspace, ".git"));
  await rm(join(workspace, ".jj"), { recursive: true });
  await symlink(external, join(workspace, ".git"));
  expect(await sandboxNeeds(workspace, "workspace-write", [], [])).toHaveLength(
    2,
  );
});

test("local stores stay quiet; subdirectories use workspace boundary, not repository boundary", async () => {
  const { workspace } = await fixture();
  await mkdir(join(workspace, ".git"));
  await mkdir(join(workspace, ".jj/repo"), { recursive: true });
  await mkdir(join(workspace, "src"));
  expect(
    await sandboxNeeds(workspace, "workspace-write", ["src/**"], ["jj status"]),
  ).toEqual([]);
  expect(
    await sandboxNeeds(join(workspace, "src"), "workspace-write", ["**"], []),
  ).toHaveLength(2);
});
