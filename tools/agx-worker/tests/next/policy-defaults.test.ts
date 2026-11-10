import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";
import { loadRoster } from "../../src/roster/index.ts";
import {
  POLICY_DEFAULTS,
  POLICY_KEYS,
} from "../../src/roster/policy-defaults.ts";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const examplePath = new URL(
  "../../src/roster/policy.example.toml",
  import.meta.url,
).pathname;
const fullFixture = new URL("./fixtures/roster-pricing.toml", import.meta.url)
  .pathname;

const roots: string[] = [];
const saved = {
  AGX_CONFIG: Bun.env.AGX_CONFIG,
  XDG_CONFIG_HOME: Bun.env.XDG_CONFIG_HOME,
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agx-policy-defaults-"));
  roots.push(root);
  return root;
}

/** A temp XDG_CONFIG_HOME; the default policy path sits under it. */
async function xdgWith(contents: string | undefined) {
  const root = await tempRoot();
  const configHome = join(root, "config");
  const policyPath = join(configHome, "agx", "agx.toml");
  if (contents !== undefined) {
    await mkdir(join(configHome, "agx"), { recursive: true });
    await writeFile(policyPath, contents, "utf8");
  }
  Bun.env.XDG_CONFIG_HOME = configHome;
  delete Bun.env.AGX_CONFIG;
  return { root, configHome, policyPath };
}

const emptyRepo = async () => {
  const dir = join(await tempRoot(), "repo");
  await mkdir(dir, { recursive: true });
  return dir;
};

beforeEach(() => {
  delete Bun.env.AGX_CONFIG;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("an empty schema = 1 file loads with every shipped default", async () => {
  const { policyPath } = await xdgWith("schema = 1\n");
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.policy.source).toBe(`file:${policyPath}`);
  expect(Object.keys(loaded.policy.keys)).toEqual([...POLICY_KEYS]);
  expect(Object.values(loaded.policy.keys).every((v) => v === "default")).toBe(
    true,
  );
  const { auto, claude_run } = loaded.value;
  expect(auto.max_task_chars).toBe(6000);
  expect(auto.timeout_ms).toBe(20000);
  expect(auto.pick_temperature).toBe(0);
  expect(auto.routes).toEqual(["claude", "codex"]);
  expect(auto).not.toHaveProperty("no_egress");
  expect(auto.on_window_exhausted).toEqual({
    codex: "continue",
    claude: "stop",
  });
  expect(auto.jev).toMatchObject({
    api: "typesafe",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
  });
  expect(claude_run).toEqual(POLICY_DEFAULTS.claude_run);
});

test("an absent default policy file loads defaults with source defaults", async () => {
  await xdgWith(undefined);
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.policy.source).toBe("defaults");
  expect(Object.values(loaded.policy.keys).every((v) => v === "default")).toBe(
    true,
  );
  expect(loaded.value.auto.pick_temperature).toBe(0);
});

test("a missing explicit AGX_CONFIG or library path still fails", async () => {
  const { root } = await xdgWith(undefined);
  Bun.env.AGX_CONFIG = join(root, "absent.toml");
  const viaEnv = await loadRoster({ repoRoot: await emptyRepo() });
  expect(viaEnv.ok).toBe(false);
  if (!viaEnv.ok) expect(viaEnv.error).toContain("cannot read policy");
  delete Bun.env.AGX_CONFIG;
  const viaOption = await loadRoster({
    policyPath: join(root, "absent.toml"),
    repoRoot: await emptyRepo(),
  });
  expect(viaOption.ok).toBe(false);
  if (!viaOption.ok) expect(viaOption.error).toContain("cannot read policy");
});

test("an invalid default policy file fails rather than using defaults", async () => {
  await xdgWith("schema = 1\n[route]\nbogus = 1\n");
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(false);
});

test("unknown keys, wrong types and out-of-range values still fail", async () => {
  for (const body of [
    "schema = 1\nextra = 1\n",
    "schema = 1\n[route]\nbogus = 1\n",
    "schema = 1\n[claude_run]\nbogus = 1\n",
    "schema = 1\n[route.jev]\nbogus = 1\n",
    "schema = 1\n[route]\npick_temperature = 6\n",
    'schema = 1\n[route]\ntimeout_ms = "slow"\n',
    "schema = 1\n[claude_run]\nmax_budget_usd = 0\n",
    'schema = 1\n[claude_run]\nreason = "short"\n',
    'schema = 1\n[route]\ndefault = "luna-high"\n',
    "schema = 2\n",
  ]) {
    await xdgWith(body);
    const loaded = await loadRoster({ repoRoot: await emptyRepo() });
    expect(loaded.ok, body).toBe(false);
  }
});

