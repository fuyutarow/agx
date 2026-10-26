import { createHash } from "node:crypto";
import { routingEvents } from "../../src/next/routing-events.ts";
import { sampleRow } from "../../src/selection.ts";
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

function startServer(choice: string, probabilities?: Record<string, number>) {
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
        const loaded = await loadRoster();
        if (!loaded.ok) return new Response(loaded.error, { status: 500 });
        const roster = loaded.value;
        const criteria = parsed.data.questions.worker.criteria;
        wireIds = Object.fromEntries(
          Object.entries(criteria).flatMap(([id, value]) => {
            const matchedRow = roster.choice.find((row) =>
              value.startsWith(
                blindCriterion(criterionFor(roster, row), roster.choice),
              ),
            );
            return matchedRow === undefined ? [] : [[matchedRow.id, id]];
          }),
        );
        // Legacy assertions address rows through this fixture-only decoded view.
        requestBody = {
          ...parsed.data,
          questions: {
            worker: {
              ...parsed.data.questions.worker,
              criteria: Object.fromEntries(
                Object.entries(wireIds).map(([row, id]) => [
                  row,
                  (() => {
                    const criterion = criteria[id];
                    if (criterion === undefined)
                      expect.unreachable(`missing criterion for ${id}`);
                    return criterion;
                  })(),
                ]),
              ),
            },
          },
        };
      }
      const wireChoice = wireIds[choice] ?? choice;
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
        const criteria = Object.values(
          server.request()?.questions.worker.criteria ?? {},
        );
        expect(criteria.length).toBeGreaterThan(0);
        expect(
          criteria.every((criterion) => criterion.startsWith("Route codex.")),
        ).toBe(true);
        expect(
          server.request()?.questions.worker.criteria["sonnet-high"],
        ).toBeUndefined();
      });
    }
  }

  test("no eligible capability rows names the route filter", async () => {
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
      (await readFile(catalogPath, "utf8")).replaceAll(
        /^tb4 = .*$/gmu,
        "tb4 = 0",
      ),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { route } from ${JSON.stringify(new URL("../../src/next/route.ts", import.meta.url).pathname)}; await route("capability probe", ["long-tool-loop"], 600, [], { catalogPath: ${JSON.stringify(join(root, "catalog.toml"))} });`,
      ],
      {
        env: { ...process.env, TYPESAFE_API_KEY: "routing-fixture-secret" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(2);
    expect(stderr).toContain(
      'no roster row satisfies required capabilities (routes=["codex"])',
    );
  });

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
      const server = startServer("sonnet-high");
      expect((await route("same frozen ticket")).id).toBe("sonnet-high");
      const request = server.request();
      expect(request).toBeDefined();
      expect(request?.questions.worker.criteria["luna-high"]).not.toMatch(
        /graded|accepted|rejected|history|recent|comparable/iu,
      );
      return request;
    };

    const successSkew = await capture(["accept", "accept", "accept", "accept"]);
    const empty = await capture([]);
    const inverted = await capture(["reject", "reject", "reject", "reject"]);
    expect(empty).toEqual(successSkew);
    expect(inverted).toEqual(successSkew);
  });

  test("historical Sol 6.1 grades remain auditable and do not enter selection", async () => {
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
    const server = startServer("sol-high");
    expect((await route("generation-isolation replay")).id).toBe("sol-high");
    expect(server.request()?.questions.worker.criteria["sol-high"]).toContain(
      "AA 50",
    );
    expect(server.request()?.questions.worker.criteria["sol-high"]).toContain(
      "TB4 51.5%",
    );
    expect(server.request()?.questions.worker.criteria["sol-high"]).toContain(
      "SciCode 55.8%",
    );
    expect(server.request()?.questions.worker.criteria["sol-high"]).not.toMatch(
      /graded|history|recent|comparable|accepted|rejected/iu,
    );
    expect(
      server.request()?.questions.worker.criteria["sol-high"],
    ).not.toContain("historical Sol 6.1 acceptance");
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
    expect(request?.questions.worker.instructions).toBe(
      `${ROUTING_OBJECTIVE} Pick a roster row for this ticket.`,
    );
    expect(ROUTING_OBJECTIVE).toBe(
      "Purpose: the owner pays for every token and waits for every minute until a result is accepted. Choose the option expected to produce an accepted result for this ticket at the lowest cost and in the shortest time. Evidence: judge each option by its stated use and published benchmarks against what the ticket requires; agx does not feed its own run outcomes back into this choice. Return the ticket instead of choosing a model only when it cannot be done as written. Subscription health: weigh 7-day windows most; 5-hour windows are secondary; keep the intended bias toward the codex route; stale or unknown usage is neutral.",
    );
    expect(request?.questions.worker.instructions).not.toContain(
      "A. Capability sufficiency (hard)",
    );
    expect(request?.questions.worker.criteria["luna-high"]).not.toMatch(
      /graded|history|recent|comparable/iu,
    );
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
    expect(request?.questions.worker.criteria["luna-high"]).toBeDefined();
    expect(request?.questions.worker.criteria["sonnet-high"]).toBeDefined();
    expect(request?.questions.worker.instructions).toContain(ROUTING_OBJECTIVE);
    expect(request?.questions.worker.instructions).toContain(
      "5-hour windows are secondary",
    );
    expect(ROUTING_OBJECTIVE).toContain(
      "keep the intended bias toward the codex route",
    );
    expect(ROUTING_OBJECTIVE).toContain("7-day windows most");
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

  test("th-purge replay rejects luna-medium and sends timeout as task size", async () => {
    await isolateState();
    const server = startServer("luna-medium", {
      "luna-medium": 0.99,
      "sol-low": 0.01,
    });
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
    expect(selected.id).toBe("sol-low");
    expect(server.request()?.state.routes.claude.windows["7d"]?.status).toBe(
      "unknown",
    );
    expect(server.request()?.state.task_size).toEqual({
      timeout_s: 14_400,
      class: "multi-hour",
    });
    expect(
      server.request()?.questions.worker.criteria["luna-medium"],
    ).toBeUndefined();
    expect(server.request()?.questions.worker.criteria["sol-low"]).toContain(
      "TB4 30.8%",
    );
    const criteria = Object.values(
      server.request()?.questions.worker.criteria ?? {},
    );
    const routeBias = [
      ["no", "codex", "row"],
      ["choose", "codex"],
      ["when", "codex", "and", "claude", "rows", "are", "comparable"],
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
      ["sol-low"],
    );
    expect(retry.id).not.toBe("sol-low");
    expect(retry.id).not.toBe("luna-medium");
    appendStarted(retry.id);
  });

  test("the replayed subscription pace sends its numbers and selects Claude", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    installUsage(home, nowMs, 3, 0.94, 45, 0.28);
    const server = startServer("sonnet-high", {
      "sonnet-high": 1,
      "luna-high": 0,
    });

    const selected = await route("comparable routing replay");
    expect(selected.id).toBe("sonnet-high");
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
    expect(request?.questions.worker.criteria["sonnet-high"]).toBeDefined();
    expect(request?.questions.worker.criteria["luna-high"]).toBeDefined();

    const started = appendStarted(selected.id);
    expect(started?.kind).toBe("started");
    const sonnetId = server.wireIds()["sonnet-high"];
    const lunaId = server.wireIds()["luna-high"];
    if (sonnetId === undefined || lunaId === undefined)
      expect.unreachable("fixture wire IDs are missing");
    if (started?.kind === "started")
      expect(started.pick_audit).toMatchObject({
        source: "jev",
        probabilities: {
          [sonnetId]: 1,
          [lunaId]: 0,
        },
      });
  });

  test("a route above its weekly limit is unavailable and its rows are excluded", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    installUsage(home, nowMs, 101, 0.94, 45, 0.28, false);
    const server = startServer("luna-high", { "luna-high": 1 });

    const selected = await route("exclude a capped route");
    expect(selected.route).toBe("codex");
    expect(server.request()?.state.routes.claude.available).toBe(false);
    expect(server.request()?.state.routes.claude.windows["7d"]?.status).toBe(
      "unknown",
    );
    expect(server.request()?.questions.worker.criteria["sonnet-high"]).toBe(
      undefined,
    );
    expect(
      server.request()?.questions.worker.criteria["luna-high"],
    ).toBeDefined();
    appendStarted(selected.id);
  });

  test("stale usage is neutral and does not exclude either route", async () => {
    const { home } = await isolateState();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    installUsage(home, nowMs - 16 * 60 * 1000, 100, 0.94, 45, 0.28);
    const server = startServer("sonnet-high", { "sonnet-high": 1 });

    const selected = await route("stale usage replay");
    expect(selected.route).toBe("claude");
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
      expect(started.pick_audit?.source).toBe("fallback-ineligible-choice");
      expect(started.pick_audit?.probabilities).toEqual({
        "not-a-roster-row": 1,
      });
      expect(started.pick_audit?.usage_snapshot).toMatchObject(
        server.request()?.state.routes ?? {},
      );
    }
  });
});

test("fresh Sol 6.1 choice records the restored model and sourced criteria", async () => {
  await isolateState();
  const server = startServer("sol-high", { "sol-high": 1 });
  const picked = await route("fresh generation probe");
  expect(picked).toMatchObject({ id: "sol-high", model: "gpt-6.1-sol" });
  const criteria = server.request()?.questions.worker.criteria ?? {};
  expect(
    Object.keys(criteria).filter((id) => id.startsWith("sol-")),
  ).toHaveLength(5);
  expect(criteria["sol-high"]).toContain("AA 50");
  expect(criteria["sol-high"]).toContain("TB4 51.5%");
  expect(criteria["sol-high"]).toContain("SciCode 55.8%");
  expect(criteria["sol-high"]).not.toMatch(
    /graded|history|recent|comparable|accepted|rejected/iu,
  );
  expect(Object.keys(criteria).filter((id) => id.startsWith("sol6-"))).toEqual(
    [],
  );
});

test("retired Sol 6.0 Jev IDs are ineligible and never point to the 6.1 rows", async () => {
  await isolateState();
  const server = startServer("sol6-high", { "sol6-high": 1 });
  const picked = await route("retired generation probe");
  expect(picked.id).not.toBe("sol6-high");
  expect(picked.model).not.toBe("gpt-6-sol");
  const criteria = server.request()?.questions.worker.criteria ?? {};
  expect(criteria["sol6-high"]).toBeUndefined();
  expect(criteria["sol-high"]).toContain("AA 50, TB4 51.5%");
});
for (const capability of ["terminal-agentic", "long-tool-loop"]) {
  test(`all restored Sol 6.1 efforts meet ${capability} eligibility`, async () => {
    await isolateState();
    const server = startServer("sol-xhigh", { "sol-xhigh": 1 });
    expect((await route("terminal probe", [capability])).id).toBe("sol-xhigh");
    const criteria = server.request()?.questions.worker.criteria ?? {};
    expect(
      Object.keys(criteria)
        .filter((id) => id.startsWith("sol-"))
        .toSorted(),
    ).toEqual(["sol-high", "sol-low", "sol-max", "sol-medium", "sol-xhigh"]);
    expect(criteria["sol-low"]).toContain("TB4 30.8%");
    expect(criteria["sol-max"]).toContain("TB4 56.1%");
  });
}
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

test("one raw Choice blinds the entire injected payload and preserves every criterion in order", async () => {
  await isolateState();
  const loaded = await loadRoster();
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const roster = loaded.value;
  const server = startServer("sol-medium", { "sol-medium": 1 });
  const task = "User task mentions sol-medium and high effort verbatim";
  const selected = await route(task, ["sol-high", "xhigh"]);
  const request = server.rawRequest();
  expect(request).toBeDefined();
  if (request === undefined) return;
  expect(request.state.task).toBe(task);
  const rawBody = server.rawBody();
  expect(rawBody).toBeDefined();
  if (rawBody === undefined) return;
  // Scan the exact HTTP body; only the user task value is exempt.
  const injected = rawBody.replace(
    JSON.stringify(task),
    JSON.stringify("[user task omitted]"),
  );
  expect(injected).not.toContain("anonymization_map");
  for (const row of roster.choice) {
    expect(injected.toLowerCase()).not.toContain(row.id.toLowerCase());
    expect(injected.toLowerCase()).not.toContain(row.model.toLowerCase());
    const family = row.id.split("-")[0];
    if (family === undefined) expect.unreachable(`row ${row.id} has no family`);
    expect(injected).not.toMatch(new RegExp(`\\b${family}\\b`, "iu"));
    for (const version of row.model.match(/\d+(?:[.-]\d+)+/gu) ?? [])
      expect(injected).not.toMatch(
        new RegExp(
          `(?<![\\d.])${version.replaceAll(".", "\\.")}(?![\\d.])`,
          "u",
        ),
      );
  }
  expect(injected).not.toMatch(/\b(low|medium|high|xhigh|max|effort)\b/iu);
  expect(Object.keys(request.questions)).toEqual(["worker"]);
  const ordered = roster.choice.toSorted(
    (a, b) =>
      ["low", "medium", "high", "xhigh", "max"].indexOf(a.effort) -
      ["low", "medium", "high", "xhigh", "max"].indexOf(b.effort),
  );
  expect(Object.keys(request.questions.worker.criteria)).toEqual([
    ...ordered.map((_, i) => `model_${i}`),
    "split",
    "uncheckable",
    "contradiction",
    "missing_input",
  ]);
  ordered.forEach((row, i) => {
    expect(request.questions.worker.criteria[`model_${i}`]).toBe(
      blindCriterion(criterionFor(roster, row), roster.choice),
    );
  });
  expect(server.calls()).toBe(1);
  const started = appendStarted(selected.id);
  expect(started?.kind).toBe("started");
  const solMediumId = server.wireIds()["sol-medium"];
  if (solMediumId === undefined)
    expect.unreachable("sol-medium fixture wire ID is missing");
  if (started?.kind === "started")
    expect(started.pick_audit).toMatchObject({
      answer: { choice: solMediumId },
      probabilities: { [solMediumId]: 1 },
      anonymization_map: Object.fromEntries(
        ordered.map((row, i) => [`model_${i}`, row.id]),
      ),
    });
});

for (const reason of [
  "split",
  "uncheckable",
  "contradiction",
  "missing_input",
]) {
  test(`return ${reason} exits 2, records the answer and never reaches worker startup`, async () => {
    const { root } = await isolateState();
    const server = startServer(reason, { [reason]: 1, model_0: 0 });
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {route} from ${JSON.stringify(new URL("../../src/next/route.ts", import.meta.url).pathname)}; await route("return fixture"); await Bun.write(${JSON.stringify(join(root, "worker-started"))}, "started");`,
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
    expect(stderr).toContain(`ticket returned: ${reason}`);
    expect(stderr).toContain("Fix:");
    expect(await Bun.file(join(root, "worker-started")).exists()).toBe(false);
    expect(server.calls()).toBe(1);
    const parsedRecord = jsonOf(
      z.object({
        reason: z.string(),
        pick_audit: z.object({
          answer: z.object({ choice: z.string() }),
          probabilities: z.record(z.string(), z.number()),
          anonymization_map: z.record(z.string(), z.string()),
        }),
      }),
    ).safeParse(
      await readFile(join(root, "state", "routing-refusals.jsonl"), "utf8"),
    );
    expect(parsedRecord.success).toBe(true);
    if (!parsedRecord.success) return;
    const record = parsedRecord.data;
    expect(record.reason).toBe(reason);
    expect(record.pick_audit.answer.choice).toBe(reason);
    expect(record.pick_audit.probabilities[reason]).toBe(1);
    expect(record.pick_audit.anonymization_map.model_0).toBeDefined();
  });
}

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

