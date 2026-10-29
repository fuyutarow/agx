import { createHash } from "node:crypto";
import { routingEvents } from "../../src/next/routing-events.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { writeUsageSnapshot } from "./usage-snapshot.fixture.ts";
import {
  loadRoster,
  criterionFor,
  ROUTING_OBJECTIVE,
} from "../../src/roster/index.ts";
import { readRouteUsage } from "../../src/next/usage.ts";
import { blindCriterion, route } from "../../src/next/route.ts";
import {
  append,
  events,
  now,
  flushRunPublications,
} from "../../src/next/store.ts";
import { parseNextTicket } from "../../src/next/ticket.ts";
import { prepareTicketRepo } from "../ticket-repo.ts";

const RoutingRequest = z.looseObject({
  state: z.looseObject({
    task: z.string(),
    published_task_metrics: z.record(
      z.string(),
      z.object({
        aa_time_per_task_s: z.number().nullable(),
      }).catchall(z.unknown()),
    ),
    routes: z.looseObject({
      claude: z.looseObject({
        available: z.boolean(),
        windows: z.record(
          z.string(),
          z.looseObject({
            used_percent: z.number().nullable(),
            elapsed_fraction: z.number().nullable(),
            pace: z.number().nullable(),
            status: z.string(),
          }),
        ),
      }),
      codex: z.looseObject({
        available: z.boolean(),
        windows: z.record(
          z.string(),
          z.looseObject({
            used_percent: z.number().nullable(),
            elapsed_fraction: z.number().nullable(),
            pace: z.number().nullable(),
            status: z.string(),
          }),
        ),
      }),
    }),
    task_size: z.looseObject({ timeout_s: z.number(), class: z.string() }),
  }),
  questions: z.looseObject({
    worker: z.looseObject({
      instructions: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
  }),
});

const priorRoster = process.env.AGX_CONFIG;
const priorUrl = process.env.JEV_URL;
const priorHome = process.env.HOME;
const priorStateDir = process.env.AGX_STATE_DIR;
const servers: ReturnType<typeof Bun.serve>[] = [];
const roots: string[] = [];

async function isolateState() {
  const root = await mkdtemp(join(tmpdir(), "agx-route-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(root, "catalog.toml"),
    await readFile(
      new URL("../../src/roster/catalog.toml", import.meta.url),
      "utf8",
    ),
  );
  const roster = await readFile(
    new URL("../../src/roster/policy.example.toml", import.meta.url),
    "utf8",
  );
  process.env.AGX_CONFIG = join(root, "roster.toml");
  await writeFile(
    process.env.AGX_CONFIG,
    roster.replace(/^allow = .*\n/mu, ""),
  );
  process.env.HOME = home;
  process.env.AGX_STATE_DIR = join(root, "state");
  return { root, home };
}

function installUsage(
  home: string,
  measuredAtMs: number,
  claudePercent: number,
  claudeElapsed: number,
  codexPercent: number,
  codexElapsed: number,
  claudeResetKnown = true,
) {
  const measuredSeconds = measuredAtMs / 1000;
  const fiveHours = 5 * 60 * 60;
  const sevenDays = 7 * 24 * 60 * 60;
  const written = writeUsageSnapshot(
    {
      rl5: 12,
      rl5Reset: measuredSeconds + fiveHours * 0.05,
      rl7: claudePercent,
      rl7Reset: claudeResetKnown
        ? measuredSeconds + sevenDays * (1 - claudeElapsed)
        : undefined,
      codexRate: {
        windows: [
          {
            minutes: 10080,
            percent: codexPercent,
            reset: measuredSeconds + sevenDays * (1 - codexElapsed),
          },
        ],
        mtimeMs: measuredAtMs,
      },
    },
    measuredSeconds,
    { HOME: home },
  );
  expect(written).toBe(true);
}

function startServer(
  choice: string,
  probabilities?: Record<string, number>,
  catalogPath?: string,
) {
  let requestBody: z.output<typeof RoutingRequest> | undefined;
  let wireBody: z.output<typeof RoutingRequest> | undefined;
  let rawBody: string | undefined;
  let calls = 0;
  let wireIds: Record<string, string> = {};
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      rawBody = await request.text();
      const parsed = jsonOf(RoutingRequest).safeParse(rawBody);
      calls++;
      if (parsed.success) {
        wireBody = parsed.data;
        const loaded = await loadRoster(
          catalogPath === undefined ? {} : { catalogPath },
        );
        if (!loaded.ok) return new Response(loaded.error, { status: 500 });
        const roster = loaded.value;
        const criteria = parsed.data.questions.worker.criteria;
        wireIds = Object.fromEntries(
          Object.entries(criteria).flatMap(([id, value]) => {
            const matchedRow = roster.choice.find((row) =>
              value.startsWith(
                blindCriterion(criterionFor(roster, row), roster.choice).split(
                  " Price ",
                )[0] ?? "",
              ),
            );
            return matchedRow === undefined ? [] : [[matchedRow.id, id]];
          }),
        );
        requestBody = parsed.data;
      }
      const wireChoice = wireIds[choice] ?? choice;
      let reasonCode: string | undefined;
      if (choice === "missing_input") reasonCode = "verify requires $AGX_RUN_DIR/parity.tsv";
      else if (["split", "uncheckable", "contradiction"].includes(choice))
        reasonCode = `specific ${choice} reason`;
      const wireProbabilities =
        probabilities === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(probabilities).map(([id, value]) => [
                wireIds[id] ?? id,
                value,
              ]),
            );
      return Response.json({
        answers: {
          worker: {
            choice: wireChoice,
            ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
            ...(wireProbabilities === undefined
              ? {}
              : { probabilities: wireProbabilities }),
          },
        },
      });
    },
  });
  servers.push(server);
  process.env.JEV_URL = `http://127.0.0.1:${server.port}/choice`;
  return {
    server,
    request: () => requestBody,
    rawRequest: () => wireBody,
    rawBody: () => rawBody,
    calls: () => calls,
    wireIds: () => wireIds,
  };
}

