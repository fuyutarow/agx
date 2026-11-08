import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-state-dir-"));
  roots.push(root);
  const env = {
    ...subprocessEnvironment(),
    HOME: root,
    XDG_STATE_HOME: join(root, "base"),
    AGX_STATE_DIR: "",
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  return { root, env };
};

test("retired state variable and sibling directory do not block stats", () => {
  const { env } = fixture();
  mkdirSync(join(env.XDG_STATE_HOME, "agx-next"), { recursive: true });
  for (const value of ["", "/unused"]) {
    const result = Bun.spawnSync(
      [process.execPath, "tools/agx-worker/src/next/cli.ts", "stats"],
      { env: { ...env, AGX_NEXT_STATE_DIR: value } },
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(env.XDG_STATE_HOME, "agx-next"))).toBe(true);
  }
});

test("state resolution uses the explicit path, XDG, then home; empty values fall through", () => {
  const { root, env } = fixture();
  const cases = [
    {
      env: { ...env, AGX_STATE_DIR: join(root, "explicit") },
      expected: join(root, "explicit"),
    },
    { env, expected: join(env.XDG_STATE_HOME, "agx") },
    {
      env: { ...env, XDG_STATE_HOME: "" },
      expected: join(root, ".local/state/agx"),
    },
  ];
  for (const example of cases) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { stateDir } from ${JSON.stringify(resolve("tools/agx-worker/src/next/store.ts"))}; console.log(stateDir());`,
      ],
      { env: example.env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString().trim()).toBe(example.expected);
  }
});
