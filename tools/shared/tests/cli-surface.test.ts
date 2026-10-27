import suite from "../../agx/package.json" with { type: "json" };
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { jsonOf, z } from "../src/zod.ts";
import { subprocessEnvironment } from "../src/subprocess-env.ts";
const PackageSchema = jsonOf(
  z.object({
    version: z.string(),
    bin: z.record(z.string(), z.string()).optional(),
  }),
);
const environments = [
  { tty: false, color: false },
  { tty: false, color: true },
  { tty: true, color: false },
  { tty: true, color: true },
];

const ROOT = resolve(import.meta.dir, "../../..");

test("cli contract: an unknown command prints usage on stderr with exit 2", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-unknown-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
  for (const [name, source] of Object.entries({
    "agx-worker": "tools/agx-worker/src/next/cli.ts",
    "agx-ticket": "tools/agx-ticket/src/tkt.ts",
    "agx-ws": "tools/agx-ws/src/ws.ts",
    "agx-status": "tools/agx-status/src/status.ts",
    "agx-msg": "tools/xmsg/src/xmsg.ts",
  }))
    await symlink(join(ROOT, source), join(root, name));
  const env = { PATH: `${root}:${process.env.PATH ?? ""}` };
  const cases = [
    ["tools/agx/src/agx.ts", []],
    ["tools/agx/src/agx.ts", ["worker"]],
    ["tools/agx/src/agx.ts", ["ticket"]],
    ["tools/agx/src/agx.ts", ["ws"]],
    ["tools/agx/src/agx.ts", ["change"]],
    ["tools/agx/src/agx.ts", ["msg"]],
    ["tools/agx/src/agx.ts", ["status"]],
    ["tools/agx/src/agx.ts", ["doctor"]],
    ["tools/agx-worker/src/next/cli.ts", []],
    ["tools/agx-ticket/src/tkt.ts", []],
    ["tools/agx-ws/src/ws.ts", []],
    ["tools/xmsg/src/xmsg.ts", []],
    ["tools/agx-status/src/status.ts", []],
  ] as const;
  for (const [entry, prefix] of cases) {
    const result = await run(
      join(ROOT, entry),
      [...prefix, "not-a-command"],
      false,
      false,
      env,
    );
    expect(result.exit, `${entry} ${prefix.join(" ")}: ${result.stderr}`).toBe(
      2,
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^[^\n]*not-a-command[^\n]*--help[^\n]*\n$/u);
  }
  const allowed = await run(
    join(ROOT, "tools/agx/src/agx.ts"),
    ["msg", "--help"],
    false,
    false,
    env,
  );
  expect(allowed.exit).toBe(0);
  expect(allowed.stderr).toBe("");
  expect(allowed.stdout).toContain("list");
});

async function run(
  entry: string,
  args: string[],
  tty = false,
  color = false,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnvironment(),
    ...extraEnv,
    TERM: "xterm-256color",
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  if (color) env.FORCE_COLOR = "1";
  let output = "";
  const command = [process.execPath, entry, ...args];
  const child = tty
    ? Bun.spawn(
        ["sh", "-c", 'stty -onlcr; exec "$@"', "cli-test", ...command],
        {
          env,
          terminal: {
            cols: 45,
            rows: 24,
            data(_terminal, bytes) {
              output += Buffer.from(bytes).toString();
            },
          },
          timeout: 10000,
        },
      )
    : Bun.spawn(command, {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      });
  const [stdout, stderr, exit] = await Promise.all([
    child.stdout !== undefined && child.stdout !== null
      ? new Response(child.stdout).text()
      : Promise.resolve(""),
    child.stderr !== undefined && child.stderr !== null
      ? new Response(child.stderr).text()
      : Promise.resolve(""),
    child.exited,
  ]);
  child.terminal?.close();
  return { stdout: tty ? output : stdout, stderr, exit };
}

