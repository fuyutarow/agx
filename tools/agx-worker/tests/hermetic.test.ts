import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { clearInheritedAgentEnvironment } from "../../test-tmp.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const HOST_MISE_MARKER = "agx-hermetic-host-mise-config-was-read";
const HOST_AGX_MARKER = "agx-hermetic-host-agx-config-was-read";
const AGX_ENTRY = resolve(import.meta.dir, "../../agx/src/agx.ts");
const SAFE_POLICY = resolve(
  import.meta.dir,
  "../src/roster/policy.example.toml",
);

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("hermetic contract: spawned mise and agx ignore host user config", async () => {
  const hostHome = await mkdtemp(join(tmpdir(), "agx-test-host-home-"));
  const hostConfig = join(hostHome, ".config");
  const hostMiseConfig = join(hostConfig, "mise", "conf.d");
  const hostAgxConfig = join(hostConfig, "agx");
  const hostState = join(hostHome, ".local", "state");
  const isolatedMiseConfig = join(tmpdir(), "hermetic-mise-config");
  const isolatedMiseState = join(tmpdir(), "hermetic-mise-state");
  await Promise.all([
    mkdir(hostMiseConfig, { recursive: true }),
    mkdir(hostAgxConfig, { recursive: true }),
    mkdir(hostState, { recursive: true }),
    mkdir(isolatedMiseConfig, { recursive: true }),
    mkdir(isolatedMiseState, { recursive: true }),
  ]);
  const isolatedGlobalConfig = join(isolatedMiseConfig, "config.toml");
  await Bun.write(isolatedGlobalConfig, "");

  await Bun.write(
    join(hostMiseConfig, "dotfiles.toml"),
    `[env]\nAGX_HERMETIC_HOST_MISE = "${HOST_MISE_MARKER}"\n`,
  );
  const policy = await Bun.file(SAFE_POLICY).text();
  await Bun.write(
    join(hostAgxConfig, "agx.toml"),
    policy.replace('default = "luna-high"', `default = "${HOST_AGX_MARKER}"`),
  );
  expect(await Bun.file(join(hostAgxConfig, "agx.toml")).text()).toContain(
    HOST_AGX_MARKER,
  );

  const mise = Bun.which("mise");
  expect(mise).not.toBeNull();
  if (mise === null) return;
  const agxConfig = process.env.AGX_CONFIG;
  expect(agxConfig).toBeDefined();
  if (agxConfig === undefined) return;

  expect(process.env.HOME).not.toBe(hostHome);
  expect(process.env.XDG_CONFIG_HOME).not.toBe(hostConfig);
  expect(process.env.XDG_STATE_HOME).not.toBe(hostState);
  expect(process.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(process.env.CODEX_SESSION_ID).toBeUndefined();
  expect(process.env.AGX_DISPATCHER_SESSION).toBeUndefined();
  expect(process.env.AGX_RUN_DIR).toBeUndefined();
  expect(process.env.AGX_WORKER_PATH_SOURCE).toBeUndefined();
  const testRunDir = process.env.AGX_TEST_RUN_DIR;
  const codexHome = process.env.CODEX_HOME;
  expect(testRunDir).toBeDefined();
  expect(codexHome).toBeDefined();
  if (testRunDir !== undefined && codexHome !== undefined)
    expect(codexHome.startsWith(testRunDir)).toBe(true);
  if (testRunDir !== undefined)
    for (const path of [
      process.env.HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_STATE_HOME,
      process.env.AGX_CONFIG,
    ])
      expect(path?.startsWith(testRunDir)).toBe(true);
  expect(
    Object.keys(process.env)
      .filter((key) => key.startsWith("AGX_"))
      .toSorted(),
  ).toEqual(["AGX_CONFIG", "AGX_STATE_DIR", "AGX_TEST_RUN_DIR"]);

  const childEnv: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    HOME: hostHome,
    AGX_DISPATCHER_SESSION: "host-dispatcher-session",
    AGX_DISPATCHER_SESSION_ID: "host-dispatcher-id",
    AGX_HOST_SETTING: "host-agx-setting",
    AGX_RUN_DIR: join(hostState, "agx", "runs", "host-run"),
    AGX_WORKER_PATH_SOURCE: "host-worker-path-source",
    CLAUDE_CODE_SESSION_ID: "host-claude-session",
    CODEX_SESSION_ID: "host-codex-session",
    CODEX_HOME: join(hostHome, ".codex"),
    MISE_CONFIG_DIR: isolatedMiseConfig,
    MISE_GLOBAL_CONFIG_FILE: isolatedGlobalConfig,
    MISE_STATE_DIR: isolatedMiseState,
    MISE_TRUSTED_CONFIG_PATHS: "",
  };
  clearInheritedAgentEnvironment(childEnv);
  Object.assign(childEnv, {
    AGX_CONFIG: agxConfig,
    AGX_STATE_DIR: process.env.AGX_STATE_DIR,
    AGX_TEST_RUN_DIR: process.env.AGX_TEST_RUN_DIR,
  });
  expect(
    Object.keys(childEnv)
      .filter((key) => key.startsWith("AGX_"))
      .toSorted(),
  ).toEqual(["AGX_CONFIG", "AGX_STATE_DIR", "AGX_TEST_RUN_DIR"]);
  expect(childEnv.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(childEnv.CODEX_SESSION_ID).toBeUndefined();
  expect(childEnv.CODEX_HOME).toBeUndefined();
  expect(childEnv.AGX_WORKER_PATH_SOURCE).toBeUndefined();
  expect(childEnv.MISE_NO_CONFIG).toBeUndefined();
  expect(childEnv.MISE_CONFIG_DIR).toBe(isolatedMiseConfig);
  expect(childEnv.MISE_GLOBAL_CONFIG_FILE).toBe(isolatedGlobalConfig);
  expect(childEnv.MISE_STATE_DIR).toBe(isolatedMiseState);
  expect(childEnv.MISE_TRUSTED_CONFIG_PATHS).toBe("");

  const isolatedMiseEnv = { ...childEnv, MISE_NO_CONFIG: "1" };
  const unisolatedMiseEnv = { ...childEnv };
  for (const key of [
    "MISE_CONFIG_DIR",
    "MISE_GLOBAL_CONFIG_FILE",
    "MISE_STATE_DIR",
    "MISE_TRUSTED_CONFIG_PATHS",
  ])
    delete unisolatedMiseEnv[key];
  unisolatedMiseEnv.XDG_CONFIG_HOME = hostConfig;
  unisolatedMiseEnv.XDG_STATE_HOME = hostState;
  delete unisolatedMiseEnv.MISE_NO_CONFIG;
  const agxChildEnv: NodeJS.ProcessEnv = {
    ...childEnv,
    XDG_CONFIG_HOME: hostConfig,
    XDG_STATE_HOME: hostState,
  };
  const unisolatedAgxEnv = { ...agxChildEnv };
  delete unisolatedAgxEnv.AGX_CONFIG;

  const [miseResult, agxResult, unisolatedMise, unisolatedAgx] =
    await Promise.all([
      run([mise, "env", "--json"], hostHome, isolatedMiseEnv),
      run(
        [process.execPath, AGX_ENTRY, "worker", "roster", "--json"],
        hostHome,
        agxChildEnv,
      ),
      run([mise, "env", "--json"], hostHome, unisolatedMiseEnv),
      run(
        [process.execPath, AGX_ENTRY, "worker", "roster", "--json"],
        hostHome,
        unisolatedAgxEnv,
      ),
    ]);

  expect(miseResult.exitCode, miseResult.stderr).toBe(0);
  expect(`${miseResult.stdout}\n${miseResult.stderr}`).not.toContain(
    HOST_MISE_MARKER,
  );
  expect(`${miseResult.stdout}\n${miseResult.stderr}`).not.toContain(
    hostMiseConfig,
  );
  expect(unisolatedMise.stdout).toContain(HOST_MISE_MARKER);

  expect(agxResult.exitCode, agxResult.stderr).toBe(0);
  expect(agxResult.stdout).not.toContain(HOST_AGX_MARKER);
  expect(agxResult.stderr).not.toContain(HOST_AGX_MARKER);
  expect(unisolatedAgx.exitCode).toBe(1);
  expect(unisolatedAgx.stderr).toContain(HOST_AGX_MARKER);
  expect(agxChildEnv.AGX_CONFIG).toBe(agxConfig);
  expect(process.env.MISE_CONFIG_DIR).toBeUndefined();
  expect(process.env.MISE_GLOBAL_CONFIG_FILE).toBeUndefined();
  expect(process.env.MISE_STATE_DIR).toBeUndefined();
  expect(process.env.MISE_TRUSTED_CONFIG_PATHS).toBeUndefined();
  expect(process.env.MISE_PARANOID).toBeUndefined();
  expect(process.env.MISE_NO_CONFIG).toBeUndefined();

  const roster = jsonOf(z.looseObject({ default: z.string() })).safeParse(
    agxResult.stdout,
  );
  expect(roster.success).toBe(true);
  if (roster.success) expect(roster.data.default).toBe("luna-high");
});