test("local record evidence stays in the pick audit and out of Jev criteria", async () => {
  await isolateState();
  const fixture = (row: string, count: number, accepted: number) => {
    for (let i = 0; i < count; i++) {
      const started = appendStarted(row);
      if (started?.kind !== "started") return;
      append({
        kind: "ended",
        id: started.id,
        at: Temporal.Instant.from(started.at).add({ seconds: 306 }).toString(),
        exit: 0,
        report_path: null,
        vendor_session: null,
        verify: [],
      });
      append({
        kind: "judged",
        id: started.id,
        at: now(),
        decision: i < accepted ? "accept" : "reject",
        note: "fixture",
      });
      // A later judgment replaces the previous one, rather than adding a run.
      if (i === 0)
        append({
          kind: "judged",
          id: started.id,
          at: now(),
          decision: "accept",
          note: "rejudged fixture",
        });
    }
  };
  fixture("luna-high", 25, 21);
  fixture("sol-medium", 5, 3);
  fixture("luna-medium", 4, 4);
  const stale = appendStarted("luna-high");
  if (stale?.kind !== "started") return;
  append({
    kind: "ended",
    id: stale.id,
    at: Temporal.Instant.from(stale.at).add({ seconds: 86401 }).toString(),
    exit: 0,
    report_path: null,
    vendor_session: null,
    verify: [],
  });
  append({
    kind: "started",
    id: "running-fixture",
    at: now(),
    ticket: "running",
    writes: [],
    cwd: tmpdir(),
    workspace: tmpdir(),
    row: "luna-high",
    dispatcher_session: null,
    vendor_session: null,
    pid: process.pid,
  }); // Running records have no wall time.
  const server = startServer("luna-high");
  const selected = await route("local evidence fixture");
  const request = server.request();
  if (request === undefined)
    expect.unreachable("route request was not captured");
  const criteria = request.questions.worker.criteria;
  expect(criteria["luna-high"]).toBeDefined();
  expect(criteria["sol-medium"]).toBeDefined();
  expect(criteria["luna-medium"]).toBeDefined();
  const loaded = await loadRoster();
  if (!loaded.ok) return;
  const rawRequest = server.rawRequest();
  if (rawRequest === undefined)
    expect.unreachable("raw route request was not captured");
  for (const text of Object.values(rawRequest.questions.worker.criteria)) {
    expect(text).not.toContain("agx measured");
    for (const row of loaded.value.choice) expect(text).not.toContain(row.id);
  }
  expect(request.questions.worker.instructions).toContain(
    "at the lowest cost and in the shortest time",
  );
  expect(request.questions.worker.instructions).toContain(
    "published benchmarks against what the ticket requires",
  );
  expect(request.questions.worker.instructions).toContain(
    "agx does not feed its own run outcomes back into this choice",
  );
  expect(request.questions.worker.instructions).not.toContain(
    "A. Capability sufficiency (hard)",
  );
  const picked = appendStarted(selected.id);
  if (picked?.kind !== "started") return;
  const lunaId = server.wireIds()["luna-high"];
  if (lunaId === undefined)
    expect.unreachable("luna-high fixture wire ID is missing");
  expect(picked.pick_audit?.measured_evidence?.[lunaId]).toEqual({
    judged_runs: 25,
    accepted_runs: 21,
    accepted_percent: 84,
    ended_runs: 25,
    median_wall_minutes: 5.1,
    text: "agx measured: 84% of 25 judged runs accepted, median 5.1 min.",
  });
});

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
});
test("audit retains the exact request and replays the existing sampling guard", async () => {
  await isolateState();
  const server = startServer("sol-medium", {
    "sol-medium": 0.36,
    "sonnet-high": 0.32,
    "sol-high": 0.32,
  });
  const selected = await route("x".repeat(3000), ["terminal-agentic"], 900, [
    "sol-low",
  ]);
  const journal = routingEvents();
  const decision = journal.events.at(-1);
  const audit = decision?.audit;
  expect(audit?.input).toEqual(server.rawRequest());
  expect(audit?.input_sha256).toBe(
    createHash("sha256")
      .update(server.rawBody() ?? "")
      .digest("hex"),
  );
  expect(audit?.input_truncated).toBe(true);
  expect(audit?.timeout_class).toBe("extended");
  expect(audit?.capability_tags).toEqual(["terminal-agentic"]);
  expect(audit?.filters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "masked",
        removed: [{ row: "sol-low", detail: null }],
      }),
    ]),
  );
  expect(audit?.top_margin).toBeCloseTo(0.04);
  const replay = z
    .object({
      choice_probabilities: z.record(z.string(), z.number()),
      pick_temperature: z.number(),
      sampling_seed: z.string(),
    })
    .safeParse(audit);
  expect(replay.success).toBe(true);
  if (!replay.success) return;
  expect(
    sampleRow(
      replay.data.choice_probabilities,
      replay.data.pick_temperature,
      replay.data.sampling_seed,
    )?.row,
  ).toBe(
    Object.entries(server.wireIds()).find(([id]) => id === selected.id)?.[1],
  );
  const started = appendStarted(selected.id);
  if (started?.kind === "started")
    expect(started.pick_audit?.audit).toEqual(audit);
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

for (const choice of ["sol-medium", "not-a-row"]) {
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
    expect(decision?.audit?.raw_reply).toContain(
      choice === "sol-medium" ? "model_" : choice,
    );
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
