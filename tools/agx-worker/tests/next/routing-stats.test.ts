import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { statsWindow } from "../../src/next/stats-window.ts";
import { writeUsageSnapshot } from "./usage-snapshot.fixture.ts";

const roots: string[] = [];
const FIRST_NOW_MS = Temporal.Instant.from(
  "2026-10-26T00:00:00Z",
).epochMilliseconds;
const SECOND_NOW_MS = Temporal.Instant.from(
  "2026-10-26T00:01:00Z",
).epochMilliseconds;
const usageReader = fileURLToPath(
  new URL("./fixtures/subscription-usage-reader.ts", import.meta.url),
);
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-routing-stats-"));
  roots.push(root);
  for (const dir of ["bin", "state", "home"]) mkdirSync(join(root, dir));
  symlinkSync(
    resolve("tools/agx-worker/src/next/cli.ts"),
    join(root, "bin/agx-worker"),
  );
  // Presence fixtures are never executed by stats.
  for (const name of ["codex", "claude"])
    writeFileSync(join(root, "bin", name), "", { mode: 0o700 });
  writeFileSync(
    join(root, "policy.toml"),
    readFileSync(
      "tools/agx-worker/src/roster/policy.example.toml",
      "utf8",
    ).replace('allow = ["codex"]', 'allow = ["codex", "claude"]'),
  );
  const env = {
    ...process.env,
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg"),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    AGX_CONFIG: join(root, "policy.toml"),
    TYPESAFE_API_KEY: "fixture-not-a-secret",
    PATH: `${join(root, "bin")}:${dirname(process.execPath)}`,
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  Reflect.deleteProperty(env, "JEV_URL");
  return { root, env };
};
const usageFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-subscription-clock-"));
  roots.push(root);
  const decoyHome = join(root, "decoy-home");
  mkdirSync(join(root, ".codex", "sessions"), { recursive: true });
  mkdirSync(join(decoyHome, ".codex", "sessions"), { recursive: true });
  return { home: root, decoyHome, env: { HOME: root } };
};
const usageAt = (home: string, ambientHome: string, nowMs: number) =>
  Bun.spawnSync([process.execPath, usageReader], {
    env: {
      HOME: ambientHome,
      AGX_SUBSCRIPTION_TEST_HOME: home,
      AGX_SUBSCRIPTION_TEST_NOW_MS: String(nowMs),
    },
    timeout: 5_000,
  });
