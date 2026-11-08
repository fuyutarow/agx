import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { stateDir, xdgStateHome } from "../src/state-dir.ts";
import { dispatchStateDir } from "../src/dispatch-state.ts";
import { agxTempRoot } from "../../agx-worker/src/temp.ts";
import { gpuStatePath } from "../src/gpu-samples.ts";

const home = "/tmp/agx-state-dir-test-home";
const xdg = "/tmp/agx-state-dir-test-xdg";

test("state directory precedence, empty values and absolute paths", () => {
  const cases = [
    {
      env: { AGX_STATE_DIR: "relative-state", XDG_STATE_HOME: xdg, HOME: home },
      expected: resolve("relative-state"),
    },
    {
      env: {
        AGX_STATE_DIR: "/tmp/agx-explicit",
        XDG_STATE_HOME: xdg,
        HOME: home,
      },
      expected: "/tmp/agx-explicit",
    },
    {
      env: { AGX_STATE_DIR: "", XDG_STATE_HOME: xdg, HOME: home },
      expected: join(xdg, "agx"),
    },
    {
      env: { AGX_STATE_DIR: "", XDG_STATE_HOME: "relative-state", HOME: home },
      expected: join(home, ".local/state/agx"),
    },
    {
      env: { AGX_STATE_DIR: "", XDG_STATE_HOME: "", HOME: home },
      expected: join(home, ".local/state/agx"),
    },
    {
      env: { AGX_STATE_DIR: "", XDG_STATE_HOME: "", HOME: "" },
      expected: join(homedir(), ".local/state/agx"),
    },
  ];
  for (const { env, expected } of cases) {
    expect(stateDir(env)).toBe(expected);
    expect(dispatchStateDir(env)).toBe(expected);
  }
});

// CHANGELOG 10.0.0: "Remove startup refusal for retired state configuration and agx-next."
test("a retired agx-next directory in the XDG state home no longer refuses startup", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-xdg-refusal-"));
  using _cleanup = {
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  const base = join(root, ".local", "state");
  mkdirSync(join(base, "agx-next"), { recursive: true });
  const worker = new URL("../../agx-worker/src/state.ts", import.meta.url).href;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { stateDir } from ${JSON.stringify(worker)}; console.log(stateDir());`,
    ],
    { env: { HOME: root, XDG_STATE_HOME: "relative-xdg", AGX_STATE_DIR: "" } },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain("mv ");
  expect(result.stdout.toString().trim()).toBe(join(base, "agx"));
});

test("XDG state home is shared by the independent run-temp and GPU paths", () => {
  const env = { HOME: home, XDG_STATE_HOME: "relative-xdg" };
  expect(xdgStateHome(env)).toBe(join(home, ".local/state"));
  expect(agxTempRoot(env)).toBe(join(home, ".local/state/agx/runs"));
  expect(xdgStateHome({ ...env, XDG_STATE_HOME: xdg })).toBe(xdg);
  expect(agxTempRoot({ ...env, XDG_STATE_HOME: xdg })).toBe(
    join(xdg, "agx/runs"),
  );
  expect(xdgStateHome({ HOME: "", XDG_STATE_HOME: "" })).toBe(
    join(homedir(), ".local/state"),
  );

  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_STATE_HOME;
  using _restore = {
    [Symbol.dispose]() {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdg;
    },
  };
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = "relative-xdg";
  expect(gpuStatePath()).toBe(join(home, ".local/state/gpu-owner.json"));
  process.env.XDG_STATE_HOME = xdg;
  expect(gpuStatePath()).toBe(join(xdg, "gpu-owner.json"));
});