function appendStarted(row: string) {
  append({
    kind: "started",
    id: `test-${crypto.randomUUID()}`,
    at: now(),
    ticket: "route-test",
    writes: [],
    cwd: tmpdir(),
    workspace: tmpdir(),
    row,
    dispatcher_session: null,
    vendor_session: null,
    pid: 0,
  });
  return events().findLast((event) => event.kind === "started");
}

afterEach(async () => {
  await flushRunPublications();
  if (priorRoster === undefined) delete process.env.AGX_CONFIG;
  else process.env.AGX_CONFIG = priorRoster;
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  if (priorUrl === undefined) delete process.env.JEV_URL;
  else process.env.JEV_URL = priorUrl;
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorStateDir === undefined) delete process.env.AGX_STATE_DIR;
  else process.env.AGX_STATE_DIR = priorStateDir;
});

describe("retired Jev endpoint overrides", () => {
  for (const name of ["AGX_NEXT_JEV_URL", "JEX_JEV_URL"]) {
    for (const value of ["", "https://retired.invalid"]) {
      test(`rejects ${name}=${JSON.stringify(value)} before sending`, async () => {
        await isolateState();
        const server = startServer("sol-high");
        const child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `import { route } from ${JSON.stringify(new URL("../../src/next/route.ts", import.meta.url).pathname)}; await route("retired override");`,
          ],
          {
            env: { ...process.env, [name]: value },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 5000,
          },
        );
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exit).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toContain(name);
        expect(stderr).toContain("use JEV_URL instead");
        expect(server.request()).toBeUndefined();
      });
    }
  }
});