// Derive the acceptance surface from package declarations, including every bin alias.
for await (const packagePath of new Bun.Glob("tools/*/package.json").scan({
  cwd: ROOT,
})) {
  const decoded = PackageSchema.safeParse(
    await Bun.file(join(ROOT, packagePath)).text(),
  );
  expect(decoded.success).toBe(true);
  if (!decoded.success) continue;
  const pkg = decoded.data;
  // gpu-probe-pause owns the in-flight Cleye migration for this shared package bin.
  const bins = Object.entries(pkg.bin ?? {}).filter(
    ([name]) => name !== "gpu-sampler",
  );
  for (const [name, source] of bins) {
    const isMsgAlias = name === "agx-msg" || name === "xmsg";
    const canonicalName = isMsgAlias
      ? "agx msg"
      : Object.keys(pkg.bin ?? {})[0];
    // This multi-process CLI matrix exceeded 5 seconds in the timeout measurement.
    test(`${name}: version aliases, typed short flag, deterministic plain help`, async () => {
      const root = await mkdtemp(join(tmpdir(), "cli-surface-"));
      await using _cleanup = {
        [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
      };
      {
        const entry = join(root, name);
        await symlink(resolve(ROOT, packagePath, "..", source), entry);
        for (const flag of ["-V", "--version"]) {
          const result = await run(entry, [flag]);
          expect(result).toEqual({
            stdout: `${canonicalName} ${suite.version}\n`,
            stderr: "",
            exit: 0,
          });
        }
        const plain = await run(entry, ["--help"]);
        expect(plain.exit, plain.stderr).toBe(0);
        expect(plain.stderr).toBe("");
        expect(plain.stdout).toContain(name === "agx" ? "TOOLS:" : "Show help");
        if (isMsgAlias) {
          expect(plain.stdout).toContain(
            `${canonicalName} v${suite.version}\n`,
          );
          expect(plain.stdout).toContain(
            `  ${canonicalName} [flags...] [action]\n`,
          );
        }
        expect(plain.stdout).not.toContain("\u001B");
        for (const { tty, color } of environments) {
          const rendered = await run(entry, ["--help"], tty, color);
          expect(rendered).toEqual(plain);
        }
        // The forwarding wrapper must deliver the typed token to its downstream diagnostic.
        const extraEnv: NodeJS.ProcessEnv = {};
        if (name === "btmp") {
          await writeFile(
            join(root, "btm"),
            "#!/usr/bin/env bun\nprocess.stderr.write(`Error: Unknown flag: ${process.argv[2]}.\\n`);\nprocess.exit(1);\n",
            { mode: 0o755 },
          );
          extraEnv.PATH = `${root}:${process.env.PATH ?? ""}`;
          extraEnv.HERDR_ENV = "";
        }
        const error = await run(entry, ["-Z"], false, false, extraEnv);
        expect(error.exit).toBeGreaterThan(0);
        if (isMsgAlias) {
          expect(error.stderr).toBe(`${canonicalName}: unknown flag Z\n`);
        } else {
          expect(error.stderr).toMatch(/(?:-Z|unknown option: Z)/u);
        }
        expect(error.stderr).not.toContain("--Z");
      }
    }, 20_000);
  }
}

// The CLI template check stays in consumer.

for (const command of [
  ["worker", "doctor"],
  ["worker", "dispatch"],
  ["worker", "run"],
  ["ws", "add"],
  ["ticket", "new"],
]) {
  // measured 5014ms on alpha 1.22.5 under host load
  test(`agx ${command.join(" ")}: command help is environment-independent`, async () => {
    const entry = join(ROOT, "tools/agx/src/agx.ts");
    const args = [...command, "--help"];
    const plain = await run(entry, args);
    expect(plain.exit, plain.stderr).toBe(0);
    expect(plain.stdout).not.toContain("\u001B");
    for (const { tty, color } of environments)
      expect(await run(entry, args, tty, color)).toEqual(plain);
  }, 11000);
}
