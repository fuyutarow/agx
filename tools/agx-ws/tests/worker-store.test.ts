import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  addWorkerStore,
  chmodTree,
  removeFixture,
  repoFixture,
  run,
  snapshot,
  type RepoFixture,
} from "./worker-store-fixture.ts";

const fixtures: RepoFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map(removeFixture));
});

test("workspace contract: worker store (a)(b) keeps JJ writes inside the isolated clone", async () => {
  const fixture = await repoFixture();
  fixtures.push(fixture);
  const { workspace } = await addWorkerStore(fixture, "guard");
  const remotes = await run(
    ["jj", "git", "remote", "list"],
    workspace,
    fixture.env,
  );
  expect(remotes.code, remotes.err).toBe(0);
  expect(remotes.out.trim()).toBe(`origin ${fixture.source}`);
  const before = await Promise.all([
    snapshot(join(fixture.source, ".jj")),
    snapshot(join(fixture.source, ".git")),
    snapshot(fixture.remote),
  ]);

  try {
    await chmodTree(join(fixture.source, ".jj"), false);
    await chmodTree(join(fixture.source, ".git"), false);
    await chmodTree(fixture.remote, false);

    await Bun.write(join(workspace, "worker.txt"), "worker\n");
    for (const args of [
      ["status"],
      ["diff"],
      ["describe", "-m", "worker change"],
      ["commit", "-m", "worker change"],
    ]) {
      const result = await run(["jj", ...args], workspace, fixture.env);
      expect(result.code, `jj ${args.join(" ")}: ${result.err}`).toBe(0);
    }

    const tracked = await run(
      ["jj", "bookmark", "track", "alpha@origin"],
      workspace,
      fixture.env,
    );
    expect(tracked.code, tracked.err).toBe(0);
    const moved = await run(
      ["jj", "bookmark", "set", "alpha"],
      workspace,
      fixture.env,
    );
    expect(moved.code, moved.err).toBe(0);

    const defaultPush = await run(
      ["jj", "git", "push"],
      workspace,
      fixture.env,
    );
    expect(defaultPush.code).not.toBe(0);
    const pointAtChange = await run(
      ["jj", "bookmark", "set", "alpha", "-r", "@-", "--allow-backwards"],
      workspace,
      fixture.env,
    );
    expect(pointAtChange.code, pointAtChange.err).toBe(0);
    const explicitPush = await run(
      ["jj", "git", "push", "--remote", "origin", "--bookmark", "alpha"],
      workspace,
      fixture.env,
    );
    expect(explicitPush.code).not.toBe(0);
    expect(explicitPush.err).toMatch(
      /read-only|permission|lock|refuse|cannot/u,
    );

    expect(
      await Promise.all([
        snapshot(join(fixture.source, ".jj")),
        snapshot(join(fixture.source, ".git")),
        snapshot(fixture.remote),
      ]),
    ).toEqual(before);
  } finally {
    await chmodTree(join(fixture.source, ".jj"), true);
    await chmodTree(join(fixture.source, ".git"), true);
    await chmodTree(fixture.remote, true);
  }
});