describe("capability constrained routing", () => {
  for (const capabilities of [[], ["terminal-agentic", "long-tool-loop"]]) {
    for (const probabilities of [undefined, { "sonnet-high": 1 }]) {
      test(`codex allowlist excludes Claude offers and picks: ${JSON.stringify({ capabilities, probabilities })}`, async () => {
        const { root } = await isolateState();
        const path = join(root, "roster.toml");
        await writeFile(
          path,
          (await readFile(path, "utf8")).replace(
            "[route]",
            '[route]\nallow = ["codex"]',
          ),
        );
        const server = startServer("sonnet-high", probabilities);
        const selected = await route(
          "Claude hook edit requiring strong capability",
          capabilities,
        );
        expect(selected.route).toBe("codex");
        const criteria = server.request()?.questions.worker.criteria ?? {};
        expect(typeof criteria.mechanical).toBe("string");
        expect(typeof criteria.localized).toBe("string");
        expect(typeof criteria.cross_module).toBe("string");
        expect(Object.keys(criteria).some((id) => id.startsWith("model_"))).toBe(false);
        expect(server.request()?.state.routes.claude.available).toBe(true);
      });
    }
  }

  // Removed: "no eligible capability rows names the route filter" tested the retired
  // capability-tag TB4 gate; requirement bars now derive only from ticket class.

  test("check reports the active route filter including omission", async () => {
    const { root } = await isolateState();
    await prepareTicketRepo(root);
    const ticket = join(root, "ticket.md");
    await writeFile(
      ticket,
      '+++\nschema = 2\nwrites = []\noutcome = "check routes"\n[proposition]\nid = "ROUTES"\nclaim = "filter is visible"\nrefuted_by = "filter missing"\n+++\nCheck routes.\n',
    );
    const path = join(root, "roster.toml");
    const original = await readFile(path, "utf8");
    for (const routes of [undefined, '["codex"]']) {
      await writeFile(
        path,
        routes === undefined
          ? original
          : original.replace("[route]", `[route]\nallow = ${routes}`),
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "tools/agx-worker/src/next/cli.ts",
          "check",
          ticket,
          "--cd",
          root,
        ],
        {
          env: { ...process.env, TYPESAFE_API_KEY: "routing-fixture-secret" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(stdout).toContain(`routes=${routes ?? "all (codex, claude)"}`);
    }
  });

  test("local accepted and rejected history cannot change the Jev request", async () => {
    const capture = async (decisions: readonly string[]) => {
      await isolateState();
      for (const decision of decisions) {
        const started = appendStarted("sol-medium");
        expect(started?.kind).toBe("started");
        if (started?.kind !== "started") continue;
        append({
          kind: "ended",
          id: started.id,
          at: now(),
          exit: 0,
          outcome: "ok",
          report_path: null,
          vendor_session: null,
        });
        append({
          kind: "judged",
          id: started.id,
          at: now(),
          decision,
          note: "audit-only local judgment",
        });
      }
      const server = startServer("localized");
      expect((await route("same frozen ticket")).id).toBe("terra-low");
      const request = server.request();
      expect(request).toBeDefined();
      const classCriteria = Object.keys(request?.questions.worker.criteria ?? {});
      expect(classCriteria).toContain("mechanical");
      expect(classCriteria).toContain("localized");
      expect(classCriteria).toContain("cross_module");
      return request;
    };

    const successSkew = await capture(["accept", "accept", "accept", "accept"]);
    const empty = await capture([]);
    const inverted = await capture(["reject", "reject", "reject", "reject"]);
    expect(empty).toEqual(successSkew);
    expect(inverted).toEqual(successSkew);
  });

  test("historical Sol 6.1 grades cannot alter class-based selection", async () => {
    await isolateState();
    const started = appendStarted("sol-high");
    expect(started?.kind).toBe("started");
    if (started?.kind !== "started") return;
    append({
      kind: "ended",
      id: started.id,
      at: now(),
      exit: 0,
      outcome: "ok",
      report_path: null,
      vendor_session: null,
    });
    append({
      kind: "judged",
      id: started.id,
      at: now(),
      decision: "accept",
      note: "historical Sol 6.1 acceptance",
    });
    const server = startServer("localized");
    expect((await route("generation-isolation replay")).id).toBe("terra-low");
    expect(server.request()?.questions.worker.criteria["localized"]).toBeDefined();
    expect(server.request()?.questions.worker.criteria["cross_module"]).toBeDefined();
  });
  test("ROUTER-PURPOSE: built request carries the exact purpose and subscription health", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    // Claude 5h = .12 - .84 = -.72; Claude 7d = .20 - .12 = +.08.
    installUsage(home, nowMs, 20, 0.12, 34, 0.11);
    expect(
      writeUsageSnapshot(
        {
          rl5: 12,
          rl5Reset: nowMs / 1000 + 18000 * 0.16,
          rl7: 20,
          rl7Reset: nowMs / 1000 + 604800 * 0.88,
          codexRate: {
            windows: [
              {
                minutes: 10080,
                percent: 34,
                reset: nowMs / 1000 + 604800 * 0.89,
              },
            ],
            mtimeMs: nowMs,
          },
        },
        nowMs / 1000,
        { HOME: home },
      ),
    ).toBe(true);
    const server = startServer("luna-high", { "luna-high": 1 });
    expect((await route("owner ruling replay")).route).toBe("codex");
    const request = server.request();
    expect(request?.state.history).toBeUndefined();
    expect(request?.state.task.length).toBeLessThanOrEqual(2400);
    expect(request?.questions.worker.instructions).toContain(ROUTING_OBJECTIVE);
    expect(request?.questions.worker.instructions).toContain("classify this ticket");
    expect(request?.questions.worker.instructions).not.toContain(
      "A. Capability sufficiency (hard)",
    );
    const classCriteria = Object.keys(request?.questions.worker.criteria ?? {});
    expect(classCriteria).toContain("mechanical");
    expect(classCriteria).toContain("localized");
    expect(classCriteria).toContain("cross_module");
    expect(
      Object.keys(request?.state.routes.claude.windows["7d"] ?? {}),
    ).toEqual(["used_percent", "elapsed_fraction", "pace", "status"]);
    expect(Object.keys(request?.state.routes.claude.windows ?? {})).toEqual([
      "7d",
      "5h",
    ]);
    expect(request?.state.routes.claude.windows["7d"]?.pace).toBeCloseTo(
      0.08,
      5,
    );
    expect(request?.state.routes.codex.windows["7d"]?.pace).toBeCloseTo(
      0.23,
      5,
    );
    expect(request?.questions.worker.criteria["localized"]).toBeDefined();
    expect(request?.questions.worker.instructions).toContain(ROUTING_OBJECTIVE);
    expect(request?.questions.worker.instructions).toContain(
      "5-hour windows are secondary",
    );
    expect(ROUTING_OBJECTIVE).toContain("7-day windows most");
  });

  test("route contract: a row whose published duration exceeds the time box is not offered", async () => {
    await isolateState();
    const loaded = await loadRoster();
    if (!loaded.ok) expect.unreachable(loaded.error);
    const duration = loaded.value.choice.find(
      (row) => row.id === "luna-high",
    )?.aa_time_per_task_s;
    if (duration === undefined)
      expect.unreachable("missing published duration");
    // A 600s ticket has a 360s published-duration budget.
    const server = startServer("mechanical", { mechanical: 1 });
    const selected = await route("time-box margin", [], 600);
    expect(selected.aa_time_per_task_s).toBeLessThanOrEqual(360);
    const request = server.rawRequest();
    if (request === undefined) expect.unreachable("missing Jev request");
    expect(request.state.task_size.timeout_s).toBe(600);
    expect(request.state.published_task_metrics).toEqual({});
    expect(server.request()?.questions.worker.criteria.mechanical).toBeDefined();
    const filters = z
      .array(z.object({ reason: z.string(), removed: z.array(z.unknown()) }))
      .safeParse(routingEvents().events.at(-1)?.audit?.filters);
    if (!filters.success) expect.unreachable("missing routing filter audit");
    expect(
      filters.data.find(
        (filter) => filter.reason === "published duration exceeds time box",
      )?.removed,
    ).toContainEqual({
      row: "luna-max",
      detail: {
        aa_time_per_task_s: 597.3140575781733,
        timeout_s: 600,
      },
    });
    const boundary = startServer("mechanical", { mechanical: 1 });
    const exact = await route("exact margin boundary", [], duration / 0.6);
    expect(exact.aa_time_per_task_s).toBeLessThanOrEqual(duration);
    expect(boundary.calls()).toBe(1);
    const shorter = startServer("mechanical", { mechanical: 1 });
    const below = await route("below boundary", [], duration / 0.6 - 0.0001);
    expect(below.aa_time_per_task_s).toBeLessThanOrEqual(duration - 0.00006);
    expect(shorter.calls()).toBe(1);
    const longer = startServer("mechanical", { mechanical: 1 });
    await route("max fits with margin", [], 1000);
    expect(longer.calls()).toBe(1);
  });

  test("fresh Codex source survives consecutive picks and empty statusline publication", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    const dir = join(home, ".codex", "sessions", "2026", "01", "01");
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "rollout-account.jsonl");
    await Bun.write(
      source,
      `${JSON.stringify({
        timestamp: Temporal.Instant.fromEpochMilliseconds(nowMs).toString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            secondary: {
              used_percent: 34,
              window_minutes: 10080,
              resets_at: nowMs / 1000 + 604800 * 0.89,
            },
          },
        },
      })}\n`,
    );
    // A newer session with no rate event must not hide the fresh account source.
    await Bun.write(
      join(dir, "rollout-empty.jsonl"),
      '{"type":"session_meta"}\n',
    );
    installUsage(home, nowMs, 20, 0.12, 34, 0.11);
    expect((await readRouteUsage(nowMs + 1000)).codex.usage_status).toBe(
      "fresh",
    );
    expect(writeUsageSnapshot({}, nowMs / 1000 + 120, { HOME: home })).toBe(
      true,
    );
    const second = await readRouteUsage(nowMs + 120000);
    expect(second.codex.usage_status).toBe("fresh");
    expect(second.codex.source_reason).toBe(
      "fresh Codex 7d rollout rate event",
    );
    expect(second.codex.windows["7d"]?.used_percent).toBe(34);
    const third = await readRouteUsage(nowMs + 180000);
    expect(third.codex.usage_status).toBe("fresh");
    const stale = await readRouteUsage(nowMs + 16 * 60000);
    expect(stale.codex.usage_status).toBe("unknown");
    expect(stale.codex.source_reason).toBe("no fresh Codex rollout source");
  });

  test("missing Codex source is explained in the pick audit", async () => {
    await isolateState();
    startServer("luna-high", { "luna-high": 1 });
    const selected = await route("missing source audit");
    const started = appendStarted(selected.id);
    if (started?.kind === "started")
      expect(started.pick_audit?.usage_snapshot).toMatchObject({
        codex: { source_reason: "no fresh Codex rollout source" },
      });
  });

  test("th-purge ticket class retains the extended timeout and class-based score bar", async () => {
    await isolateState();
    const server = startServer("cross_module", { cross_module: 1 });
    const parsed = parseNextTicket(
      `+++\nschema = 2\nname = "th-purge"\nwrites = ["PURGE-MANIFEST.tsv", "admission/**"]\noutcome = "inventory, classify, retain, and verify every theory file"\ntimeout_s = 14400\ncapabilities = ["terminal-agentic", "long-tool-loop", "bulk-classification"]\n[proposition]\nid = "TH-PURGE-1"\nclaim = "every THEORY file is retained byte-exact in canonical v1"\nrefuted_by = "a THEORY row lacks a verified v1 id or has a byte mismatch"\n+++\nInventory all prose research artifacts.\n`,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const selected = await route(
      "inventory and classify the repo",
      parsed.ticket.capabilities,
      parsed.ticket.timeout_s,
    );
    expect(selected.id).toBe("terra-high");
    expect(server.request()?.state.routes.claude.windows["7d"]?.status).toBe(
      "unknown",
    );
    expect(server.request()?.state.task_size).toEqual({
      timeout_s: 14_400,
      class: "multi-hour",
    });
    expect(server.request()?.questions.worker.criteria.cross_module).toBeDefined();
    expect(Object.keys(server.request()?.questions.worker.criteria ?? {}).some((id) => id.startsWith("model_"))).toBe(false);
    const criteria = Object.values(
      server.request()?.questions.worker.criteria ?? {},
    );
    const routeBias = [
      ["choose", "a", "model"],
    ].map((words) => words.join(" "));
    expect(
      criteria.every((row) =>
        routeBias.every((phrase) => !row.includes(phrase)),
      ),
    ).toBe(true);
    expect(
      routeBias.every(
        (phrase) =>
          !(server.request()?.questions.worker.instructions ?? "").includes(
            phrase,
          ),
      ),
    ).toBe(true);
    const retry = await route(
      "inventory and classify the repo",
      parsed.ticket.capabilities,
      parsed.ticket.timeout_s,
      ["terra-high"],
    );
    expect(retry.id).not.toBe("terra-high");
    appendStarted(retry.id);
  });

  test("the replayed subscription pace is visible to ticket classification", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    installUsage(home, nowMs, 3, 0.94, 45, 0.28);
    const server = startServer("localized", { localized: 1 });

    const selected = await route("comparable routing replay");
    expect(selected.id).toBe("terra-low");
    const request = server.request();
    const claudeWeek = request?.state.routes.claude.windows["7d"];
    const codexWeek = request?.state.routes.codex.windows["7d"];
    expect(claudeWeek).toMatchObject({
      used_percent: 3,
      status: "fresh",
    });
    expect(claudeWeek?.elapsed_fraction).toBeCloseTo(0.94, 5);
    expect(claudeWeek?.pace).toBeCloseTo(-0.91, 5);
    expect(codexWeek).toMatchObject({
      used_percent: 45,
      status: "fresh",
    });
    expect(codexWeek?.elapsed_fraction).toBeCloseTo(0.28, 5);
    expect(codexWeek?.pace).toBeCloseTo(0.17, 5);
    expect(request?.questions.worker.instructions).toContain(ROUTING_OBJECTIVE);
    expect(request?.questions.worker.instructions).toContain(
      "stale or unknown usage is neutral",
    );
    expect(request?.questions.worker.criteria.localized).toBeDefined();

    const started = appendStarted(selected.id);
    expect(started?.kind).toBe("started");
    if (started?.kind === "started")
      expect(started.pick_audit).toMatchObject({
        source: "jev-classified",
        probabilities: { localized: 1 },
      });
  });

  test("a route above its weekly limit is unavailable and its rows are excluded", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    installUsage(home, nowMs, 101, 0.94, 45, 0.28, false);
    const server = startServer("localized", { localized: 1 });

    const selected = await route("exclude a capped route");
    expect(selected.route).toBe("codex");
    expect(server.request()?.state.routes.claude.available).toBe(false);
    expect(server.request()?.state.routes.claude.windows["7d"]?.status).toBe(
      "unknown",
    );
    expect(server.request()?.questions.worker.criteria.localized).toBeDefined();
    expect(Object.keys(server.request()?.questions.worker.criteria ?? {}).some((id) => id.startsWith("model_"))).toBe(false);
    appendStarted(selected.id);
  });

  test("stale usage is neutral and does not exclude either route", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    installUsage(home, nowMs - 16 * 60 * 1000, 100, 0.94, 45, 0.28);
    const server = startServer("localized", { localized: 1 });

    const selected = await route("stale usage replay");
    const routes = server.request()?.state.routes;
    expect(routes).toBeDefined();
    if (routes === undefined) return;
    expect(routes.claude.available).toBe(true);

    expect(routes.claude.windows["7d"]?.status).toBe("stale");
    expect(routes.claude.windows["7d"]?.pace).toBeNull();
    expect(routes.codex.available).toBe(true);
    appendStarted(selected.id);
  });

  test("an invalid Jev choice records the fallback reason and probabilities", async () => {
    await isolateState();
    const server = startServer("not-a-roster-row", {
      "not-a-roster-row": 1,
    });

    const selected = await route("fallback audit replay");
    expect(selected.id).toBe("luna-high");
    const started = appendStarted(selected.id);
    expect(started?.kind).toBe("started");
    if (started?.kind === "started") {
      expect(started.pick_audit?.source).toBe("fallback-invalid-class");
      expect(started.pick_audit?.probabilities).toEqual({
        "not-a-roster-row": 1,
      });
      expect(started.pick_audit?.usage_snapshot).toMatchObject(
        server.request()?.state.routes ?? {},
      );
    }
  });
});