test("a file setting only pick_temperature and max_budget_usd keeps the other defaults", async () => {
  await xdgWith(
    "schema = 1\n[route]\npick_temperature = 1.5\n[claude_run]\nmax_budget_usd = 5\n",
  );
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const { auto, claude_run } = loaded.value;
  expect(auto.pick_temperature).toBe(1.5);
  expect(auto.max_task_chars).toBe(6000);
  expect(auto.timeout_ms).toBe(20000);
  expect(claude_run).toEqual({
    ...POLICY_DEFAULTS.claude_run,
    max_budget_usd: 5,
  });
  expect(loaded.policy.keys).toMatchObject({
    "route.pick_temperature": "file",
    "claude_run.max_budget_usd": "file",
    "route.max_task_chars": "default",
    "claude_run.max_turns": "default",
    "route.jev": "default",
  });
});

test("a table naming one vendor in on_window_exhausted keeps the shipped default for the other", async () => {
  await xdgWith(
    'schema = 1\n[route]\non_window_exhausted = { codex = "stop" }\n',
  );
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.auto.on_window_exhausted).toEqual({
    codex: "stop",
    claude: POLICY_DEFAULTS.route.on_window_exhausted.claude,
  });
  expect(loaded.value.auto.on_window_exhausted?.claude).toBe("stop");
  expect(loaded.policy.keys["route.on_window_exhausted.codex"]).toBe("file");
  expect(loaded.policy.keys["route.on_window_exhausted.claude"]).toBe(
    "default",
  );
  expect(Object.keys(loaded.policy.keys)).toEqual([...POLICY_KEYS]);

  await xdgWith(
    'schema = 1\n[route]\non_window_exhausted = { claude = "continue" }\n',
  );
  const other = await loadRoster({ repoRoot: await emptyRepo() });
  expect(other.ok).toBe(true);
  if (!other.ok) return;
  expect(other.value.auto.on_window_exhausted).toEqual({
    codex: "continue",
    claude: "continue",
  });
  expect(other.policy.keys["route.on_window_exhausted.codex"]).toBe("default");
  expect(other.policy.keys["route.on_window_exhausted.claude"]).toBe("file");
});

test("a table naming both vendors in on_window_exhausted keeps both from the file", async () => {
  await xdgWith(
    'schema = 1\n[route]\non_window_exhausted = { codex = "stop", claude = "continue" }\n',
  );
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.auto.on_window_exhausted).toEqual({
    codex: "stop",
    claude: "continue",
  });
  expect(loaded.policy.keys["route.on_window_exhausted.codex"]).toBe("file");
  expect(loaded.policy.keys["route.on_window_exhausted.claude"]).toBe("file");
});

test("a partial route.jev overlays the shipped endpoint; another api brings its own url", async () => {
  await xdgWith('schema = 1\n[route.jev]\nmodel = "jev-pinned"\n');
  const partial = await loadRoster({ repoRoot: await emptyRepo() });
  expect(partial.ok).toBe(true);
  if (partial.ok)
    expect(partial.value.auto.jev).toMatchObject({
      api: "typesafe",
      url: POLICY_DEFAULTS.route.jev.url,
      model: "jev-pinned",
    });
  await xdgWith('schema = 1\n[route.jev]\napi = "reseller"\n');
  const noUrl = await loadRoster({ repoRoot: await emptyRepo() });
  expect(noUrl.ok).toBe(false);
});

test("the current full policy file shape and the shipped example still load unchanged", async () => {
  for (const path of [fullFixture, examplePath]) {
    const loaded = await loadRoster({
      policyPath: path,
      repoRoot: await emptyRepo(),
    });
    expect(loaded.ok, path).toBe(true);
    if (!loaded.ok) continue;
    expect(loaded.policy.source).toBe(`file:${path}`);
    expect(
      Object.values(loaded.policy.keys).every(
        (v) => v === "file" || v === "default",
      ),
    ).toBe(true);
    expect(loaded.policy.keys["route.max_task_chars"]).toBe("file");
    expect(loaded.policy.keys).not.toHaveProperty("route.no_egress");
    expect(loaded.value.auto).toMatchObject({
      max_task_chars: 6000,
      timeout_ms: 20000,
      pick_temperature: 0.5,
    });
  }
  const rawResult = z
    .looseObject({
      route: z.looseObject({
        max_task_chars: z.number(),
        timeout_ms: z.number(),
        jev: z.looseObject({ url: z.string(), model: z.string() }),
      }),
      claude_run: z.looseObject({
        max_budget_usd: z.number(),
        max_turns: z.number(),
        reason: z.string(),
      }),
    })
    .safeParse(Bun.TOML.parse(await readFile(examplePath, "utf8")));
  expect(rawResult.success).toBe(true);
  if (!rawResult.success) return;
  const raw = rawResult.data;
  // Shipped defaults equal the example, apart from allow and pick_temperature.
  expect(raw.route.max_task_chars).toBe(POLICY_DEFAULTS.route.max_task_chars);
  expect(raw.route.timeout_ms).toBe(POLICY_DEFAULTS.route.timeout_ms);
  expect(raw.route.jev.url).toBe(POLICY_DEFAULTS.route.jev.url);
  expect(raw.route.jev.model).toBe(POLICY_DEFAULTS.route.jev.model);
  expect(raw.claude_run).toEqual(POLICY_DEFAULTS.claude_run);
});