const writeDecoyCodexRollout = (home: string, nowMs: number) => {
  const path = join(home, ".codex", "sessions", "rollout-decoy.jsonl");
  const measuredAt = nowMs - 30_000;
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: Temporal.Instant.fromEpochMilliseconds(measuredAt).toString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: {
            used_percent: 99,
            window_minutes: 10080,
            resets_at: nowMs / 1000 + 86400,
          },
        },
      },
    })}\n`,
  );
  utimesSync(path, measuredAt / 1000, measuredAt / 1000);
};
const args = [process.execPath, "tools/agx/src/agx.ts", "worker"];
const stats = (
  env: NodeJS.ProcessEnv,
  extra = ["--routing", "--window", "24h"],
) => Bun.spawnSync([...args, "stats", ...extra], { env, timeout: 15_000 });
const Route = z.object({
  state: z.enum(["unknown", "unavailable"]),
  executable: z.string(),
  sandbox: z.literal("unknown"),
  subscription: z
    .object({ available: z.boolean(), usage_status: z.string() })
    .nullable(),
});
const Report = jsonOf(
  z.object({
    schema: z.literal(1),
    host: z.string(),
    observation: z.object({
      start: z.string(),
      end: z.string(),
      duration_ms: z.number(),
    }),
    jev: z.object({
      pick_count: z.number(),
      denominator: z.number(),
      codex_pick_count: z.number(),
      codex_share: z.number().nullable(),
    }),
    fallback_count: z.number(),
    routes: z.object({ codex: Route, claude: Route }),
    coverage: z.object({
      status: z.literal("partial"),
      history_complete: z.literal(false),
      legacy: z.literal("unknown"),
      journal_present: z.boolean(),
      trailing_partial_record: z.boolean(),
    }),
  }),
);
const report = (result: ReturnType<typeof stats>) => {
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const parsed = Report.safeParse(result.stdout.toString());
  expect(parsed.success).toBe(true);
  if (!parsed.success) return process.exit(1);
  return parsed.data;
};

const event = (
  hoursAgo: number,
  route = "codex",
  host = hostname(),
  source = "jev",
) => ({
  schema: 1,
  at: Temporal.Instant.fromEpochMilliseconds(
    Temporal.Now.instant().epochMilliseconds - hoursAgo * 3_600_000,
  ).toString(),
  host,
  row: "fixture",
  route,
  source,
});

test("stats contract: designed selections are not counted as fallback", () => {
  const { root, env } = fixture();
  writeFileSync(join(root, "state/routing.jsonl"), [
    { ...event(1, "codex", hostname(), "jev-classified"), audit: { selection_mode: "class" } },
    { ...event(1, "codex", hostname(), "fallback-missing-answer"), audit: { selection_mode: "fallback" } },
    { ...event(1, "codex", hostname(), "fallback-invalid-class"), audit: { selection_mode: "fallback" } },
    { ...event(1), row: null, route: null, outcome: "refusal" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = stats(env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = jsonOf(z.object({
    selection_count: z.number(),
    selection_mode_counts: z.record(z.string(), z.number()),
    fallback_count: z.number(),
    per_row_pick_counts: z.record(z.string(), z.number()),
  })).safeParse(result.stdout.toString());
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.selection_count).toBe(4);
  expect(parsed.data.selection_mode_counts).toEqual({ class: 1, "fallback-missing-answer": 1, "fallback-invalid-class": 1, refusal: 1 });
  expect(parsed.data.fallback_count).toBe(2);
  expect(parsed.data.per_row_pick_counts).toEqual({ fixture: 3 });
});

test("public CLI filters window and host, with Jev denominator excluding fallbacks", () => {
  const { root, env } = fixture();
  writeFileSync(
    join(root, "state/routing.jsonl"),
    [
      event(1),
      event(2, "claude"),
      event(25),
      event(-1),
      event(1, "codex", "other-host"),
      event(1, "codex", hostname(), "fallback-request-failed"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const before = readFileSync(join(root, "state/routing.jsonl"), "utf8");
  const data = report(stats(env));
  expect(data.host).toBe(hostname());
  expect(
    Temporal.Instant.from(data.observation.end).epochMilliseconds -
      Temporal.Instant.from(data.observation.start).epochMilliseconds,
  ).toBe(86_400_000);
  expect(data.jev).toEqual({
    pick_count: 2,
    denominator: 2,
    codex_pick_count: 1,
    codex_share: 0.5,
  });
  expect(data.fallback_count).toBe(1);
  expect(data.coverage.history_complete).toBe(false);
  expect(readFileSync(join(root, "state/routing.jsonl"), "utf8")).toBe(before);
  const remote = report(
    stats(env, ["--routing", "--host", "other-host", "--window", "24h"]),
  );
  expect(remote.jev.codex_share).toBe(1);
  expect(remote.jev.denominator).toBe(1);
  expect(remote.routes.codex.subscription).toBeNull();
  expect(remote.routes.codex.state).toBe("unknown");
});

test("empty history has null share and unknown subscription is not capability failure", () => {
  const { env } = fixture();
  const data = report(stats(env));
  expect(data.jev).toEqual({
    pick_count: 0,
    denominator: 0,
    codex_pick_count: 0,
    codex_share: null,
  });
  expect(data.coverage.journal_present).toBe(false);
  expect(data.routes.codex.subscription?.usage_status).toBe("unknown");
  expect(data.routes.codex.subscription?.available).toBe(true);
  expect(data.routes.codex.state).toBe("unknown");
});

test("subscription freshness and exhaustion stay separate from capability", () => {
  const { home, env, decoyHome } = usageFixture();
  for (const stale of [false, true]) {
    const measured = FIRST_NOW_MS - (stale ? 3_600_000 : 60_000);
    const reset = FIRST_NOW_MS / 1000 + 86400;
    expect(
      writeUsageSnapshot({ rl7: 100, rl7Reset: reset }, measured / 1000, env),
    ).toBe(true);
    expect(
      writeUsageSnapshot(
        {
          rl7: stale ? 0 : 100,
          rl7Reset: reset,
        },
        (FIRST_NOW_MS - (stale ? 60_000 : 3_600_000)) / 1000,
        { HOME: decoyHome },
      ),
    ).toBe(true);
    writeDecoyCodexRollout(decoyHome, FIRST_NOW_MS);

    const result = usageAt(home, decoyHome, FIRST_NOW_MS);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(
      `${JSON.stringify({
        status: stale ? "stale" : "fresh",
        exhausted: !stale,
        available: stale,
        codexSource: "no fresh Codex rollout source",
      })}\n`,
    );
  }
});

test("timing contract: subscription clock", () => {
  const { home, env, decoyHome } = usageFixture();
  const measured = FIRST_NOW_MS - 60_000;
  expect(
    writeUsageSnapshot(
      {
        rl7: 100,
        rl7Reset: FIRST_NOW_MS / 1000 + 86400,
      },
      measured / 1000,
      env,
    ),
  ).toBe(true);
  expect(
    writeUsageSnapshot(
      {
        rl7: 0,
        rl7Reset: FIRST_NOW_MS / 1000 + 86400,
      },
      measured / 1000,
      { HOME: decoyHome },
    ),
  ).toBe(true);
  writeDecoyCodexRollout(decoyHome, FIRST_NOW_MS);

  const expected = `${JSON.stringify({
    status: "fresh",
    exhausted: true,
    available: false,
    codexSource: "no fresh Codex rollout source",
  })}\n`;
  const verdicts = [FIRST_NOW_MS, SECOND_NOW_MS].map((nowMs) => {
    const result = usageAt(home, decoyHome, nowMs);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
    return result.stdout.toString();
  });
  expect(verdicts).toEqual([expected, expected]);
});

test("incomplete journal tail is explicit, malformed complete rows fail collection", () => {
  const { root, env } = fixture();
  const path = join(root, "state/routing.jsonl");
  writeFileSync(path, `${JSON.stringify(event(1))}\n{"schema":`);
  const data = report(stats(env));
  expect(data.jev.denominator).toBe(1);
  expect(data.coverage.trailing_partial_record).toBe(true);
  writeFileSync(path, "invalid\n");
  const invalid = stats(env);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stdout.toString()).toBe("");
  expect(invalid.stderr.toString()).toContain(
    "cannot collect routing statistics",
  );
});

test("stats rejects invalid windows and incompatible flags", () => {
  const { env } = fixture();
  for (const extra of [
    ["--routing", "--window", "0h"],
    ["--routing", "--window", "NaN"],
    ["--window", "24h"],
    ["--host", "example"],
    ["--routing", "--host", " "],
    ["--routing", "--import-legacy"],
    ["--routing", "unexpected"],
  ]) {
    expect(stats(env, extra).exitCode).toBe(2);
  }
  expect(stats(env, ["--help"]).stdout.toString()).toContain("--routing");
});

test("shared window parser produces exact half-open bounds", () => {
  expect(statsWindow("24h", 100_000_000)).toEqual({
    startMs: 13_600_000,
    endMs: 100_000_000,
    durationMs: 86_400_000,
  });
  expect(statsWindow("1m", 100_000)).toEqual({
    startMs: 40_000,
    endMs: 100_000,
    durationMs: 60_000,
  });
  for (const value of ["-1h", "0d", "1.5h", "999999999999999999d"])
    expect(statsWindow(value, 100_000)).toBeNull();
});

test("real roster CLI selections are persisted before any worker starts", async () => {
  const { root, env } = fixture();
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ answers: { worker: { choice: "mechanical" } } }),
  });
  await using _cleanup = { [Symbol.asyncDispose]: () => server.stop(true) };
  {
    const ticket = join(root, "ticket.md");
    writeFileSync(
      ticket,
      '+++\nschema = 2\nwrites = []\noutcome = "fixture"\n[proposition]\nid = "P"\nclaim = "fixture"\nrefuted_by = "failure"\n+++\nFixture selection.\n',
    );
    const child = Bun.spawn([...args, "roster", ticket], {
      env: { ...env, JEV_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, err).toBe(0);
    expect(out).toContain("luna-low");
    const data = report(stats(env));
    expect(data.jev.denominator).toBe(1);
    expect(data.jev.codex_share).toBe(1);
    // A valid HTTP response without a choice produces a persisted fallback, not a Jev pick.
    server.reload({ fetch: () => Response.json({ answers: {} }) });
    const fallback = Bun.spawn([...args, "roster", ticket], {
      env: { ...env, JEV_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [, fallbackErr, fallbackExit] = await Promise.all([
      new Response(fallback.stdout).text(),
      new Response(fallback.stderr).text(),
      fallback.exited,
    ]);
    expect(fallbackExit, fallbackErr).toBe(0);
    const after = report(stats(env));
    expect(after.jev.denominator).toBe(1);
    expect(after.fallback_count).toBe(1);
  }
});

test("audit statistics count rows and margins independently of refusals and launch failures", () => {
  const { root, env } = fixture();
  const pick = {
    ...event(1),
    audit: { top_margin: 0.04, tb4_removed_all_luna: true },
  };
  writeFileSync(
    join(root, "state/routing.jsonl"),
    [
      pick,
      { ...pick, source: "fallback-invalid-response" },
      { ...pick, row: null, route: null, outcome: "refusal" },
      { ...pick, row: null, route: null, outcome: "pre-start failure" },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const result = stats(env, ["--routing", "--json", "--window", "24h"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = jsonOf(
    z.object({
      per_row_pick_counts: z.record(z.string(), z.number()),
      top1_minus_top2_margins: z.object({
        count: z.number(),
        values: z.array(z.number()),
        unknown: z.number(),
      }),
      tb4_removed_all_luna_pick_count: z.number(),
      refusal_count: z.number(),
      pre_start_failure_count: z.number(),
    }),
  ).safeParse(result.stdout.toString());
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.per_row_pick_counts).toEqual({ [pick.row]: 2 });
  expect(parsed.data.top1_minus_top2_margins).toEqual({
    count: 1,
    values: [0.04],
    unknown: 0,
  });
  expect(parsed.data.tb4_removed_all_luna_pick_count).toBe(2);
  expect(parsed.data.refusal_count).toBe(1);
  expect(parsed.data.pre_start_failure_count).toBe(1);
});
