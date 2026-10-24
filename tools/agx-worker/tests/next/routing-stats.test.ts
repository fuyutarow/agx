import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { statsWindow } from "../../src/next/stats-window.ts";
import { writeUsageSnapshot } from "./usage-snapshot.fixture.ts";

const roots: string[] = [];
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
  const { env } = fixture();
  for (const stale of [false, true]) {
    const measured =
      Temporal.Now.instant().epochMilliseconds - (stale ? 3_600_000 : 0);
    expect(
      writeUsageSnapshot(
        {
          rl7: 100,
          rl7Reset: Temporal.Now.instant().epochMilliseconds / 1000 + 86400,
        },
        measured / 1000,
        env,
      ),
    ).toBe(true);
    const data = report(stats(env));
    expect(data.routes.claude.subscription?.usage_status).toBe(
      stale ? "stale" : "fresh",
    );
    expect(data.routes.claude.state).toBe(stale ? "unknown" : "unavailable");
    expect(data.routes.claude.subscription?.available).toBe(stale);
  }
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
    fetch: async (request) => {
      const parsed = jsonOf(
        z.object({
          questions: z.object({
            worker: z.object({ criteria: z.record(z.string(), z.string()) }),
          }),
        }),
      ).safeParse(await request.text());
      const choice = parsed.success
        ? Object.entries(parsed.data.questions.worker.criteria).find(
            ([, text]) => text.includes("AA 33,"),
          )?.[0]
        : undefined;
      return Response.json({ answers: { worker: { choice } } });
    },
  });
  await using _cleanup = { [Symbol.asyncDispose]: () => server.stop(true) };
  {
    const ticket = join(root, "ticket.md");
    writeFileSync(
      ticket,
      '+++\nschema = 2\noutcome = "fixture"\n[proposition]\nid = "P"\nclaim = "fixture"\nrefuted_by = "failure"\n+++\nFixture selection.\n',
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
    expect(out).toContain("luna-high");
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
