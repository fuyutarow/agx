import { prepareTicketRepo } from "../ticket-repo.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { createTempTracker } from "../temp.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const tempDirs = createTempTracker();
const roots: string[] = [];
const removeRoots = () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
};
afterEach(removeRoots);
afterAll(() => {
  removeRoots();
  tempDirs.assertRemoved();
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
  // The worker removes each run directory but intentionally leaves its configured root.
  tempDirs.register(join(root, "agx-tmp"));
  await prepareTicketRepo(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "mise"), '#!/usr/bin/env bun\nconsole.log("{}");\n');
  chmodSync(join(bin, "mise"), 0o755);
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
  const writeOriginal = (id = "codex-run") => {
    mkdirSync(join(state, "runs", id), { recursive: true });
    writeFileSync(
      join(state, "runs", id, "ticket.orig.md"),
      ticketText("first prose").replace(
        'name = "pin"',
        `name = "${ticketName}"`,
      ),
    );
  };
  const resume = (
    id: string | undefined,
    overrides: NodeJS.ProcessEnv = {},
    entry = "tools/agx-worker/src/next/cli.ts",
    compiled = false,
    sandboxArgs: string[] = ["--sandbox", "read-only"],
    command = "run",
  ) =>
    Bun.spawnSync(
      [
        ...(compiled ? [entry] : [process.execPath]),
        ...(overrides.AGX_TEST_PRELOAD === undefined
          ? []
          : ["--preload", overrides.AGX_TEST_PRELOAD]),
        ...(compiled ? [] : [entry]),
        command,
        ticket,
        ...(command === "run" ? ["--cd", root] : []),
        ...sandboxArgs,
        ...(id === undefined ? [] : ["--continue", id]),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...subprocessEnvironment(),
          PATH: `${bin}:${process.env.PATH}`,
          AGX_STATE_DIR: state,
          MISE_GLOBAL_CONFIG_FILE: join(root, "mise-config.toml"),
          XDG_CONFIG_HOME: join(root, "config"),
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
  return { root, state, ticket, resume, events, writeOriginal };
};

test.each(["check", "run"])(
  "dispatch contract: rule 3 %s refuses before writing any state",
  async (command) => {
    const f = await fixture();
    const records = ["timeout-first", "timeout-second"].flatMap((id, index) => [
      {
        kind: "started",
        id,
        at: "2026-10-14T01:00:00Z",
        ticket: "pin",
        writes: [],
        cwd: f.root,
        workspace: f.root,
        row: "terra-high",
        dispatcher_session: null,
        vendor_session: "vendor-session",
        continues: index === 0 ? null : "timeout-first",
        pid: 0,
      },
      {
        kind: "ended",
        id,
        at: "2026-10-14T01:10:00Z",
        exit: 3,
        outcome: "timeout",
        report_path: null,
        vendor_session: "vendor-session",
        verify: [],
      },
    ]);
    writeFileSync(
      join(f.state, "records.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const before = readFileSync(join(f.state, "records.jsonl"), "utf8");
    const paths = () =>
      [
        ...new Bun.Glob("**/*").scanSync({
          cwd: f.root,
          dot: true,
          onlyFiles: false,
        }),
      ].toSorted();
    const beforePaths = paths();
    const refused = f.resume("timeout-sec", {}, undefined, false, [], command);
    expect(refused.exitCode, refused.stderr.toString()).toBe(2);
    expect(refused.stdout.toString()).toBe("");
    expect(refused.stderr.toString()).toBe(
      "agx: time-box-lineage: runs timeout-second, timeout-first timed out in one continuation lineage; repair: raise timeout_s above the last timed-out run and add a 'Time box raised:' line, or list split-off tickets on a 'Split into:' line\n",
    );
    expect(readFileSync(join(f.state, "records.jsonl"), "utf8")).toBe(before);
    expect(paths()).toEqual(beforePaths);
  },
);

test.each([false, true])(
  "dispatch contract: rule 2 (ticket amended=%s)",
  async (amended) => {
    const f = await fixture();
    const original = readFileSync(f.ticket);
    const priorDir = join(f.state, "runs", "codex-run");
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "ticket.orig.md"), original);
    writeFileSync(
      join(priorDir, "ticket.orig.md.sha256"),
      `${createHash("sha256").update(original).digest("hex")}  ticket.orig.md\n`,
    );
    writeFileSync(
      join(f.state, "records.jsonl"),
      `${f
        .events()
        .map((event) =>
          JSON.stringify(
            event.id === "codex-run" && event.kind === "ended"
              ? { ...event, exit: 3, outcome: "timeout" }
              : event,
          ),
        )
        .join("\n")}\n`,
    );
    const marker = join(f.root, "service-called");
    for (const [name, body] of [
      ["systemctl", "process.exitCode = 3;"],
      [
        "systemd-run",
        `
const args = process.argv.slice(2);
const binding = JSON.parse(args[args.indexOf("--dispatch-binding") + 1]);
const started = { kind: "started", ...binding, at: "2026-10-25T00:00:00Z", cwd: binding.workspace, writes: [], row: "terra-high", dispatcher_session: null, vendor_session: "continued", pid: 0, continues: "codex-run" };
const ended = { kind: "ended", id: binding.id, at: "2026-10-25T00:01:00Z", exit: 0, report_path: null, vendor_session: "continued", verify: [] };
const { appendFileSync } = await import("node:fs");
appendFileSync(${JSON.stringify(join(f.state, "records.jsonl"))}, JSON.stringify(started) + "\\n" + JSON.stringify(ended) + "\\n");
`,
      ],
    ]) {
      const path = join(f.root, "bin", name!);
      writeFileSync(
        path,
        `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "called");\n${body}\n`,
      );
      chmodSync(path, 0o755);
    }
    if (amended) writeFileSync(f.ticket, ticketText("amended time box plan"));
    const snapshot = () =>
      readdirSync(f.root, { recursive: true, encoding: "utf8" })
        .toSorted((left, right) => left.localeCompare(right))
        .map((path) => [
          path,
          lstatSync(join(f.root, path)).isFile()
            ? readFileSync(join(f.root, path)).toString("base64")
            : null,
        ]);
    const before = snapshot();
    const result = f.resume(
      "codex-",
      {},
      undefined,
      false,
      ["--sandbox", "none"],
      "dispatch",
    );
    if (amended) {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(
        f.events().filter((event) => event.kind === "started"),
      ).toHaveLength(5);
    } else {
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe(
        "agx: cannot continue run codex-run: time-box-unchanged: previous run ended by timeout and ticket sha256 is unchanged; repair: edit the ticket before continuing; check=launch-premises expected=satisfied observed=refused\n",
      );
      expect(snapshot()).toEqual(before);
      // The shared check and direct run must also refuse without recording a refusal.
      for (const command of ["check", "run"]) {
        const checked = f.resume(
          "codex-run",
          {},
          undefined,
          false,
          ["--sandbox", "none"],
          command,
        );
        expect(checked.exitCode, checked.stderr.toString()).toBe(2);
        expect(checked.stderr.toString()).toBe(result.stderr.toString());
        expect(snapshot()).toEqual(before);
      }
    }
  },
  30_000,
);

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
    if (inheritedId === undefined)
      expect.unreachable("continued run ID was not recorded");
    rmSync(join(f.state, "runs", inheritedId, `${inheritedId}.json`));
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

test("dispatch immediately after a ticket edit agrees on both attempts", async () => {
  const f = await fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin, { recursive: true });
  // Mock only the service boundary; dispatch and its child check are real.
  for (const [name, body] of [
    ["systemctl", "process.exitCode = 3;"],
    [
      "systemd-run",
      `
const args = process.argv.slice(2);
const binding = JSON.parse(args[args.indexOf("--dispatch-binding") + 1]);
const { appendFileSync } = await import("node:fs");
const started = { kind: "started", ...binding, at: "2026-10-25T00:00:00Z", cwd: binding.workspace, writes: [], row: "terra-high", dispatcher_session: null, vendor_session: "continued", pid: 0 };
const ended = { kind: "ended", id: binding.id, at: "2026-10-25T00:01:00Z", exit: 0, report_path: null, vendor_session: "continued", verify: [] };
appendFileSync(${JSON.stringify(join(f.state, "records.jsonl"))}, JSON.stringify(started) + "\\n" + JSON.stringify(ended) + "\\n");
`,
    ],
  ]) {
    const path = join(bin, name!);
    writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const env = { PATH: `${bin}:${process.env.PATH}` };
  for (const missing of [false, true]) {
    writeFileSync(
      f.ticket,
      ticketText("edited immediately before dispatch").replace(
        "verify = []",
        `verify = []\npremises = ["file:${missing ? "missing" : "agx.toml"}"]`,
      ),
    );
    const results = Array.from({ length: 2 }, () =>
      f.resume(
        "codex-run",
        env,
        undefined,
        false,
        ["--sandbox", "none"],
        "dispatch",
      ),
    );
    expect(
      results.map((result) => result.exitCode),
      results.map((result) => result.stderr.toString()).join("\n"),
    ).toEqual(missing ? [2, 2] : [0, 0]);
    for (const result of missing ? results : []) {
      const err = result.stderr.toString().trim();
      expect(err.split("\n")).toHaveLength(1);
      expect(err).toContain("file:missing: file does not exist");
      expect(err).toContain("check=worker-check expected=0 observed=2");
    }
    if (missing) {
      expect(results[0]!.stderr.toString()).toBe(results[1]!.stderr.toString());
    }
  }
}, 30000);

describe("agx worker run --continue pins the prior row", () => {
  test.each(["design_g5", "Design-G5"])(
    "legacy ticket %s resumes on its pinned row",
    async (name) => {
      const f = await fixture(name);
      f.writeOriginal();
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
    f.writeOriginal();
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
      expect(f.events()).toHaveLength(before + 1);
      expect(f.events().at(-1)?.kind).toBe("refusal");
    }
  });

  test("a row without a published duration starts fresh on an eligible route", async () => {
    const f = await fixture();
    f.writeOriginal("claude-run");
    const result = f.resume("claude-run");
    expect(result.exitCode).toBe(0);
    const receiptResult = jsonOf(Receipt).safeParse(
      result.stdout.toString().trim(),
    );
    expect(receiptResult.success).toBe(true);
    if (!receiptResult.success) return;
    const receipt = receiptResult.data;
    expect(receipt.row).not.toBe("sonnet-high");
    const ended = f
      .events()
      .find((event) => event.kind === "ended" && event.id === receipt.id);
    expect(ended?.vendor_session).not.toBe("next-claude-session-1");
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
    expect(f.events()).toHaveLength(before + 1);
    expect(f.events().at(-1)?.kind).toBe("refusal");
    expect(existsSync(join(f.state, "runs"))).toBe(false);
  });

  test("continue contract: a continuation never stays on a row outside the time box", async () => {
    const f = await fixture();
    writeFileSync(
      f.ticket,
      ticketText("first prose").replace(
        "verify = []",
        "verify = []\ntimeout_s = 600",
      ),
    );
    const catalog = join(f.root, "catalog.toml");
    writeFileSync(
      catalog,
      `schema = 1\nas_of = "2026-10-29"\n[jev]\n[sources]\n[[choice]]\nid = "luna-max"\nroute = "codex"\nmodel = "gpt-6-luna"\neffort = "max"\naa_time_per_task_s = 597\ntb4 = 50\nprice_in = 0.1\nprice_out = 0.1\n[[choice]]\nid = "luna-low"\nroute = "codex"\nmodel = "gpt-6-luna"\neffort = "low"\naa_time_per_task_s = 200\ntb4 = 5\nprice_in = 0.1\nprice_out = 0.1\n[[choice]]\nid = "terra-high"\nroute = "codex"\nmodel = "gpt-6.1-terra"\neffort = "high"\naa_time_per_task_s = 180\ntb4 = 45\nprice_in = 1\nprice_out = 1\n`,
    );
    const policy = join(f.root, "policy.toml");
    writeFileSync(
      policy,
      `schema = 1\n[route]\nallow = ["codex"]\ndefault = "terra-high"\nexclude = []\nmax_task_chars = 6000\ntimeout_ms = 20000\nno_egress = []\npick_temperature = 0.5\n[route.jev]\napi = "typesafe"\nurl = "http://127.0.0.1:1/choice"\nmodel = "test"\n[claude_run]\nmax_budget_usd = 2\nmax_turns = 60\nreason = "A fixed test policy for a bounded worker run."\n`,
    );
    const rosterModule = new URL("../../src/roster/index.ts", import.meta.url)
      .pathname;
    const jevModule = new URL(
      "../../../shared/src/jev-client.ts",
      import.meta.url,
    ).pathname;
    const usageModule = new URL("../../src/next/usage.ts", import.meta.url)
      .pathname;
    const entry = join(f.root, "fixture-cli.ts");
    writeFileSync(
      entry,
      `import { mock } from "bun:test";\nconst roster = await import(${JSON.stringify(rosterModule)});\nconst loadRoster = roster.loadRoster;\nmock.module(${JSON.stringify(rosterModule)}, () => ({ ...roster, loadRoster: (options = {}) => loadRoster({ ...options, catalogPath: ${JSON.stringify(catalog)} }) }));\nconst jev = await import(${JSON.stringify(jevModule)});\nmock.module(${JSON.stringify(jevModule)}, () => ({ ...jev, postJev: async () => ({ ok: true, status: 200, text: JSON.stringify({ answers: { worker: { choice: "cross_module" } } }), trace: { endpoint: "fixture", request: null, latency_ms: 0 } }) }));\nconst usage = await import(${JSON.stringify(usageModule)});\nconst available = { available: true, exhausted: false, usage_status: "unknown", preference: "neutral", windows: {} };\nmock.module(${JSON.stringify(usageModule)}, () => ({ ...usage, readRouteUsage: async () => ({ codex: available, claude: available }) }));\n`,
    );
    const env = {
      AGX_CONFIG: policy,
      AGX_TEST_PRELOAD: entry,
      AGX_NEXT_JEV_URL: undefined,
      JEX_JEV_URL: undefined,
      JEV_URL: "http://127.0.0.1:1/choice",
    };
    writeFileSync(
      join(f.state, "records.jsonl"),
      `${f
        .events()
        .map((event) =>
          JSON.stringify(
            event.kind === "started" && event.id === "codex-run"
              ? Object.assign(event, {
                  row: "luna-max",
                  route: "codex",
                  model: "gpt-6-luna",
                  effort: "max",
                })
              : event,
          ),
        )
        .join("\n")}\n`,
    );
    const checked = f.resume("codex-run", env, undefined, false, [], "check");
    expect(checked.exitCode, checked.stderr.toString()).toBe(0);
    expect(checked.stdout.toString()).toContain("row=luna-max -> terra-high");
    const continued = f.resume("codex-run", env);
    expect(continued.exitCode, continued.stderr.toString()).toBe(0);
    expect(continued.stderr.toString()).toContain(
      "row luna-max is outside the 600 s time box; continuing codex-run on ",
    );
    const receipt = jsonOf(Receipt).safeParse(
      continued.stdout.toString().trim(),
    );
    expect(receipt.success).toBe(true);
    if (!receipt.success) return;
    expect(receipt.data.row).toBe("terra-high");
    expect(
      f
        .events()
        .find(
          (event) => event.kind === "started" && event.id === receipt.data.id,
        ),
    ).toMatchObject({ vendor_session: "codex-thread-1" });
  });

  test("continue contract: a run whose row was retired", async () => {
    const f = await fixture();
    writeFileSync(
      join(f.state, "records.jsonl"),
      `${f
        .events()
        .map((event) =>
          event.kind === "started" && event.id === "codex-run"
            ? Object.assign(event, {
                route: "codex",
                model: "gpt-6.1-terra",
                effort: "high",
              })
            : event,
        )
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    const policy = join(f.root, "retired-policy.toml");
    writeFileSync(
      policy,
      readFileSync(
        new URL("../../src/roster/policy.example.toml", import.meta.url),
        "utf8",
      ).replace("exclude = []", 'exclude = ["terra-high"]'),
    );
    const checked = f.resume(
      "codex-run",
      { AGX_CONFIG: policy },
      undefined,
      false,
      [],
      "check",
    );
    expect(checked.exitCode, checked.stderr.toString()).toBe(0);
    expect(checked.stdout.toString()).toContain(
      `CONTINUE run=codex-run row=terra-high -> luna-high workspace=${f.root}`,
    );
    const continued = f.resume("codex-run", { AGX_CONFIG: policy });
    expect(continued.exitCode, continued.stderr.toString()).toBe(0);
    const receipt = jsonOf(
      Receipt.extend({
        continued_from_row: z.string(),
        workspace: z.string(),
      }),
    ).safeParse(continued.stdout.toString().trim());
    expect(receipt.success).toBe(true);
    if (!receipt.success) return;
    expect(receipt.data).toMatchObject({
      row: "luna-high",
      continued_from_row: "terra-high",
      workspace: f.root,
    });
    expect(
      f
        .events()
        .find(
          (event) => event.kind === "started" && event.id === receipt.data.id,
        ),
    ).toMatchObject({
      row: "luna-high",
      continued_from_row: "terra-high",
      workspace: f.root,
      continues: "codex-run",
      supersedes: null,
    });
  });

  test("continue contract: a run whose workspace is gone is still refused", async () => {
    const f = await fixture();
    const events = f.events().map((event) =>
      event.kind === "started" && event.id === "codex-run"
        ? Object.assign(event, {
            workspace: join(f.root, "missing-workspace"),
          })
        : event,
    );
    writeFileSync(
      join(f.state, "records.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const result = f.resume("codex-run", {}, undefined, false, [], "check");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("workspace");
    expect(result.stderr.toString()).toContain("no longer exists");
  });



  test("the ticket file is re-read on continue", async () => {
    const f = await fixture();
    f.writeOriginal();
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
    expect(brief).toContain("-first prose");
    expect(brief.slice(brief.indexOf("Proposition"))).toContain(
      "amended prose",
    );
  }, 30000);

  test("the continuation prompt starts with the prior judgment and ticket diff", async () => {
    const f = await fixture();
    f.writeOriginal();
    writeFileSync(f.ticket, ticketText("coordinator correction"));
    const events = f.events();
    writeFileSync(
      join(f.state, "records.jsonl"),
      `${[...events, { kind: "judged", id: "codex-run", at: "2026-10-14T01:11:00.000Z", decision: "reject", note: "Fix the Jev evidence before continuing." }].map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const result = f.resume("codex-run");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const receipt = jsonOf(Receipt).safeParse(result.stdout.toString().trim());
    expect(receipt.success).toBe(true);
    if (!receipt.success) return;
    const prompt = readFileSync(
      join(f.state, "runs", receipt.data.id, "brief.md"),
      "utf8",
    );
    expect(prompt.startsWith("Continuation correction:")).toBe(true);
    expect(prompt).toContain(
      "Prior judgment: reject: Fix the Jev evidence before continuing.",
    );
    expect(prompt).toContain("--- ticket.orig.md");
    expect(prompt).toContain("+++ current ticket");
    expect(prompt).toContain("-first prose");
    expect(prompt).toContain("+coordinator correction");
    expect(prompt).toContain(
      "The prior judgment note and current ticket override the earlier brief.",
    );
  }, 30000);

  test("the continuation prompt says when no judgment was recorded", async () => {
    const f = await fixture();
    f.writeOriginal();
    const result = f.resume("codex-run");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const receipt = jsonOf(Receipt).safeParse(result.stdout.toString().trim());
    expect(receipt.success).toBe(true);
    if (!receipt.success) return;
    const prompt = readFileSync(
      join(f.state, "runs", receipt.data.id, "brief.md"),
      "utf8",
    );
    expect(prompt.startsWith("Continuation correction:")).toBe(true);
    expect(prompt).toContain("Prior judgment: None was recorded.");
    expect(prompt).toContain("(no ticket changes)");
  }, 30000);

  test("a missing original ticket does not prevent continuation", async () => {
    const f = await fixture();
    const result = f.resume("codex-run");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const receipt = jsonOf(Receipt).safeParse(result.stdout.toString().trim());
    expect(receipt.success).toBe(true);
    if (!receipt.success) return;
    const prompt = readFileSync(
      join(f.state, "runs", receipt.data.id, "brief.md"),
      "utf8",
    );
    expect(prompt).toContain(
      "(ticket diff unavailable; current ticket text is included below)",
    );
    expect(prompt.slice(prompt.indexOf("Proposition"))).toContain(
      "first prose",
    );
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
    if (verification === undefined)
      expect.unreachable("verification result is missing");
    expect(await Bun.file(verification.log_path).text()).toContain(
      "dispatcher xmsg",
    );
  },
);