const RosterJson = z.looseObject({
  schema: z.literal(1),
  as_of: z.iso.date(),
  auto: z.looseObject({ pick_temperature: z.number() }),
  claude_run: z.looseObject({ max_turns: z.number() }),
  sources: z.record(z.string(), z.url()),
  choice: z.array(z.looseObject({ id: z.string() })),
  objective: z.string(),
  policy: z.object({
    source: z.string(),
    keys: z.record(z.string(), z.enum(["file", "default"])),
  }),
});

test("roster --json names the policy source and keeps its existing fields", async () => {
  const { root, policyPath } = await xdgWith(undefined);
  const run = async (extra: Record<string, string>) => {
    const env: Record<string, string> = {
      ...subprocessEnvironment(),
      XDG_CONFIG_HOME: join(root, "config"),
      AGX_STATE_DIR: join(root, "state"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      ...extra,
    };
    delete env.AGX_CONFIG;
    if (extra.AGX_CONFIG !== undefined) env.AGX_CONFIG = extra.AGX_CONFIG;
    const child = Bun.spawn(
      [
        process.execPath,
        "tools/agx-worker/src/next/cli.ts",
        "roster",
        "--json",
      ],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe", timeout: 10000 },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  const absent = await run({});
  expect(absent.exit, absent.stderr).toBe(0);
  const absentResult = jsonOf(RosterJson).safeParse(absent.stdout);
  expect(absentResult.success).toBe(true);
  if (!absentResult.success) return;
  const parsedAbsent = absentResult.data;
  expect(parsedAbsent.policy.source).toBe("defaults");
  expect(parsedAbsent.auto.pick_temperature).toBe(0);
  expect(parsedAbsent.choice.length).toBeGreaterThan(0);

  const fromFile = await run({ AGX_CONFIG: fullFixture });
  expect(fromFile.exit, fromFile.stderr).toBe(0);
  const fileResult = jsonOf(RosterJson).safeParse(fromFile.stdout);
  expect(fileResult.success).toBe(true);
  if (!fileResult.success) return;
  const parsedFile = fileResult.data;
  expect(parsedFile.policy.source).toBe(`file:${fullFixture}`);
  expect(parsedFile.policy.keys["route.timeout_ms"]).toBe("file");
  expect(parsedFile.policy.keys["route.on_window_exhausted.codex"]).toBe(
    "default",
  );
  expect(parsedFile.policy.keys["route.on_window_exhausted.claude"]).toBe(
    "default",
  );

  const missing = await run({ AGX_CONFIG: join(root, "absent.toml") });
  expect(missing.exit).toBe(1);
  expect(missing.stdout).toBe("");
  expect(policyPath.length).toBeGreaterThan(0);
});

test("a policy naming route.no_egress is rejected with a delete-the-key message", async () => {
  await xdgWith("schema = 1\n[route]\nno_egress = []\n");
  const loaded = await loadRoster({ repoRoot: await emptyRepo() });
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error).toContain(
    "route.no_egress was removed: routing never enforced it; delete the key",
  );
});

test("a schema = 1 policy projects both routes to auto.routes, and a file allow narrows it", async () => {
  await xdgWith("schema = 1\n");
  const bare = await loadRoster({ repoRoot: await emptyRepo() });
  expect(bare.ok && bare.value.auto.routes).toEqual(["claude", "codex"]);
  await xdgWith('schema = 1\n[route]\nallow = ["codex"]\n');
  const narrowed = await loadRoster({ repoRoot: await emptyRepo() });
  expect(narrowed.ok && narrowed.value.auto.routes).toEqual(["codex"]);
});
