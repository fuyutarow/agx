import { prepareTicketRepo } from "../ticket-repo.ts";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import {
  changedFiles,
  changedPaths,
  deriveOutcome,
  workspaceSnapshot,
} from "../../src/next/outcome.ts";
import { parseReport, WorkerReport } from "../../src/report.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-derived-outcomes-"));
  roots.push(root);
  return root;
};

test("outcome contract: a complete return whose check result is not a string is not malformed", () => {
  const base = { summary: "done", changes: [], for_coordinator: [], open: [] };
  for (const result of [42, false, { passed: 3 }, null, [1, true], "ok"]) {
    const report = parseReport(undefined, JSON.stringify({
      ...base, checks: [{ cmd: "check", exit: 0, result }],
    }));
    expect(report.ok).toBe(true);
    if (!report.ok) continue;
    expect(report.report.checks[0]?.result).toBe(
      typeof result === "string" ? result : JSON.stringify(result),
    );
    expect(deriveOutcome({ timedOut: false, refused: false, verify: [], reportValid: report.ok, changed: 1 })).toBe("ok");
  }
  const missing = parseReport(undefined, JSON.stringify({
    ...base, checks: [{ cmd: "check", exit: 0 }],
  }));
  expect(missing.ok).toBe(false);
  expect(deriveOutcome({ timedOut: false, refused: false, verify: [], reportValid: missing.ok, changed: 1 })).toBe("malformed");
});

