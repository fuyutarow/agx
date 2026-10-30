import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMMAND_NAMES } from "../../src/next/commands.ts";
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

test("all commands refuse the retired state variable, including empty values", async () => {
  const { env } = fixture();
  await Promise.all(["", "/unused"].flatMap((value) =>
    COMMAND_NAMES.map(async (command) => {
      const child = Bun.spawn(
        [process.execPath, "tools/agx-worker/src/next/cli.ts", command],
        {
          env: { ...env, AGX_NEXT_STATE_DIR: value },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "agx: AGX_NEXT_STATE_DIR is retired; use AGX_STATE_DIR\n",
      );
    }),
  ));
});

test("all commands refuse an unmigrated directory without creating state", () => {
  const { env } = fixture();
  const base = env.XDG_STATE_HOME;
  mkdirSync(join(base, "agx-next"), { recursive: true });
  for (const command of COMMAND_NAMES) {
    const result = Bun.spawnSync(
      [process.execPath, "tools/agx-worker/src/next/cli.ts", command],
      { env },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      `agx: state migration required: mv ${base}/agx ${base}/agx.legacy-v1.tmp && mv ${base}/agx-next ${base}/agx && mv ${base}/agx.legacy-v1.tmp ${base}/agx/legacy-v1\n`,
    );
    expect(existsSync(join(base, "agx"))).toBe(false);
    expect(existsSync(join(base, "agx-next"))).toBe(true);
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
