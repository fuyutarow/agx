import { prepareTicketRepo } from "../ticket-repo.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { createTempTracker } from "../temp.ts";

const tempDirs = createTempTracker();
afterAll(tempDirs.assertRemoved);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const ticketText = (prose: string): string =>
  `+++\nschema = 2\nname = "pin"\nwrites = []\noutcome = "continue pinned"\nverify = []\n[proposition]\nid = "PIN"\nclaim = "continue pins the row"\nrefuted_by = "continue routes"\n+++\n${prose}\n`;

// Seeds one ended run per prior row; the Jev endpoint is a closed port, so a continue that
// routed would fall back to the roster default (luna-high) instead of the pinned row.
const fixture = async (ticketName = "pin") => {
  const root = tempDirs.register(
    mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-continue-`)),
  );
  roots.push(root);
  await prepareTicketRepo(root);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const seed = (id: string, row: string, session: string | null) => [
    {
      kind: "started",
      id,
      at: "2026-10-14T01:00:00.000Z",
      ticket: ticketName,
      writes: [],
      cwd: root,
      workspace: root,
      row,
      dispatcher_session: null,
      vendor_session: null,
      pid: 0,
    },
    {
      kind: "ended",
      id,
      at: "2026-10-14T01:10:00.000Z",
      exit: 0,
      report_path: null,
      vendor_session: session,
      verify: [],
    },
  ];
  const records = [
    ...seed("codex-run", "terra-high", "codex-thread-1"),
    ...seed("claude-run", "sonnet-high", "claude-session-1"),
    ...seed("bare-run", "terra-high", null),
    ...seed("ghost-run", "no-such-row", "ghost-session"),
  ];
  writeFileSync(
    join(state, "records.jsonl"),
    `${records.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const worker = join(root, "fake-worker.ts");
  writeFileSync(
    worker,
    `const i = process.argv.indexOf("--resume");\nprocess.stdout.write(JSON.stringify({ exit: 0, report: { summary: "ok", changes: [], checks: [], for_coordinator: [], open: [] }, vendor_session: "next-" + process.argv[i + 1] }) + "\\n");\n`,
  );
  const ticket = join(root, "ticket.md");
  writeFileSync(
    ticket,
    ticketText("first prose").replace('name = "pin"', `name = "${ticketName}"`),
  );
  const resume = (
    id: string | undefined,
    overrides: NodeJS.ProcessEnv = {},
    entry = "tools/agx-worker/src/next/cli.ts",
    compiled = false,
    sandboxArgs: string[] = ["--sandbox", "read-only"],
  ) =>
    Bun.spawnSync(
      [
        ...(compiled ? [entry] : [process.execPath, entry]),
        "run",
        ticket,
        "--cd",
        root,
        ...sandboxArgs,
        ...(id === undefined ? [] : ["--continue", id]),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGX_STATE_DIR: state,
          AGX_TMP_ROOT: join(root, "agx-tmp"),
          JEV_URL: "http://127.0.0.1:1/choice",
          AGX_WORKER_BIN: worker,
          TYPESAFE_API_KEY: "test-key",
          AGX_CONFIG: new URL(
            "../../src/roster/policy.example.toml",
            import.meta.url,
          ).pathname,
          AGX_DISPATCHER_SESSION: "dispatcher",
          ...overrides,
        },
        timeout: 10_000,
      },
    );
  const events = () =>
    readFileSync(join(state, "records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => {
        const decoded = jsonOf(z.looseObject({ kind: z.string() })).safeParse(
          line,
        );
        if (!decoded.success) return [];
        const event = z
          .looseObject({ kind: z.string() })
          .safeParse(decoded.data);
        return event.success ? [event.data] : [];
      });
  return { root, state, ticket, resume, events };
};

test.each([false, true])(
  "sandbox precedence and receipts agree without adjacent source (compiled=%s)",
  async (compiled) => {
    const f = await fixture();
    let entry = new URL("../../src/next/cli.ts", import.meta.url).pathname;
    if (compiled) {
      const executable = join(f.root, "installed", "agx-worker");
      mkdirSync(join(f.root, "installed"));
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          entry,
          "--outfile",
          executable,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      entry = executable;
    }
    // Production-era events had no sandbox: recover it from the native receipt.
    mkdirSync(join(f.state, "runs", "codex-run"), { recursive: true });
    writeFileSync(
      join(f.state, "runs", "codex-run", "codex-run.json"),
      JSON.stringify({
        sandbox: "none",
        sandbox_effective: "danger-full-access",
      }),
    );
    const schema = jsonOf(
      z.looseObject({
        id: z.string(),
        sandbox: z.string(),
        sandbox_source: z.string(),
        report_path: z.string(),
      }),
    );
    const cases = [
      {
        prior: "codex-run",
        ticket: undefined,
        args: [],
        mode: "none",
        source: "continued run",
      },
      {
        prior: "codex-run",
        ticket: undefined,
        args: ["--sandbox", "workspace-write"],
        mode: "workspace-write",
        source: "flag",
      },
      {
        prior: "codex-run",
        ticket: "read-only",
        args: [],
        mode: "read-only",
        source: "ticket",
      },
      {
        prior: "codex-run",
        ticket: "none",
        args: ["--sandbox", "workspace-write"],
        mode: "workspace-write",
        source: "flag",
      },
      {
        prior: "codex-run",
        ticket: undefined,
        args: [
          "--sandbox",
          "none",
          "--sandbox-source",
          "continued run",
          "--dispatch-binding",
          JSON.stringify({
            id: "89fdece7-a42d-4f69-a28d-9f15efad5426",
            ticket: "pin",
            workspace: f.root,
            unit: "agt_pin",
          }),
        ],
        mode: "none",
        source: "continued run",
      },
      {
        prior: undefined,
        ticket: undefined,
        args: [],
        mode: "workspace-write",
        source: "built-in default",
      },
      {
        prior: "claude-run",
        ticket: undefined,
        args: [],
        mode: "workspace-write",
        source: "built-in default",
      },
    ];
    let inheritedId: string | undefined;
    for (const item of cases) {
      writeFileSync(
        f.ticket,
        ticketText("sandbox precedence").replace(
          "schema = 2",
          `schema = 2${item.ticket === undefined ? "" : `\nsandbox = "${item.ticket}"`}`,
        ),
      );
      const result = f.resume(item.prior, {}, entry, compiled, item.args);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const parsedReceipt = schema.safeParse(result.stdout.toString().trim());
      expect(parsedReceipt.success).toBe(true);
      if (!parsedReceipt.success) return;
      const receipt = parsedReceipt.data;
      expect([receipt.sandbox, receipt.sandbox_source]).toEqual([
        item.mode,
        item.source,
      ]);
      expect(
        readFileSync(join(f.state, "runs", receipt.id, "brief.md"), "utf8"),
      ).toContain(`Sandbox mode: ${item.mode}`);
      // All saved receipts and the report expose the same requested sandbox provenance.
      for (const path of [
        join(f.state, "runs", receipt.id, `${receipt.id}.json`),
        receipt.report_path,
      ]) {
        const saved = jsonOf(
          z.looseObject({ sandbox: z.string(), sandbox_source: z.string() }),
        ).safeParse(readFileSync(path, "utf8"));
        expect(saved.success).toBe(true);
        expect(saved.data).toMatchObject({
          sandbox: item.mode,
          sandbox_source: item.source,
        });
      }
      expect(
        f
          .events()
          .find((event) => event.id === receipt.id && event.kind === "started"),
      ).toMatchObject({ sandbox: item.mode, sandbox_source: item.source });
      if (item.source === "continued run") inheritedId = receipt.id;
    }
    // A newly recorded run can be continued from its started event without its receipt.
    expect(inheritedId).toBeDefined();
    rmSync(join(f.state, "runs", inheritedId!, `${inheritedId}.json`));
    const chained = f.resume(inheritedId, {}, entry, compiled, []);
    expect(chained.exitCode, chained.stderr.toString()).toBe(0);
    const parsedChain = schema.safeParse(chained.stdout.toString().trim());
    expect(parsedChain.success).toBe(true);
    expect(parsedChain.data).toMatchObject({
      sandbox: "none",
      sandbox_source: "continued run",
    });
  },
  60_000,
);

const Started = z.looseObject({
  kind: z.literal("started"),
  id: z.string(),
  row: z.string(),
  vendor_session: z.string().nullable(),
  continues: z.string().nullable(),
});
const Receipt = z.looseObject({ id: z.string(), row: z.string() });

describe("agx worker run --continue pins the prior row", () => {
  test.each(["design_g5", "Design-G5"])(
    "legacy ticket %s resumes on its pinned row",
    async (name) => {
      const f = await fixture(name);
      const result = f.resume("codex-run");
      expect(result.exitCode).toBe(0);
      const receiptResult = jsonOf(Receipt).safeParse(
        result.stdout.toString().trim(),
      );
      expect(receiptResult.success).toBe(true);
      if (!receiptResult.success) return;
      const receipt = receiptResult.data;
      expect(receipt.row).toBe("terra-high");
      const started = f
        .events()
        .map((event) => Started.safeParse(event))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
        .find((event) => event.id === receipt.id);
      expect(started?.row).toBe("terra-high");
      expect(started?.vendor_session).toBe("codex-thread-1");
      expect(started?.continues).toBe("codex-run");
    },
    30000,
  );

  test("a unique run id prefix resolves to the full prior id", async () => {
    const f = await fixture();
    const result = f.resume("codex-");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const receipt = jsonOf(Receipt).safeParse(result.stdout.toString().trim());
    expect(receipt.success).toBe(true);
    if (!receipt.success) return;
    expect(
      f
        .events()
        .find(
          (event) => event.kind === "started" && event.id === receipt.data.id,
        ),
    ).toMatchObject({ continues: "codex-run" });
  }, 30000);

  test("ambiguous and unknown run id prefixes refuse on one line with candidates", async () => {
    const f = await fixture();
    const original = f.events();
    const extra = [
      { ...original[0], id: "codex-run-extra" },
      {
        kind: "ended",
        id: "codex-run-extra",
        at: "2026-10-14T01:10:00.000Z",
        exit: 0,
        report_path: null,
        vendor_session: "extra-session",
        verify: [],
      },
    ];
    writeFileSync(
      join(f.state, "records.jsonl"),
      `${[...original, ...extra].map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    for (const [selector, candidates] of [
      ["codex-r", ["codex-run", "codex-run-extra"]],
      [
        "absent",
        ["bare-run", "claude-run", "codex-run", "codex-run-extra", "ghost-run"],
      ],
    ] as const) {
      const before = f.events().length;
      const result = f.resume(selector);
      expect(result.exitCode).toBe(2);
      const lines = result.stderr.toString().trim().split("\n");
      expect(lines).toHaveLength(1);
      for (const candidate of candidates) expect(lines[0]).toContain(candidate);
      expect(f.events()).toHaveLength(before);
    }
  });

  test("a claude run resumes its claude session on its claude row", async () => {
    const f = await fixture();
    const result = f.resume("claude-run");
    expect(result.exitCode).toBe(0);
    const receiptResult = jsonOf(Receipt).safeParse(
      result.stdout.toString().trim(),
    );
    expect(receiptResult.success).toBe(true);
    if (!receiptResult.success) return;
    const receipt = receiptResult.data;
    expect(receipt.row).toBe("sonnet-high");
    const ended = f
      .events()
      .find((event) => event.kind === "ended" && event.id === receipt.id);
    expect(ended?.vendor_session).toBe("next-claude-session-1");
  }, 30000);

  test("a run without a vendor session exits 2 before any worker starts", async () => {
    const f = await fixture();
    const before = f.events().length;
    const result = f.resume("bare-run");
    expect(result.exitCode).toBe(2);
    const lines = result.stderr.toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bare-run");
    expect(lines[0]).toContain("agx worker run");
    expect(f.events()).toHaveLength(before);
    expect(existsSync(join(f.state, "runs"))).toBe(false);
  });

  test("a run whose row left the roster exits 2 before any worker starts", async () => {
    const f = await fixture();
    const before = f.events().length;
    const result = f.resume("ghost-run");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
    expect(f.events()).toHaveLength(before);
  });

  test("the ticket file is re-read on continue", async () => {
    const f = await fixture();
    writeFileSync(f.ticket, ticketText("amended prose"));
    const result = f.resume("codex-run");
    expect(result.exitCode).toBe(0);
    const receiptResult = jsonOf(Receipt).safeParse(
      result.stdout.toString().trim(),
    );
    expect(receiptResult.success).toBe(true);
    if (!receiptResult.success) return;
    const receipt = receiptResult.data;
    const brief = readFileSync(
      join(f.state, "runs", receipt.id, "brief.md"),
      "utf8",
    );
    expect(brief).toContain("amended prose");
    expect(brief).not.toContain("first prose");
  }, 30000);
});

test.each([false, true])(
  "dispatched run (compiled=%s) re-enters itself and verification finds xmsg on dispatcher PATH",
  async (compiled) => {
    const f = await fixture();
    const bin = join(f.root, "mise", "bin");
    mkdirSync(bin, { recursive: true });
    const xmsg = join(bin, "xmsg");
    await Bun.write(xmsg, "#!/bin/sh\nprintf 'dispatcher xmsg\\n'\n");
    const { chmodSync } = await import("node:fs");
    chmodSync(xmsg, 0o755);
    const mise = join(bin, "mise");
    await Bun.write(
      mise,
      "#!/bin/sh\necho 'unexpected mise environment resolution' >&2\nexit 1\n",
    );
    chmodSync(mise, 0o755);
    // Any accidental bare-name worker lookup fails instead of using the running entry.
    const otherWorker = join(bin, "agx-worker");
    await Bun.write(otherWorker, "#!/bin/sh\nexit 99\n");
    chmodSync(otherWorker, 0o755);
    const entry = join(f.root, "running-worker.ts");
    await Bun.write(
      entry,
      `
if (process.argv[2] === "--internal-codex") {
  process.stdout.write(JSON.stringify({ exit: 0, report: { summary: "self worker", changes: [], checks: [], for_coordinator: [], open: [] } }) + "\\n");
} else {
  const { run } = await import(${JSON.stringify(new URL("../../src/next/run.ts", import.meta.url).pathname)});
  const { flushRunPublications } = await import(${JSON.stringify(new URL("../../src/next/store.ts", import.meta.url).pathname)});
  process.exitCode = await run({ ticket: process.argv[3], cd: ${JSON.stringify(f.root)}, sandbox: "read-only", continue: "codex-run" });
  await flushRunPublications();
}
`,
    );
    writeFileSync(
      f.ticket,
      ticketText("test dispatcher lookup").replace(
        "verify = []",
        'verify = ["xmsg"]',
      ),
    );
    let executable = entry;
    if (compiled) {
      executable = join(f.root, "compiled-worker");
      const built = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          entry,
          "--outfile",
          executable,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      expect(built.exitCode, built.stderr.toString()).toBe(0);
    }
    const path = `${bin}:${process.env.PATH}`;
    const result = f.resume(
      "codex-run",
      {
        AGX_WORKER_BIN: undefined,
        AGX_WORKER_COMMAND: undefined,
        AGX_WORKER_PATH_SOURCE: "dispatcher",
        PATH: path,
      },
      executable,
      compiled,
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const receiptResult = jsonOf(
      z.looseObject({
        report_path: z.string(),
        execution: z.object({
          executable_path: z.string(),
          executable_argv: z.array(z.string()),
          path_source: z.string(),
        }),
      }),
    ).safeParse(result.stdout.toString().trim());
    expect(receiptResult.success).toBe(true);
    if (!receiptResult.success) return;
    const receipt = receiptResult.data;
    expect(receipt.execution).toEqual({
      executable_path: compiled ? executable : process.execPath,
      executable_argv: compiled ? [executable] : [process.execPath, entry],
      path_source: "PATH from dispatcher",
    });
    const report = jsonOf(z.looseObject({ execution: z.unknown() })).safeParse(
      await Bun.file(receipt.report_path).text(),
    );
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.data.execution).toEqual(receipt.execution);
    const ended = jsonOf(
      z.looseObject({
        kind: z.string(),
        verify: z
          .array(z.looseObject({ exit: z.number(), log_path: z.string() }))
          .optional(),
      }),
    );
    const results = readFileSync(join(f.state, "records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => {
        const parsed = ended.safeParse(line);
        return parsed.success ? [parsed.data] : [];
      });
    const verification = results.findLast((event) => event.kind === "ended")
      ?.verify?.[0];
    expect(verification?.exit).toBe(0);
    expect(await Bun.file(verification!.log_path).text()).toContain(
      "dispatcher xmsg",
    );
  },
);