test("combined candidate rejects mixed Sol generations before Jev, even outside auto routes", async () => {
  const { root } = await isolateState();
  const path = join(root, "roster.toml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "[route]",
      '[route]\nallow = ["codex"]',
    ),
  );
  const catalogPath = join(root, "catalog.toml");
  await writeFile(
    catalogPath,
    (await readFile(catalogPath, "utf8")).replace(
      'id = "sol-low"\nroute = "codex"\nmodel = "gpt-6.1-sol"',
      'id = "sol-low"\nroute = "claude"\nmodel = "gpt-6.0-sol"',
    ),
  );
  const server = startServer("sol-high");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import {route} from ${JSON.stringify(new URL("../../src/next/route.ts", import.meta.url).pathname)}; await route("mixed candidate", [], 600, [], { catalogPath: ${JSON.stringify(join(root, "catalog.toml"))} });`,
    ],
    {
      env: { ...process.env, TYPESAFE_API_KEY: "routing-fixture-secret" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // loadRoster failure is a configuration error (1); candidate exhaustion uses 2.
  expect(exit, stderr).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toStartWith(
    "agx: cannot read dispatch roster: model family sol has multiple generations:",
  );
  expect(stderr).toContain("Keep one generation for each family");
  expect(stderr).toContain("gpt-6.0-sol");
  expect(stderr).toContain("gpt-6.1-sol");
  expect(server.request()).toBeUndefined();
});

test("route contract: Jev payload hides roster rows while classifying the ticket", async () => {
  await isolateState();
  const loaded = await loadRoster();
  if (!loaded.ok) expect.unreachable(loaded.error);
  const task = "User task mentions sol-medium and high effort verbatim";
  const server = startServer("localized", { localized: 1 });
  const selected = await route(task);
  const request = server.rawRequest();
  if (request === undefined) expect.unreachable("missing Jev request");
  expect(request.state.task).toBe(task);
  const rawBody = server.rawBody();
  if (rawBody === undefined) expect.unreachable("missing request body");
  const injected = rawBody.replace(JSON.stringify(task), JSON.stringify("[ticket omitted]"));
  expect(injected).not.toContain("anonymization_map");
  for (const row of loaded.value.choice) {
    expect(injected.toLowerCase()).not.toContain(row.id.toLowerCase());
    expect(injected.toLowerCase()).not.toContain(row.model.toLowerCase());
    const family = row.id.split("-")[0];
    if (family === undefined) expect.unreachable("row " + row.id + " has no family");
    expect(injected).not.toMatch(new RegExp("\\b" + family + "\\b", "iu"));
    for (const version of row.model.match(/\d+(?:[.-]\d+)+/gu) ?? [])
      expect(injected).not.toMatch(
        new RegExp("(?<![\\d.])" + version.replaceAll(".", "\\.") + "(?![\\d.])", "u"),
      );
  }
  expect(injected).not.toMatch(/\b(low|medium|high|xhigh|max|effort)\b/iu);
  expect(Object.keys(request.questions)).toEqual(["worker"]);
  expect(Object.keys(request.questions.worker.criteria)).toEqual([
    "mechanical", "localized", "cross_module", "split", "uncheckable", "contradiction", "missing_input",
  ]);
  expect(request.state.published_task_metrics).toEqual({});
  expect(selected.id).toBe("terra-low");
  expect(server.calls()).toBe(1);
});

for (const reason of ["split", "uncheckable", "contradiction", "missing_input"] as const) {
  test(
    reason === "missing_input"
      ? "dispatch contract: a Jev missing_input reply is recorded as refused with its reason"
      : "return " + reason + " exits 2, records the answer and never reaches worker startup",
    async () => {
      const { root } = await isolateState();
      const server = startServer(reason, { [reason]: 1, model_0: 0 });
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          "import {route} from " + JSON.stringify(new URL("../../src/next/route.ts", import.meta.url).pathname) + "; await route('return fixture'); await Bun.write(" + JSON.stringify(join(root, "worker-started")) + ", 'started');",
        ],
        {
          env: { ...process.env, TYPESAFE_API_KEY: "routing-fixture-secret" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("ticket returned: " + reason);
      if (reason === "missing_input")
        expect(stderr).toContain(
          "ticket returned: missing_input: verify requires $AGX_RUN_DIR/parity.tsv",
        );
      else expect(stderr).toContain(`specific ${reason} reason`);
      expect(await Bun.file(join(root, "worker-started")).exists()).toBe(false);
      expect(server.calls()).toBe(1);
      const parsedRecord = jsonOf(
        z.object({
          reason: z.string(),
          reason_detail: z.string().optional(),
          pick_audit: z.object({
            answer: z.object({ choice: z.string() }),
            probabilities: z.record(z.string(), z.number()),
            anonymization_map: z.record(z.string(), z.string()),
          }),
        }),
      ).safeParse(await readFile(join(root, "state", "routing-refusals.jsonl"), "utf8"));
      expect(parsedRecord.success).toBe(true);
      if (!parsedRecord.success) return;
      const record = parsedRecord.data;
      expect(record.reason).toBe(reason);
      if (reason === "missing_input")
        expect(record.reason_detail).toBe("verify requires $AGX_RUN_DIR/parity.tsv");
      expect(record.pick_audit.answer.choice).toBe(reason);
      expect(record.pick_audit.probabilities[reason]).toBe(1);
    },
  );
}

test("route contract: an unnamed return never refuses a dispatch", async () => {
  const { root } = await isolateState();
  const server = startServer("unused");
  for (const reasonCode of [undefined, "", "   "]) {
    server.server.reload({ fetch: () => Response.json({ answers: { worker: {
      choice: "missing_input", reason_code: reasonCode,
    } } }) });
    const picked = await route("unnamed return fixture");
    expect(picked.id).toBe("luna-high");
    const started = appendStarted(picked.id);
    if (started?.kind === "started")
      expect(started.pick_audit).toMatchObject({
        source: "fallback-unnamed-return",
        answer: { choice: "missing_input" },
      });
  }
  expect(await Bun.file(join(root, "state", "routing-refusals.jsonl")).exists()).toBe(false);
});

test("missing worker answer uses the default and records the missing-answer fallback", async () => {
  await isolateState();
  const server = startServer("unused");
  server.server.reload({ fetch: () => Response.json({ answers: {} }) });
  const picked = await route("missing answer fixture");
  expect(picked.id).toBe("luna-high");
  const started = appendStarted(picked.id);
  if (started?.kind === "started")
    expect(started.pick_audit).toMatchObject({
      source: "fallback-missing-answer",
      answer: null,
    });
});

test("blinding retains grammatical comparisons and compound meanings", async () => {
  await isolateState();
  const loaded = await loadRoster();
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const rows = loaded.value.choice;
  expect(
    blindCriterion(
      "low-cost contained reasoning when luna-low's capability is insufficient",
      rows,
    ),
  ).toBe(
    "inexpensive contained reasoning when another model's capability is insufficient",
  );
  expect(blindCriterion("strong low-effort coding or reasoning", rows)).toBe(
    "strong coding or reasoning at a modest setting",
  );
  expect(
    blindCriterion(
      "deep sol reasoning for tasks beyond lower-effort sol",
      rows,
    ),
  ).toBe(
    "deep model reasoning for tasks beyond another model at a less intensive setting",
  );
  expect(blindCriterion("where Sol 6.1 low is insufficient", rows)).toBe(
    "where another model at its lowest setting is insufficient",
  );
  expect(
    blindCriterion("AA 50, TB4 51.5%, SciCode 55.8%. Price $2/$10", rows),
  ).toBe("AA 50, TB4 51.5%, SciCode 55.8%. Price $2/$10");
});

test("every shipped Jev option is readable and keeps its row measurements", async () => {
  await isolateState();
  const loaded = await loadRoster();
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const rows = loaded.value.choice;
  const optionOrder = rows.toSorted(
    (a, b) =>
      ["low", "medium", "high", "xhigh", "max"].indexOf(a.effort) -
      ["low", "medium", "high", "xhigh", "max"].indexOf(b.effort),
  );
  const measurements = rows.map((row) => ({
    id: row.id,
    route: row.route,
    effort: row.effort,
    aa_index: row.aa_index,
    tb4: row.tb4,
    scicode: row.scicode,
    price_in: row.price_in,
    price_cached_in: row.price_cached_in,
    price_out: row.price_out,
  }));
  const texts = optionOrder.map((row) =>
    blindCriterion(criterionFor(loaded.value, row), rows),
  );

  expect(texts).toHaveLength(rows.length);
  const quantitativeCriterion =
    /^Route (?:codex|claude)\. (?:(?:AA|TB4|SciCode|CodingAgent) \d+(?:\.\d+)?%? \(Artificial Analysis, \d{4}-\d{2}-\d{2}\)(?:; (?:AA|TB4|SciCode|CodingAgent) \d+(?:\.\d+)?%? \(Artificial Analysis, \d{4}-\d{2}-\d{2}\))*|no published scores)\. Price (?:\$\d+(?:\.\d+)?|—)\/(?:\$\d+(?:\.\d+)?|—)\/(?:\$\d+(?:\.\d+)?|—) per 1M tokens in\/cache\/out(?: \(per-token price only\))?\.(?: Cost to run AA index: \$\d+(?:\.\d+)? \(\d+(?:\.\d+)?M tokens, AA \d{4}-\d{2}-\d{2}\)\.)? Multiple (?:\d+(?:\.\d+)?|unknown)x cheapest costed row\.$/u;
  for (const text of texts) {
    expect(text).toMatch(quantitativeCriterion);
    expect(text).not.toMatch(
      /\b(?:capable|task|work|where|insufficient|reasoning)\b/iu,
    );
  }
  for (const row of rows) expect(row).not.toHaveProperty("use_for");
  expect(optionOrder.map((row) => row.id)).toEqual(
    rows
      .toSorted(
        (a, b) =>
          ["low", "medium", "high", "xhigh", "max"].indexOf(a.effort) -
          ["low", "medium", "high", "xhigh", "max"].indexOf(b.effort),
      )
      .map((row) => row.id),
  );
  expect(
    rows.map((row) => ({
      id: row.id,
      route: row.route,
      effort: row.effort,
      aa_index: row.aa_index,
      tb4: row.tb4,
      scicode: row.scicode,
      price_in: row.price_in,
      price_cached_in: row.price_cached_in,
      price_out: row.price_out,
    })),
  ).toEqual(measurements);
  for (const text of texts) {
    expect(text).not.toMatch(/(?:^|[.!?]\s*)-/u);
    expect(text).not.toMatch(/\s's\s/u);
    expect(text).not.toMatch(/ {2,}/u);
    expect(text).not.toMatch(
      /\b(?:when|where|than|for)\s+(?:'s|capability|setting)\b/iu,
    );
  }
  expect(
    blindCriterion(
      "-cost contained reasoning when 's capability is insufficient",
      rows,
    ),
  ).not.toMatch(/(?:^|[.!?]\s*)-|\s's\s| {2,}/u);
  expect(blindCriterion("strong - coding or reasoning", rows)).not.toMatch(
    /(?:^|[.!?]\s*)-|\s's\s| {2,}/u,
  );
});

test("Jev request is byte-identical across opposite local run histories", async () => {
  await isolateState();
  const accepted = appendStarted("luna-high");
  if (accepted?.kind !== "started")
    expect.unreachable("missing accepted history run");
  append({
    kind: "ended",
    id: accepted.id,
    at: now(),
    exit: 0,
    outcome: "ok",
    report_path: null,
    vendor_session: null,
  });
  append({
    kind: "judged",
    id: accepted.id,
    at: now(),
    decision: "accept",
    note: "accepted history fixture",
  });
  const first = startServer("luna-high", { "luna-high": 1 });
  await route("open-loop byte guard");
  expect(first.rawBody()).toBeDefined();

  await isolateState();
  const rejected = appendStarted("luna-high");
  if (rejected?.kind !== "started")
    expect.unreachable("missing rejected history run");
  append({
    kind: "ended",
    id: rejected.id,
    at: now(),
    exit: 0,
    outcome: "ok",
    report_path: null,
    vendor_session: null,
  });
  append({
    kind: "judged",
    id: rejected.id,
    at: now(),
    decision: "reject",
    note: "rejected history fixture",
  });
  const second = startServer("luna-high", { "luna-high": 1 });
  await route("open-loop byte guard");
  expect(second.rawBody()).toBe(first.rawBody());
});

// Ten histories per choice are the no-feedback guard's point; do not shrink this fixture.
test("local accepted and rejected history cannot change the Jev request", async () => {
  const requests: string[] = [];
  for (const decision of ["accept", "reject"] as const) {
    await isolateState();
    const loaded = await loadRoster();
    if (!loaded.ok) return;
    const start = Temporal.Instant.from(now()).subtract({ seconds: 906 });
    const ended = start.add({ seconds: 306 });
    const history = loaded.value.choice.flatMap((row) =>
      Array.from({ length: 10 }, () => ({
        row: row.id,
        id: `history-${crypto.randomUUID()}`,
      })),
    );
    for (const { row, id } of history) {
      append({
        kind: "started",
        id,
        at: start.toString(),
        ticket: "history fixture",
        writes: [],
        cwd: tmpdir(),
        workspace: tmpdir(),
        row,
        dispatcher_session: null,
        vendor_session: null,
        pid: 0,
      });
      append({
        kind: "ended",
        id,
        at: ended.toString(),
        exit: 0,
        report_path: null,
        vendor_session: null,
        verify: [],
      });
      append({
        kind: "judged",
        id,
        at: now(),
        decision,
        note: "opposite-mix fixture",
      });
    }
    const server = startServer("sol-medium");
    await route("same ticket for every history");
    const serialized = server.rawBody();
    if (serialized === undefined)
      expect.unreachable("serialized Jev request was not captured");
    const request = server.rawRequest();
    if (request === undefined)
      expect.unreachable("parsed Jev request was not captured");
    for (const criterion of Object.values(request.questions.worker.criteria))
      expect(criterion).not.toContain("agx measured");
    requests.push(serialized);
  }
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
}, 20_000);
test("audit retains class probabilities, the bar, qualifying rows, and deterministic selection", async () => {
  await isolateState();
  const server = startServer("localized", { localized: 1 });
  const selected = await route("class audit fixture");
  const journal = routingEvents();
  const decision = journal.events.at(-1);
  const audit = decision?.audit;
  expect(audit?.input).toEqual(server.rawRequest());
  expect(audit?.input_sha256).toBe(
    createHash("sha256")
      .update(server.rawBody() ?? "")
      .digest("hex"),
  );
  expect(audit?.input_truncated).toBe(false);
  expect(audit?.requirement_class).toBe("localized");
  expect(audit?.tb4_bar).toBe(15);
  expect(audit?.qualifying_rows).toContain("terra-low");
  expect(audit?.selected_row).toBe("terra-low");
  expect(audit?.choice_probabilities).toEqual({ localized: 1 });
  expect(selected.id).toBe("terra-low");
  expect(server.rawRequest()?.questions.worker.criteria.localized).toBeDefined();
  const started = appendStarted(selected.id);
  if (started?.kind === "started")
    expect(started.pick_audit?.audit).toEqual(audit);
});

test("route contract: the selected row depends on the ticket class, and the choice list Jev sees contains no model rows", async () => {
  await isolateState();
  const selectClass = async (ticketClass: string) => {
    const server = startServer(ticketClass);
    const row = await route(`ticket-class:${ticketClass}`);
    const request = server.rawRequest();
    const criteria = request?.questions.worker.criteria ?? {};
    expect(typeof criteria.mechanical).toBe("string");
    expect(typeof criteria.localized).toBe("string");
    expect(typeof criteria.cross_module).toBe("string");
    expect(Object.keys(criteria).some((id) => id.startsWith("model_"))).toBe(false);
    expect(request?.state.published_task_metrics).toEqual({});
    return row.id;
  };
  const mechanical = await selectClass("mechanical");
  await isolateState();
  const localized = await selectClass("localized");
  await isolateState();
  const crossModule = await selectClass("cross_module");
  expect(mechanical).toMatch(/^luna-/u);
  expect(localized).toBe("terra-low");
  expect(crossModule).toBe("terra-high");
  expect(new Set([mechanical, localized, crossModule]).size).toBe(3);
});

test("bar_unmet audits and selects the highest TB4 row inside the published time box", async () => {
  const { root } = await isolateState();
  const catalogPath = join(root, "catalog.toml");
  await writeFile(
    catalogPath,
    (await readFile(catalogPath, "utf8"))
      .replaceAll(/^tb4 = .*$/gmu, "tb4 = 0")
      .replace(/(id = "terra-high"[\s\S]*?\ntb4 = )0/u, "$1 10"),
  );
  const server = startServer("cross_module", { cross_module: 1 }, catalogPath);
  const selected = await route("unmet bar fixture", [], 600, [], { catalogPath });
  const audit = routingEvents().events.at(-1)?.audit;
  expect(selected.id).toBe("terra-high");
  expect(audit?.requirement_class).toBe("cross_module");
  expect(audit?.tb4_bar).toBe(40);
  expect(audit?.qualifying_rows).toEqual([]);
  expect(audit?.bar_unmet).toBe(true);
  expect(audit?.selected_row).toBe(selected.id);
  expect(server.calls()).toBe(1);
});

test("Jev transport failure falls back to route.default", async () => {
  await isolateState();
  const loaded = await loadRoster();
  if (!loaded.ok) expect.unreachable(loaded.error);
  process.env.JEV_URL = "http://127.0.0.1:1/unreachable";
  const selected = await route("unreachable Jev fixture");
  expect(selected.id).toBe(loaded.value.default);
  expect(routingEvents().events.at(-1)?.source).toBe("fallback-request-failed");
});

const auditFields = [
  "decision_id",
  "ticket_path",
  "ticket_sha256",
  "input",
  "input_sha256",
  "input_truncated",
  "filters",
  "capability_tags",
  "timeout_class",
  "pick_temperature",
  "selection_mode",
  "policy_version",
  "catalog_version",
  "jev_model_version",
  "raw_reply",
  "outcome_kind",
  "usage_id",
];

for (const choice of ["localized", "not-a-class"]) {
  test(`audit field coverage for ${choice}`, async () => {
    await isolateState();
    startServer(choice);
    await route(
      "fixture",
      [],
      600,
      [],
      {},
      { path: "/fixture/ticket.md", sha256: "fixture-hash" },
    );
    const decision = routingEvents().events.at(-1);
    for (const field of auditFields)
      expect(Object.hasOwn(decision?.audit ?? {}, field)).toBe(true);
    expect(decision?.audit?.raw_reply).toContain(choice);
    expect(decision?.audit?.ticket_path).toBe("/fixture/ticket.md");
    expect(JSON.stringify(decision)).not.toContain("TYPESAFE_API_KEY");
  });
}

test("refusal and pre-start failure retain full audit fields without a started receipt", async () => {
  await isolateState();
  startServer("sol-medium");
  const modulePath = new URL("../../src/next/route.ts", import.meta.url)
    .pathname;
  for (const masked of [[], ["all"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {route} from ${JSON.stringify(modulePath)}; import {loadRoster} from ${JSON.stringify(new URL("../../src/roster/index.ts", import.meta.url).pathname)}; const loaded = await loadRoster(); const masked = ${JSON.stringify(masked)}.length && loaded.ok ? loaded.value.choice.map(row => row.id) : []; await route("fixture", [], 600, masked, {}, {path:"/fixture/ticket.md", sha256:"fixture-hash", launch:true}); process.exit(1);`,
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    const [exit] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(masked.length === 0 ? 1 : 2);
    const event = routingEvents().events.at(-1);
    expect(event?.outcome).toBe(
      masked.length === 0 ? "pre-start failure" : "refusal",
    );
    for (const field of auditFields)
      expect(Object.hasOwn(event?.audit ?? {}, field)).toBe(true);
  }
});
