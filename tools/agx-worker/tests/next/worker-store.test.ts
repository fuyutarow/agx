import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addWorkerStore,
  removeFixture,
  repoFixture,
  run,
  snapshot,
  type RepoFixture,
} from "../../../agx-ws/tests/worker-store-fixture.ts";

const fixtures: RepoFixture[] = [];
setDefaultTimeout(30_000);
afterAll(async () => {
  await Promise.all(fixtures.map(removeFixture));
});

test("workspace contract: worker store (c) accept publishes exactly the worker commit", async () => {
  const fixture = await repoFixture();
  fixtures.push(fixture);
  const ticketPath = join(
    fixture.source,
    ".agents",
    "tickets",
    "worker-store.md",
  );
  await writeFile(ticketPath, "Worker store acceptance fixture.\n");
  const { workspace } = await addWorkerStore(fixture, "accepted");
  const before = await run(
    ["jj", "log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"'],
    fixture.source,
    fixture.env,
  );
  expect(before.code, before.err).toBe(0);
  const previousCommits = new Set(
    before.out.trim().split("\n").filter(Boolean),
  );
  await Bun.write(join(workspace, "worker.txt"), "accepted work\n");
  for (const args of [
    ["describe", "-m", "accepted worker change"],
    ["commit", "-m", "accepted worker change"],
  ]) {
    const result = await run(["jj", ...args], workspace, fixture.env);
    expect(result.code, `jj ${args.join(" ")}: ${result.err}`).toBe(0);
  }
  const ownCommit = await run(
    ["jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id"],
    workspace,
    fixture.env,
  );
  expect(ownCommit.code, ownCommit.err).toBe(0);
  const commit = ownCommit.out.trim();
  const bareBefore = await snapshot(fixture.remote);
  const id = "worker-accept-fixture";
  const state = fixture.env.AGX_STATE_DIR;
  if (state === undefined) expect.unreachable("fixture has no state directory");
  await mkdir(state, { recursive: true });
  const at = "2026-10-27T00:00:00Z";
  const records = [
    {
      kind: "started",
      id,
      at,
      ticket: "worker-store",
      writes: ["worker.txt"],
      cwd: workspace,
      workspace,
      row: "fixture",
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
      ticket_path: ticketPath,
    },
    {
      kind: "ended",
      id,
      at: "2026-10-27T00:01:00Z",
      exit: 0,
      outcome: "ok",
      report_path: null,
      vendor_session: null,
      verify: [],
    },
  ];
  await writeFile(
    join(state, "records.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const env: Record<string, string | undefined> = {
    ...fixture.env,
    AGX_STATE_DIR: state,
  };
  delete env.AGX_NEXT_STATE_DIR;
  const cli = new URL("../../src/next/cli.ts", import.meta.url).pathname;
  const accepted = await run(
    [process.execPath, cli, "judge", id, "accept"],
    fixture.source,
    env,
  );
  expect(accepted.code, accepted.err).toBe(0);

  const bookmark = `agx-worker-${createHash("sha256").update(id).digest("hex")}`;
  const imported = await run(
    ["jj", "log", "--no-graph", "-r", bookmark, "-T", "commit_id"],
    fixture.source,
    fixture.env,
  );
  expect(imported.code, imported.err).toBe(0);
  expect(imported.out.trim()).toBe(commit);
  const after = await run(
    ["jj", "log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"'],
    fixture.source,
    fixture.env,
  );
  expect(after.code, after.err).toBe(0);
  const newCommits = after.out
    .trim()
    .split("\n")
    .filter((id) => id !== "" && !previousCommits.has(id));
  expect(newCommits).toEqual([commit]);
  expect(await snapshot(fixture.remote)).toEqual(bareBefore);
  expect(await readFile(join(workspace, "worker.txt"), "utf8")).toBe(
    "accepted work\n",
  );
});

test("workspace contract: worker store (d) check refuses JJ verification with an external store", async () => {
  const fixture = await repoFixture();
  fixtures.push(fixture);
  const ticketPath = join(fixture.source, ".agents", "tickets", "jj-verify.md");
  await writeFile(
    ticketPath,
    `+++\nschema = 2\nname = "jj-verify"\nwrites = []\noutcome = "external store capability"\nsandbox = "workspace-write"\nverify = ["jj status"]\n[proposition]\nid = "WORKER-STORE-CAPABILITY"\nclaim = "workspace-write can provide a JJ store"\nrefuted_by = "external-vcs-store-write"\n+++\nCheck the worker store.\n`,
  );
  const workspace = join(fixture.source, "..", "project.ws", "ws_shared");
  await mkdir(join(fixture.source, "..", "project.ws"), { recursive: true });
  const made = await run(
    ["jj", "workspace", "add", "--name", "ws_shared", workspace],
    fixture.source,
    fixture.env,
  );
  expect(made.code, made.err).toBe(0);
  const cli = new URL("../../src/next/cli.ts", import.meta.url).pathname;
  const checked = await run(
    [process.execPath, cli, "check", ticketPath, "--cd", workspace],
    fixture.source,
    fixture.env,
  );
  expect(checked.code).not.toBe(0);
  expect(checked.err).toContain("capability=external-vcs-store-write");
  expect(checked.err).toContain("verify[0]: jj status");
});
