import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { routingBrief } from "../../src/next/route.ts";
import { parseNextTicket } from "../../src/next/ticket.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const TICKET = `+++
schema = 2
name = "agx-smoke"
outcome = "Produce the smoke result"
writes = ["agx-smoke.result.txt"]
verify = ["test -s agx-smoke.result.txt"]
[proposition]
id = "SMOKE-1"
claim = "The smoke result exists"
refuted_by = "the result file is empty or missing"
+++
Write the smoke result file.
`;

test("routingBrief puts prose first, then outcome, writes, verify and refuted_by under plain labels", () => {
  const parsed = parseNextTicket(TICKET);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const brief = routingBrief(parsed.ticket, parsed.prose);
  expect(brief.split("\n")).toEqual([
    "Proposition SMOKE-1: The smoke result exists",
    "Write the smoke result file.",
    "outcome: Produce the smoke result",
    'writes: ["agx-smoke.result.txt"]',
    'verify: ["test -s agx-smoke.result.txt"]',
    "refuted_by: the result file is empty or missing",
  ]);
});

test("routingBrief keeps an empty verify list visible rather than dropping the label", () => {
  const brief = routingBrief(
    {
      outcome: "o",
      writes: [],
      verify: [],
      proposition: { id: "P", claim: "c", refuted_by: "r" },
    },
    "prose\n",
  );
  expect(brief).toContain("\nverify: []\n");
});

test("agx worker check sends the ticket verify line to Jev in the task text", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-routing-brief-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mise"),
    '#!/usr/bin/env bun\nconsole.log("{}");\n',
    { mode: 0o755 },
  );
  const Request = z.looseObject({
    state: z.looseObject({ task: z.string() }),
    questions: z.looseObject({
      worker: z.looseObject({ criteria: z.record(z.string(), z.unknown()) }),
    }),
  });
  let task: string | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = jsonOf(Request).safeParse(await request.text());
      if (!body.success) return new Response("invalid request", { status: 400 });
      task = body.data.state.task;
      const choice = Object.keys(body.data.questions.worker.criteria)[0];
      return Response.json({ answers: { worker: { choice } } });
    },
  });
  try {
    const path = join(root, "agx-smoke.md");
    await writeFile(path, TICKET);
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tools/agx-worker/src/next/cli.ts"),
        "check",
        path,
        "--cd",
        root,
        "--json",
      ],
      {
        cwd: root,
        env: {
          ...subprocessEnvironment(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          AGX_NEXT_STATE_DIR: undefined,
          AGX_STATE_DIR: join(root, "state"),
          XDG_STATE_HOME: join(root, "xdg-state"),
          XDG_CONFIG_HOME: join(root, "config"),
          JEV_URL: `http://127.0.0.1:${server.port}/choice`,
          TYPESAFE_API_KEY: "fixture",
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      },
    );
    const exit = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exit, stderr).toBe(0);
    expect(task).toBeDefined();
    expect(task).toContain('verify: ["test -s agx-smoke.result.txt"]');
    expect(task).toContain('writes: ["agx-smoke.result.txt"]');
    expect(task).toContain("outcome: Produce the smoke result");
    expect(task).toContain("refuted_by: the result file is empty or missing");
  } finally {
    await server.stop(true);
  }
}, 60000);
