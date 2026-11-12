import assert from "node:assert";
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const cli = join(import.meta.dir, "../../src/next/cli.ts");
const FNOX_KEY = "fnox-secret-value-0123456789";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const L1_POLICY = `schema = 1
tickets = ".l1-tickets"
[ws]
trunk = "main"
keep = ["ws_from_l1", "ws_in_both"]
unjudged_warn_hours = 48
[route]
allow = ["codex"]
[check]
commands = ["true"]
timeout_ms = 5000
`;

const git = (cwd: string, args: string[]) => {
  const child = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      stdin: "ignore",
      env: {
        ...subprocessEnvironment(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
};

/** Temporary HOME, XDG config, state root, git repository with a committed L1, an L2 file and a fake fnox. */
function fixture(l1: string = L1_POLICY) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agx-config-view-")));
  roots.push(root);
  const home = join(root, "home");
  const config = join(root, "config");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  for (const directory of [home, join(config, "agx", "repos"), bin, repo])
    mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(bin, "fnox"),
    `#!/bin/sh\nprintf '%s\\n' '${FNOX_KEY}'\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(repo, "agx.toml"), l1);
  git(repo, ["init", "--quiet"]);
  git(repo, ["add", "--", "agx.toml"]);
  git(repo, ["commit", "--quiet", "-m", "policy"]);
  const l2 = join(config, "agx", "repos", "fixture.toml");
  writeFileSync(
    l2,
    `schema = 1\nroot = ${JSON.stringify(repo)}\n[ws]\nready = ["bun install"]\nkeep = ["ws_from_l2", "ws_in_both"]\n[verify]\nalways = ["bun check"]\n`,
  );
  const policy = join(config, "agx", "agx.toml");
  writeFileSync(
    policy,
    readFileSync(
      new URL("../../src/roster/policy.example.toml", import.meta.url),
      "utf8",
    )
      .replace("timeout_ms = 20000", "timeout_ms = 30000")
      .replace(
        '"claude-session" = "stop"',
        '"claude-session" = "stop", "claude-api" = "continue"',
      ),
  );
  const env = (extra: NodeJS.ProcessEnv = {}) => {
    const environment = subprocessEnvironment({
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: join(root, "xdg-state"),
      AGX_STATE_DIR: state,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...extra,
    });
    for (const name of [
      "AGX_CONFIG",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ])
      if (!Object.hasOwn(extra, name)) delete environment[name];
    return environment;
  };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = repo) => {
    const child = Bun.spawnSync([process.execPath, cli, ...args], {
      cwd,
      env: env(extra),
      stdin: "ignore",
      timeout: 30_000,
    });
    return {
      exit: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  };
  return { root, home, config, state, repo, l2, policy, run };
}

/** Decode JSON stdout through zod; a mismatch fails the test with the schema's message. */
function decode<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  const decoded = jsonOf(schema).safeParse(text);
  assert.ok(decoded.success, text);
  return decoded.data;
}

const list = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();

const Entry = z.object({ value: z.unknown(), source: z.string() });
const PolicyShape = z.object({
  source: z.string(),
});
const View = z.object({
  repository: z.object({
    root: z.string(),
    l1_path: z.string().nullable(),
    l2_path: z.string().nullable(),
    values: z.record(z.string(), Entry),
    "ws.keep": z.object({
      entries: z.array(
        z.object({
          value: z.string(),
          source: z.string(),
          layers: z.array(z.string()),
        }),
      ),
    }),
  }),
  routing: z.object({
    policy: PolicyShape,
    auto: z.unknown(),
    claude_run: z.unknown(),
    values: z.record(z.string(), Entry),
  }),
  credential: z.object({
    credential: z.string(),
    credential_source: z.string().nullable(),
    credits_unavailable_marker: z.object({
      path: z.string(),
      present: z.boolean(),
      fresh: z.boolean(),
      expires_at: z.string().nullable(),
    }),
  }),
});

const viewOf = (
  f: ReturnType<typeof fixture>,
  extra: NodeJS.ProcessEnv = {},
) => {
  const result = f.run(["config", "--json"], extra);
  expect(result.exit, result.stderr).toBe(0);
  return decode(View, result.stdout);
};

test("each repository value reports default, L1 or L2 with its file", () => {
  const f = fixture();
  const { repository } = viewOf(f);
  const l1 = `L1 ${join(f.repo, "agx.toml")}`;
  const l2 = `L2 ${f.l2}`;
  expect(repository.root).toBe(f.repo);
  expect(repository.l1_path).toBe(join(f.repo, "agx.toml"));
  expect(repository.l2_path).toBe(f.l2);
  const values = repository.values;
  expect(values["tickets"]).toEqual({
    value: join(f.repo, ".l1-tickets"),
    source: l1,
  });
  expect(values["ws.trunk"]).toEqual({ value: "main", source: l1 });
  expect(values["ws.unjudged_warn_hours"]).toEqual({ value: 48, source: l1 });
  expect(values["check.commands"]).toEqual({ value: ["true"], source: l1 });
  expect(values["check.timeout_ms"]).toEqual({ value: 5000, source: l1 });
  expect(values["route.allow"]).toEqual({ value: ["codex"], source: l1 });
  expect(values["ws.ready"]).toEqual({ value: ["bun install"], source: l2 });
  expect(values["verify.always"]).toEqual({ value: ["bun check"], source: l2 });
  expect(values["ws.regenerable"]).toEqual({ value: [], source: "default" });
});

test("ws.keep entries are labelled by the layer that declares them", () => {
  const f = fixture();
  const keep = viewOf(f).repository["ws.keep"].entries;
  const l1 = `L1 ${join(f.repo, "agx.toml")}`;
  const l2 = `L2 ${f.l2}`;
  expect(keep).toEqual([
    { value: "ws_from_l1", layers: ["L1"], source: l1 },
    { value: "ws_in_both", layers: ["L1", "L2"], source: `${l1} + ${l2}` },
    { value: "ws_from_l2", layers: ["L2"], source: l2 },
  ]);
  const human = f.run(["config"]).stdout;
  expect(human).toMatch(/ws\.keep\s+ws_from_l2\s+\[L2 /u);
  expect(human).toMatch(/ws\.keep\s+ws_from_l1\s+\[L1 /u);
});

test("a repository without L1 or L2 reports defaults", () => {
  const f = fixture();
  const bare = join(f.root, "bare");
  mkdirSync(bare);
  git(bare, ["init", "--quiet"]);
  const result = f.run(["config", "--json", "--repo", bare]);
  expect(result.exit, result.stderr).toBe(0);
  const { repository } = decode(View, result.stdout);
  expect(repository.l1_path).toBeNull();
  expect(repository.l2_path).toBeNull();
  expect(repository.values["ws.trunk"]).toEqual({
    value: "trunk()",
    source: "default",
  });
  expect(repository.values["route.allow"]).toEqual({
    value: null,
    source: "default",
  });
  expect(repository["ws.keep"].entries).toEqual([]);
});

test("routing equals roster --json policy and auto and names L3 and L1 sources", () => {
  const f = fixture();
  const view = viewOf(f);
  const roster = f.run(["roster", "--json"]);
  expect(roster.exit, roster.stderr).toBe(0);
  const parsed = decode(
    z.object({
      policy: PolicyShape,
      auto: z.unknown(),
      claude_run: z.unknown(),
    }),
    roster.stdout,
  );
  expect(view.routing.policy).toEqual(parsed.policy);
  expect(view.routing.auto).toEqual(parsed.auto);
  expect(view.routing.claude_run).toEqual(parsed.claude_run);
  expect(view.routing.policy.source).toBe(`file:${f.policy}`);
  expect(view.routing.values.codex).toEqual({
    value: "allowed",
    source: `L1 ${join(f.repo, "agx.toml")}`,
  });
});

test("credential_source reports fnox and the key never appears", () => {
  const f = fixture(
    L1_POLICY.replace('allow = ["codex"]', 'allow = ["claude-api"]'),
  );
  const json = f.run(["config", "--json"]);
  const human = f.run(["config"]);
  expect(json.exit, json.stderr).toBe(0);
  expect(human.exit, human.stderr).toBe(0);
  const view = decode(View, json.stdout);
  expect(view.credential.credential).toBe("api_key");
  expect(view.credential.credential_source).toBe("fnox");
  expect(view.credential.credits_unavailable_marker.fresh).toBe(false);
  for (const output of [json.stdout, json.stderr, human.stdout, human.stderr])
    expect(output).not.toContain(FNOX_KEY);
  expect(human.stdout).toMatch(/credential_source\s+fnox/u);
});

test("an env key is never printed either", () => {
  const f = fixture(
    L1_POLICY.replace('allow = ["codex"]', 'allow = ["claude-api"]'),
  );
  const secret = "env-secret-value-9876543210";
  const result = f.run(["config", "--json"], { ANTHROPIC_API_KEY: secret });
  expect(result.exit, result.stderr).toBe(0);
  expect(decode(View, result.stdout).credential.credential_source).toBe("env");
  expect(result.stdout + result.stderr).not.toContain(secret);
});

test("a fresh credits-unavailable marker reports subscription with its expiry", () => {
  const f = fixture();
  mkdirSync(f.state, { recursive: true });
  const marker = join(f.state, "claude-credits-unavailable");
  writeFileSync(marker, "");
  const written = (Temporal.Now.instant().epochMilliseconds - 3_600_000) / 1000;
  utimesSync(marker, written, written);
  const view = viewOf(f);
  expect(view.credential.credential).toBe("subscription");
  expect(view.credential.credential_source).toBeNull();
  const reported = view.credential.credits_unavailable_marker;
  expect(reported.path).toBe(marker);
  expect(reported.fresh).toBe(true);
  expect(reported.expires_at).toBe(
    Temporal.Instant.fromEpochMilliseconds(
      Math.floor(statSync(marker).mtimeMs + 24 * 60 * 60 * 1000),
    ).toString(),
  );
  const human = f.run(["config"]).stdout;
  expect(human).toMatch(/credits-unavailable marker\s+fresh until /u);
  expect(human).toMatch(/credential_source\s+\(not set\)/u);
});

test("the command writes nothing", () => {
  const f = fixture();
  const before = [f.home, f.config, f.repo, join(f.root, "bin")].flatMap(
    (directory) => list(directory),
  );
  expect(f.run(["config"]).exit).toBe(0);
  expect(f.run(["config", "--json"]).exit).toBe(0);
  const after = [f.home, f.config, f.repo, join(f.root, "bin")].flatMap(
    (directory) => list(directory),
  );
  expect(after).toEqual(before);
  expect(() => statSync(f.state)).toThrow();
  expect(() => statSync(join(f.root, "xdg-state"))).toThrow();
});

test("--json parses and human output has one section per layer", () => {
  const f = fixture();
  const human = f.run(["config"]);
  expect(human.exit, human.stderr).toBe(0);
  const headings = human.stdout.split("\n").filter((line) => /^\S/u.test(line));
  expect(headings.map((line) => line.split(" ")[0])).toEqual([
    "Repository",
    "Routing",
    "Credential",
  ]);
  const json = f.run(["config", "--json", "--repo", f.repo], {}, f.root);
  expect(json.exit, json.stderr).toBe(0);
  expect(
    Object.keys(
      decode(z.record(z.string(), z.unknown()), json.stdout),
    ).toSorted(),
  ).toEqual(["credential", "repository", "routing"]);
});

test("a configuration error exits 2 with the reader's diagnostic", () => {
  const f = fixture("schema = 2\n");
  const result = f.run(["config", "--json"]);
  expect(result.exit).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("unsupported schema 2");
  expect(result.stderr).toContain(join(f.repo, "agx.toml"));
});

test("the human header lists each layer on its own line", () => {
  const f = fixture();
  const lines = f.run(["config"]).stdout.split("\n");
  expect(lines.slice(0, lines.indexOf(""))).toEqual([
    `Repository ${f.repo}`,
    `  L1 ${join(f.repo, "agx.toml")}`,
    `  L2 ${f.l2}`,
  ]);
});

test("every layer label in a human row matches a header line", () => {
  const f = fixture();
  const human = f.run(["config"]).stdout;
  const header = new Set([`L1 ${join(f.repo, "agx.toml")}`, `L2 ${f.l2}`]);
  const labels = [...human.matchAll(/\[([^\]]+)\]/gu)]
    .map(([, label]) => label ?? "")
    .filter((label) => /^L[12] /u.test(label));
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels)
    for (const part of label.split(" + "))
      expect(header.has(part), part).toBe(true);
});

test("human output never prints null and names unset values", () => {
  const f = fixture();
  const bare = join(f.root, "bare");
  mkdirSync(bare);
  git(bare, ["init", "--quiet"]);
  for (const repo of [f.repo, bare]) {
    const result = f.run(["config", "--repo", repo]);
    expect(result.exit, result.stderr).toBe(0);
    for (const line of result.stdout.split("\n"))
      expect(line).not.toMatch(/\bnull\b/u);
  }
  const unset = f.run(["config", "--repo", bare]).stdout;
  expect(unset).toMatch(/^ {2}L1 trunk:agx\.toml {2}\(absent\)$/mu);
  expect(unset).toMatch(
    /^ {2}L2 <XDG config>\/agx\/repos\/<name>\.toml {2}\(absent\)$/mu,
  );
  expect(unset).toMatch(
    /route\.allow\s+\(not set: user routing policy applies\)\s+\[default\]$/mu,
  );
  expect(unset).toMatch(/check\.timeout_ms\s+\(not set\)\s+\[default\]$/mu);
});