test("ended fixtures retain measured outcomes while routing omits ungraded raw history", async () => {
  const root = scratch();
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  await prepareTicketRepo(workspace);
  const state = join(root, "state");
  const Request = z.looseObject({
    state: z.looseObject({}),
    questions: z.object({
      worker: z.looseObject({ criteria: z.record(z.string(), z.string()) }),
    }),
  });
  let captured: z.output<typeof Request> | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const parsed = jsonOf(Request).safeParse(await request.text());
      if (parsed.success) captured = parsed.data;
      return Response.json({ answers: { worker: { choice: "luna-high" } } });
    },
  });
  servers.push(server);
  const cases: [string, string][] = [
    ["no-change", "no-change"],
    ["verify-failed", "verify-failed"],
    ["timeout", "timeout"],
    ["killed-bound", "timeout"],
    ["string-wrapped", "malformed"],
    ["ok", "ok"],
    ["malformed", "malformed"],
    ["refused", "refused"],
    ["structured", "ok"],
    ["last-message", "ok"],
    ["string-report", "malformed"],
    ["trailing-text", "ok"],
    ["capacity", "capacity"],
  ];
  const expected: string[] = [];
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "xdg-state"),
    AGX_CODEX_HOST_FILE: join(root, "absent-host.toml"),
    AGX_TMP_ROOT: join(root, "agx-tmp"),
    JEV_URL: `http://127.0.0.1:${server.port}/choice`,
    AGX_WORKER_BIN: join(import.meta.dir, "fixtures/outcome-worker.ts"),
    TYPESAFE_API_KEY: "test-key",
    AGX_CONFIG: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  };
  for (const [mode, outcome] of cases) {
    const ticket = join(workspace, `${mode}.md`);
    writeFileSync(
      ticket,
      `+++\nschema = 2\ntimeout_s = 60\nname = "${mode}"\nwrites = ["work.txt"]\noutcome = "fixture"\nverify = ["${mode === "verify-failed" ? "false" : "true"}"]\n[proposition]\nid = "OUTCOME"\nclaim = "derived outcomes"\nrefuted_by = "incorrect classification"\n+++\nFixture.\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "tools/agx-worker/src/next/cli.ts",
        "run",
        ticket,
        "--cd",
        workspace,
      ],
      {
        env: { ...env, AGX_OUTCOME_FIXTURE: mode },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(mode === "killed-bound" ? 143 : 0);
    const receipt = jsonOf(z.looseObject({ outcome: z.string() })).safeParse(
      stdout,
    );
    expect(receipt.success).toBe(true);
    if (receipt.success) expect(receipt.data.outcome).toBe(outcome);
    if (mode === "trailing-text")
      expect(stderr).toContain(
        "WARN trailing text after report JSON: extra text",
      );
    expect(captured?.state.history).toBeUndefined();
    // Local grades are audit data; only the roster's published evidence enters routing.
    expect(captured?.questions.worker.criteria.mechanical).toContain(
      "Classify only the ticket",
    );
    expect(captured?.questions.worker.criteria.split).toContain(
      "independent outcomes",
    );
    expected.push(outcome);
  }
  const listed = Bun.spawnSync(
    [process.execPath, "tools/agx-worker/src/next/cli.ts", "ls", "--json"],
    { env },
  );
  expect(listed.exitCode).toBe(0);
  const rows = jsonOf(
    z.array(
      z.looseObject({
        outcome: z.string(),
        changed_files: z.number().optional(),
      }),
    ),
  ).safeParse(listed.stdout.toString());
  expect(rows.success).toBe(true);
  if (rows.success) {
    expect(rows.data.map((row) => row.outcome)).toEqual(expected);
    expect(rows.data.map((row) => row.changed_files)).toEqual([
      0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
  }
  const events = readFileSync(join(state, "records.jsonl"), "utf8")
    .trim()
    .split("\n");
  const ended = events.flatMap((line) => {
    const parsed = jsonOf(
      z.looseObject({ kind: z.literal("ended"), outcome: z.string() }),
    ).safeParse(line);
    return parsed.success ? [parsed.data.outcome] : [];
  });
  expect(ended).toEqual(expected);
  const stats = Bun.spawnSync(
    [process.execPath, "tools/agx-worker/src/next/cli.ts", "stats"],
    { env },
  );
  expect(stats.exitCode).toBe(0);
  const counts = jsonOf(
    z.looseObject({ by_outcome: z.record(z.string(), z.number()) }),
  ).safeParse(stats.stdout.toString());
  expect(counts.success).toBe(true);
  if (!counts.success) return;
  expect(counts.data.by_outcome).toMatchObject({
    timeout: 2,
    capacity: 1,
    refused: 1,
  });
}, 180_000);

test("workspace evidence detects added, deleted and edited files without counting preexisting dirt", () => {
  const root = scratch();
  writeFileSync(join(root, "dirty.txt"), "preexisting dirt");
  writeFileSync(join(root, "delete.txt"), "remove me");
  const before = workspaceSnapshot(root);
  writeFileSync(join(root, "dirty.txt"), "edited dirt");
  writeFileSync(join(root, "added.txt"), "new");
  rmSync(join(root, "delete.txt"));
  const after = workspaceSnapshot(root);
  expect(before.isOk() && after.isOk()).toBe(true);
  if (before.isOk() && after.isOk()) {
    expect(changedFiles(before.value, before.value)).toBe(0);
    expect(changedFiles(before.value, after.value)).toBe(3);
    expect(changedPaths(before.value, after.value)).toEqual([
      "added.txt",
      "delete.txt",
      "dirty.txt",
    ]);
  }
});

test("outcome contract: a continuation that edits outside writes is not no-change", () => {
  const root = scratch();
  mkdirSync(join(root, "packages", "heritage"), { recursive: true });
  const before = workspaceSnapshot(root);
  writeFileSync(join(root, "packages", "heritage", "source.ts"), "export {}\n");
  const after = workspaceSnapshot(root);
  expect(before.isOk() && after.isOk()).toBe(true);
  if (!before.isOk() || !after.isOk()) return;
  const paths = changedPaths(before.value, after.value);
  expect(paths).toEqual(["packages/heritage/source.ts"]);
  expect(
    deriveOutcome({
      timedOut: false,
      refused: false,
      verify: [],
      reportValid: true,
      changed: paths.length,
    }),
  ).toBe("ok");
});

test("outcome contract: a run whose tree is unchanged is no-change", () => {
  const root = scratch();
  writeFileSync(join(root, "existing.txt"), "stable\n");
  const before = workspaceSnapshot(root);
  const after = workspaceSnapshot(root);
  expect(before.isOk() && after.isOk()).toBe(true);
  if (!before.isOk() || !after.isOk()) return;
  const paths = changedPaths(before.value, after.value);
  expect(paths).toEqual([]);
  expect(
    deriveOutcome({
      timedOut: false,
      refused: false,
      verify: [],
      reportValid: true,
      changed: paths.length,
    }),
  ).toBe("no-change");
});

test("outcome contract: malformed only when the returned report is unreadable", async () => {
  const root = scratch();
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  await prepareTicketRepo(workspace);
  const state = join(root, "state");
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ answers: { worker: { choice: "luna-high" } } }),
  });
  servers.push(server);
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "xdg-state"),
    AGX_CODEX_HOST_FILE: join(root, "absent-host.toml"),
    AGX_TMP_ROOT: join(root, "agx-tmp"),
    // This harness supplies a complete PATH and tests report outcomes, not mise trust.
    AGX_WORKER_PATH_SOURCE: "dispatcher",
    JEV_URL: `http://127.0.0.1:${server.port}/choice`,
    AGX_WORKER_BIN: join(import.meta.dir, "fixtures/outcome-worker.ts"),
    TYPESAFE_API_KEY: "test-key",
    AGX_CONFIG: new URL("../../src/roster/policy.example.toml", import.meta.url)
      .pathname,
  };

  const cases: [string, string][] = [
    ["real-returned", "ok"],
    ["unreadable-report", "malformed"],
  ];
  for (const [mode, outcome] of cases) {
    const ticket = join(workspace, `${mode}.md`);
    writeFileSync(
      ticket,
      `+++\nschema = 2\ntimeout_s = 60\nname = "${mode}"\nwrites = ["work.txt"]\noutcome = "fixture"\nverify = ["true"]\n[proposition]\nid = "OUTCOME"\nclaim = "readable returned reports"\nrefuted_by = "incorrect classification"\n+++\nFixture.\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "tools/agx-worker/src/next/cli.ts",
        "run",
        ticket,
        "--cd",
        workspace,
      ],
      {
        env: { ...env, AGX_OUTCOME_FIXTURE: mode },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const receipt = jsonOf(
      z.looseObject({
        id: z.string(),
        outcome: z.string(),
        report_path: z.string(),
      }),
    ).safeParse(stdout);
    expect(receipt.success).toBe(true);
    if (!receipt.success) continue;
    expect(receipt.data.outcome).toBe(outcome);

    const runDir = dirname(receipt.data.report_path);
    expect(existsSync(join(runDir, "fixture.result.md"))).toBe(true);
    const events = readFileSync(join(state, "records.jsonl"), "utf8")
      .trim()
      .split("\n");
    const ended = events
      .flatMap((line) => {
        const parsed = jsonOf(
          z.looseObject({
            kind: z.string(),
            id: z.string(),
            outcome: z.string().optional(),
            returned: z.boolean().optional(),
            changed_files: z.number().optional(),
          }),
        ).safeParse(line);
        return parsed.success &&
          parsed.data.kind === "ended" &&
          parsed.data.id === receipt.data.id
          ? [parsed.data]
          : [];
      })
      .at(-1);
    expect(ended).toMatchObject({
      kind: "ended",
      outcome,
      returned: true,
      changed_files: 1,
    });

    const reportText = readFileSync(receipt.data.report_path, "utf8");
    const workspaceChanges = jsonOf(
      z.looseObject({
        workspace_changes: z.object({
          changed_files: z.number(),
          changed_paths: z.array(z.string()),
        }),
      }),
    ).safeParse(reportText);
    expect(workspaceChanges.success).toBe(true);
    if (workspaceChanges.success)
      expect(workspaceChanges.data.workspace_changes).toEqual({
        changed_files: 1,
        changed_paths: ["work.txt"],
      });
    if (mode === "real-returned") {
      const report = jsonOf(WorkerReport).safeParse(reportText);
      expect(report.success).toBe(true);
      expect(report.success ? report.data.checks.length : 0).toBe(12);
      expect(report.success ? report.data.checks[11]?.exit : undefined).toBe(
        "unknown",
      );
      expect(
        report.success ? report.data.checks[11]?.exit_text : undefined,
      ).toBe("不明");
      expect(report.success ? report.data.summary : undefined).toContain(
        "パッケージを2611へコピー",
      );
    } else {
      const report = jsonOf(z.looseObject({ error: z.string() })).safeParse(
        reportText,
      );
      expect(report.success).toBe(true);
      expect(report.success && report.data.error).toContain(
        "the final message is not JSON",
      );
    }
  }
}, 180_000);
