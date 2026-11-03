import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";
import { prepareTicketRepo } from "./ticket-repo.ts";

setDefaultTimeout(60000);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const Receipt = z.looseObject({ outcome: z.string(), id: z.string() });
const Round = z.object({
  round: z.number(),
  of: z.number(),
  earlier: z.array(z.object({ round: z.number(), exits: z.array(z.number()) })),
});
const Ended = z.looseObject({
  kind: z.literal("ended"),
  id: z.string(),
  verify: z.array(z.looseObject({ exit: z.number(), log_path: z.string() })),
  verify_round: Round.optional(),
});
const ListedRun = z.looseObject({
  id: z.string(),
  verify: z.array(z.looseObject({ exit: z.number() })),
  verify_round: Round.optional(),
});

async function exercise(second: "pass" | "fail") {
  const root = await mkdtemp(join(tmpdir(), "agx-verify-round-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const state = join(root, "state");
  // First verify fails (no `fixed`); the resumed worker fixes it on round 2.
  await writeFile(
    join(root, "worker.ts"),
    `import { writeFileSync } from "node:fs";
const resume = process.argv.slice(2).includes("--resume");
writeFileSync("changed.txt", "changed");
if (resume && process.env.SECOND_ROUND === "pass") writeFileSync("fixed", "yes");
process.stdout.write(JSON.stringify({report: {summary: "done", changes: [], checks: [], for_coordinator: [], open: []}, vendor_session: "test-session"}) + "\\n");
`,
  );
  const noticesPath = join(root, "notices.jsonl");
  const agx = join(root, "agx");
  await writeFile(
    agx,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.NOTICES_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("fake transport accepted\\n");
`,
  );
  await chmod(agx, 0o755);
  const ticket = join(root, "ticket.md");
  await writeFile(
    ticket,
    `+++\nschema = 2\nname = "round-visible"\ntimeout_s = 60\nwrites = ["changed.txt", "fixed"]\ncapabilities = ["long-tool-loop"]\noutcome = "round visible"\nverify = ["test -f fixed"]\n[proposition]\nid = "ROUND"\nclaim = "the round is named"\nrefuted_by = "a round-2 pass reads like round 1"\n+++\nWork.\n`,
  );
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        answers: {
          worker: { choice: "sol-medium", probabilities: { "sol-medium": 1 } },
        },
      }),
  });
  await using _server = {
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
    },
  };
  const env = {
    ...subprocessEnvironment(),
    PATH: `${root}:${process.env.PATH ?? ""}`,
    HOME: root,
    AGX_STATE_DIR: state,
    AGX_TMP_ROOT: join(root, "tmp"),
    AGX_CONFIG: new URL("../src/roster/policy.example.toml", import.meta.url)
      .pathname,
    JEV_URL: `http://127.0.0.1:${server.port}/`,
    TYPESAFE_API_KEY: "test-key",
    AGX_WORKER_BIN: join(root, "worker.ts"),
    AGX_WORKER_PATH_SOURCE: "dispatcher",
    AGX_DISPATCHER_SESSION: "claude:dispatcher-fixture",
    NOTICES_PATH: noticesPath,
    SECOND_ROUND: second,
  };
  const cli = ["tools/agx-worker/src/next/cli.ts"];
  const run = Bun.spawn(
    [
      process.execPath,
      ...cli,
      "run",
      ticket,
      "--cd",
      root,
      "--sandbox",
      "none",
    ],
    { env, stdout: "pipe", stderr: "pipe", timeout: 55000 },
  );
  const [exit, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  const receipt = jsonOf(Receipt).parse(stdout);
  const records = (await readFile(join(state, "records.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(Ended).safeParse(line);
      return parsed.success ? [parsed.data] : [];
    });
  const ended = records.findLast((record) => record.id === receipt.id);
  let message = "";
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline && message === "") {
    const text = await readFile(noticesPath, "utf8").catch(() => "");
    const line = text.trim().split("\n").at(0);
    if (line !== undefined && line !== "") {
      const argv = jsonOf(z.array(z.string())).parse(line);
      message = argv[argv.indexOf("--message") + 1] ?? "";
    } else await Bun.sleep(20);
  }
  const list = (args: string[]) =>
    Bun.spawnSync([process.execPath, ...cli, "ls", ...args], { env });
  const listJson = jsonOf(z.array(ListedRun)).parse(
    list([receipt.id, "--json"]).stdout.toString(),
  );
  const latest = list(["--ticket", "round-visible", "--latest", "--json"]);
  const latestHuman = list(["--ticket", "round-visible", "--latest"]);
  const runFiles = (await readdir(join(state, "runs", receipt.id))).toSorted();
  return {
    exit,
    stderr,
    receipt,
    ended,
    message,
    listJson,
    latest: latest.stdout.toString(),
    latestHuman: latestHuman.stdout.toString(),
    runFiles,
  };
}

test("a round-2 pass names its round and round 1's failure everywhere a consumer reads verify", async () => {
  const result = await exercise("pass");
  expect(result.exit, result.stderr).toBe(0);
  expect(result.receipt.outcome).toBe("ok");
  // Every round's logs follow one naming: verify-round-K-NN.log.
  const logs = result.runFiles.filter((name) => name.startsWith("verify"));
  expect(logs).toEqual(["verify-round-1-01.log", "verify-round-2-01.log"]);
  // The recorded verify field keeps its shape; the round is a new field.
  expect(result.ended?.verify.map((check) => check.exit)).toEqual([0]);
  expect(result.ended?.verify[0]?.log_path).toEndWith("verify-round-2-01.log");
  expect(result.ended?.verify_round).toEqual({
    round: 2,
    of: 2,
    earlier: [{ round: 1, exits: [1] }],
  });
  // End notice.
  expect(result.message).toContain("ended ok exit 0");
  expect(result.message).toContain("verify: round 2 of 2: 0 (round 1: 1)");
  // ls carries the round in JSON and in the human line.
  expect(result.listJson[0]?.verify.map((check) => check.exit)).toEqual([0]);
  expect(result.listJson[0]?.verify_round).toEqual({
    round: 2,
    of: 2,
    earlier: [{ round: 1, exits: [1] }],
  });
  expect(result.latest).toContain('"verify_exits":[0]');
  expect(result.latest).toContain('"verify_round":{"round":2,"of":2');
  expect(result.latestHuman).toContain("verify_exits=0 verify_round=2/2");
  expect(result.latestHuman).toContain("verify_round_1_exits=1");
});

test("persistent failure names round 3 and both earlier failures", async () => {
  const result = await exercise("fail");
  expect(result.receipt.outcome).toBe("verify-failed");
  expect(result.runFiles.filter((name) => name.startsWith("verify"))).toEqual([
    "verify-round-1-01.log",
    "verify-round-2-01.log",
    "verify-round-3-01.log",
  ]);
  expect(result.ended?.verify_round).toEqual({
    round: 3,
    of: 3,
    earlier: [
      { round: 1, exits: [1] },
      { round: 2, exits: [1] },
    ],
  });
  expect(result.message).toContain(
    "verify: round 3 of 3: 1 (round 1: 1; round 2: 1)",
  );
});
