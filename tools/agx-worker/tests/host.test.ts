import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { readCodexHostDeclaration } from "../src/workers/codex-host.ts";

const CheckResult = jsonOf(
  z.object({
    schema: z.literal(1),
    path: z.string(),
    status: z.enum(["valid", "absent", "invalid"]),
    declaration: z
      .object({ schema: z.literal(1), unsandboxed_reason: z.string() })
      .nullable(),
    reason: z.string().nullable(),
  }),
);

function checkOutput(text: string) {
  const result = CheckResult.safeParse(text);
  expect(result.success, result.error?.message).toBe(true);
  return result.success ? result.data : undefined;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agx-host-"));
  const path = join(root, "config/agx/host.toml");
  mkdirSync(join(root, "bin"));
  symlinkSync(
    join(import.meta.dir, "../src/next/cli.ts"),
    join(root, "bin/agx-worker"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  delete env.AGX_CODEX_HOST_FILE;
  delete env.AGX_NEXT_STATE_DIR;
  return {
    root,
    path,
    env,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
    async invoke(...args: string[]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../agx/src/agx.ts"),
          "worker",
          "host",
          ...args,
        ],
        {
          env: {
            ...env,
            PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      return { stdout, stderr, exit };
    },
  };
}

// measured 5036ms on alpha 1.22.5 under host load
test("public agx host check and exclusive declare round trip through the launch reader", async () => {
  using f = fixture();
  const absent = await f.invoke("check", "--json");
  expect(absent.exit, absent.stderr).toBe(1);
  expect(checkOutput(absent.stdout)).toEqual({
    schema: 1,
    path: f.path,
    status: "absent",
    declaration: null,
    reason: null,
  });
  expect(() => lstatSync(join(f.root, "state"))).toThrow();
  const reason = '  isolated "box"\nwith backslash \\ and 日本語  ';
  const created = await f.invoke("declare", "--unsandboxed-reason", reason);
  expect(created).toEqual({ stdout: `${f.path}\n`, stderr: "", exit: 0 });
  expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(f.root, "config/agx")).mode & 0o777).toBe(0o700);
  expect(readCodexHostDeclaration(f.path)).toEqual({
    kind: "valid",
    declaration: { unsandboxedReason: reason.trim() },
  });
  const checked = await f.invoke("check", "--json");
  expect(checked.exit, checked.stderr).toBe(0);
  expect(checkOutput(checked.stdout)).toEqual({
    schema: 1,
    path: f.path,
    status: "valid",
    declaration: { schema: 1, unsandboxed_reason: reason.trim() },
    reason: null,
  });
  const original = readFileSync(f.path, "utf8");
  expect(
    (await f.invoke("declare", "--unsandboxed-reason", "replacement")).exit,
  ).toBe(2);
  expect(readFileSync(f.path, "utf8")).toBe(original);
}, 11000);

for (const content of [
  'schema = 2\nunsandboxed_reason = "box"',
  'schema = 1\nunsandboxed_reason = " "',
  'schema = 1\nunsandboxed_reason = "box"\nextra = true',
  "not TOML[",
]) {
  test(`invalid declaration refuses check and overwrite: ${content}`, async () => {
    using f = fixture();
    mkdirSync(join(f.root, "config/agx"), { recursive: true });
    writeFileSync(f.path, content);
    const checked = await f.invoke("check", "--json");
    expect(checked.exit).toBe(2);
    expect(checkOutput(checked.stdout)).toMatchObject({
      status: "invalid",
      declaration: null,
      reason: checkOutput(checked.stdout)?.reason,
    });
    expect(
      (await f.invoke("declare", "--unsandboxed-reason", "replacement")).exit,
    ).toBe(2);
    expect(readFileSync(f.path, "utf8")).toBe(content);
  });
}

test("final symlinks, including dangling ones, are never followed or replaced", async () => {
  using f = fixture();
  mkdirSync(join(f.root, "config/agx"), { recursive: true });
  const target = join(f.root, "target");
  for (const exists of [false, true]) {
    if (exists)
      writeFileSync(target, 'schema = 1\nunsandboxed_reason = "target"\n');
    symlinkSync(target, f.path);
    expect((await f.invoke("check", "--json")).exit).toBe(2);
    expect(
      (await f.invoke("declare", "--unsandboxed-reason", "replacement")).exit,
    ).toBe(2);
    expect(lstatSync(f.path).isSymbolicLink()).toBe(true);
    if (exists) expect(readFileSync(target, "utf8")).toContain('"target"');
    else expect(() => lstatSync(target)).toThrow();
    rmSync(f.path);
  }
}, 30_000);

// measured 5060ms on alpha 1.22.5 under host load
test("retired path blocks creation; current valid file takes precedence without migration", async () => {
  using f = fixture();
  const legacy = join(f.root, "config/codex-run/host.toml");
  mkdirSync(join(f.root, "config/codex-run"), { recursive: true });
  writeFileSync(legacy, 'schema = 1\nunsandboxed_reason = "legacy"\n');
  const checked = await f.invoke("check", "--json");
  expect(checked.exit).toBe(2);
  expect(checkOutput(checked.stdout)?.reason).toContain(
    "legacy host declaration found",
  );
  expect(
    (await f.invoke("declare", "--unsandboxed-reason", "replacement")).exit,
  ).toBe(2);
  expect(() => lstatSync(f.path)).toThrow();
  mkdirSync(join(f.root, "config/agx"));
  writeFileSync(f.path, 'schema = 1\nunsandboxed_reason = "current"\n');
  expect((await f.invoke("check", "--json")).exit).toBe(0);
  expect(readFileSync(legacy, "utf8")).toContain('"legacy"');
}, 11000);

test("unreadable and non-file paths are invalid, override path is honored", async () => {
  using f = fixture();
  f.env.AGX_CODEX_HOST_FILE = join(f.root, "override");
  mkdirSync(f.env.AGX_CODEX_HOST_FILE);
  expect((await f.invoke("check", "--json")).exit).toBe(2);
  rmSync(f.env.AGX_CODEX_HOST_FILE, { recursive: true });
  writeFileSync(
    f.env.AGX_CODEX_HOST_FILE,
    'schema = 1\nunsandboxed_reason = "box"\n',
  );
  chmodSync(f.env.AGX_CODEX_HOST_FILE, 0o000);
  using _mode = {
    [Symbol.dispose]: () => {
      chmodSync(f.env.AGX_CODEX_HOST_FILE ?? "", 0o600);
    },
  };
  {
    const checked = await f.invoke("check", "--json");
    expect(checked.exit).toBe(2);
    expect(checkOutput(checked.stdout)).toMatchObject({
      path: f.env.AGX_CODEX_HOST_FILE,
      status: "invalid",
    });
  }
});

test("competing declares create exactly once", async () => {
  using f = fixture();
  const results = await Promise.all([
    f.invoke("declare", "--unsandboxed-reason", "first"),
    f.invoke("declare", "--unsandboxed-reason", "second"),
  ]);
  expect(results.map((r) => r.exit).toSorted((a, b) => a - b)).toEqual([0, 2]);
  expect((await f.invoke("check", "--json")).exit).toBe(0);
});

test("help and usage failures do not create declarations", async () => {
  using f = fixture();
  expect((await f.invoke("--help")).exit).toBe(0);
  for (const args of [
    [],
    ["check"],
    ["check", "--json", "extra"],
    ["declare"],
    ["declare", "--unsandboxed-reason", "  "],
    ["check", "--json", "--unknown"],
  ]) {
    expect((await f.invoke(...args)).exit).not.toBe(0);
  }
  expect(() => lstatSync(f.path)).toThrow();
}, 30_000);
