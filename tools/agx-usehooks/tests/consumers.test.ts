import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedDiagnostics,
  checkConsumer,
  checkConsumers,
  diagnostics,
  type Consumer,
} from "../src/check-consumers.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("diagnostics normalize run-specific paths; only workspace additions count", () => {
  const base = diagnostics(
    "/b/tools/agx-usehooks/src/index.ts(1,1): error TS1: x\nnoise\nsrc/a.ts(2,3): error TS2322: y\n",
    [["/b", "<repo>"]],
  );
  const workspace = diagnostics(
    "/w/tools/agx-usehooks/src/index.ts(1,1): error TS1: x\nsrc/a.ts(2,3): error TS2322: y\nsrc/a.ts(2,3): error TS2322: y\n",
    [["/w", "<repo>"]],
  );
  expect(base).toEqual([
    "<repo>/tools/agx-usehooks/src/index.ts(1,1): error TS1: x",
    "src/a.ts(2,3): error TS2322: y",
  ]);
  expect(addedDiagnostics(base, workspace)).toEqual([
    "src/a.ts(2,3): error TS2322: y",
  ]);
  expect(addedDiagnostics(workspace, base)).toEqual([]);
});

test("diagnostics count all 14 colored errors but no launcher failure as an error", () => {
  const output = Array.from(
    { length: 14 },
    (_, index) =>
      `\u001B[96mC:\\consumer\\broken.ts\u001B[0m:${index + 1}:14 - \u001B[91merror\u001B[0m\u001B[90m TS2322: \u001B[0mType 'string' is not assignable to type 'number'.`,
  ).join("\n");
  const counted = diagnostics(output, [["C:/consumer", "<consumer>"]]);
  expect(counted).toHaveLength(14);
  expect(counted[0]).toBe(
    "<consumer>/broken.ts:1:14 - error TS2322: Type 'string' is not assignable to type 'number'.",
  );
  expect(
    diagnostics("/usr/bin/env: node: No such file or directory\n", []),
  ).toEqual([]);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "usehooks-consumer-"));
  temporary.push(root);
  const tree = (name: string, declaration: string) => {
    const path = join(root, name, "tools/agx-usehooks");
    mkdirSync(join(path, "src"), { recursive: true });
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ name: "agx-usehooks", type: "module" }),
    );
    writeFileSync(join(path, "src/index.ts"), declaration);
    return path;
  };
  const shape =
    "export declare function gpu(): {nowPct: number} | {unavailable: string};\n";
  const alpha = tree("alpha", shape);
  const consumerRoot = join(root, "consumer");
  const adapter = join(root, "bun-check-adapter.ts");
  const hooks = join(consumerRoot, ".agents/hooks");
  const installed = join(root, "installed");
  for (const path of [hooks, installed, join(consumerRoot, "node_modules")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(installed, "index.ts"), shape);
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: "agx-usehooks", exports: "./index.ts" }),
  );
  const link = join(consumerRoot, "node_modules/agx-usehooks");
  symlinkSync(installed, link);
  const config = JSON.stringify({
    compilerOptions: {
      types: [],
      strict: true,
      noEmit: true,
      module: "ESNext",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
    },
    include: [".agents/hooks/**/*.ts", "launcher/**/*.ts"],
  });
  writeFileSync(join(consumerRoot, "tsconfig.json"), config);
  writeFileSync(
    adapter,
    `import { readFileSync } from "node:fs";\n` +
      `const args = Bun.argv.slice(2);\n` +
      `if (args[0] === "--version") { process.stdout.write("jj 0.46.0\\n"); process.exit(0); }\n` +
      `const project = args[args.indexOf("-p") + 1] ?? ".";\n` +
      `if (args.includes("--showConfig")) {\n` +
      `  const config = Bun.JSONC.parse(readFileSync(project + "/tsconfig.json", "utf8"));\n` +
      `  process.stdout.write(JSON.stringify({ compilerOptions: config.compilerOptions ?? {} }));\n` +
      `} else {\n` +
      `  const result = Bun.spawnSync([process.execPath, "check", "--no-pretty", "--project", project], { stdout: "inherit", stderr: "inherit" });\n` +
      `  process.exitCode = result.exitCode;\n` +
      `}\n`,
  );
  const hook = join(hooks, "lanes.ts");
  const source =
    "import {gpu} from 'agx-usehooks'; import './broken.ts'; const device = gpu(); if (!('unavailable' in device)) device.nowPct;\n";
  writeFileSync(hook, source);
  // 14 errors unrelated to agx-usehooks, present on alpha and in the workspace alike.
  writeFileSync(
    join(hooks, "broken.ts"),
    Array.from(
      { length: 14 },
      (_, index) => `export const v${index}: number = 'not a number';\n`,
    ).join(""),
  );
  const consumer: Consumer = {
    name: "fixture",
    root: consumerRoot,
    hooks: ".agents/hooks",
    link_task: "link:agx-usehooks",
    link_path: "node_modules/agx-usehooks",
    command: [process.execPath, adapter, "--noEmit", "-p", "{root}"],
  };
  return {
    root,
    tree,
    alpha,
    shape,
    consumer,
    consumerRoot,
    hook,
    source,
    config,
    link,
    installed,
  };
}

test("a consumer broken on alpha is PRE-EXISTING; an added consumer error FAILs naming it; nothing is written", async () => {
  const f = fixture();
  const lines: string[] = [];
  const write = (text: string) => void lines.push(text);
  const same = f.tree("same", `${f.shape}export const touched = 1;\n`);
  expect(await checkConsumer(f.consumer, same, f.alpha, write)).toBe(0);
  expect(lines.join("")).toContain(
    "PRE-EXISTING fixture: 14 error(s) present with the base too; none added",
  );

  lines.length = 0;
  const changed = f.tree(
    "changed",
    "export declare function gpu(): {utilPct: number} | {unavailable: string};\n",
  );
  expect(await checkConsumer(f.consumer, changed, f.alpha, write)).toBe(1);
  const report = lines.join("");
  expect(report).toMatch(
    /\.agents\/hooks\/lanes\.ts[(:]1[,:]\d+\)?:? -? ?error TS2339: Property 'nowPct' does not exist/u,
  );
  expect(report).toContain(
    "FAIL fixture: 1 diagnostic(s) added by the workspace",
  );
  expect(report).not.toContain("broken.ts");

  expect(readFileSync(f.hook, "utf8")).toBe(f.source);
  expect(readFileSync(join(f.consumerRoot, "tsconfig.json"), "utf8")).toBe(
    f.config,
  );
  expect(realpathSync(f.link)).toBe(realpathSync(f.installed));
}, 120_000);

for (const failing of ["base", "workspace", "both"]) {
  test(`a node launcher unavailable on ${failing} FAILs instead of claiming PRE-EXISTING`, async () => {
    const f = fixture();
    const bin = join(f.root, "empty-bin");
    mkdirSync(bin);
    const launcher = join(f.root, "tsc");
    writeFileSync(launcher, "#!/usr/bin/env node\n");
    chmodSync(launcher, 0o755);
    const adapter = join(f.root, "missing-node-adapter.ts");
    writeFileSync(
      adapter,
      `const args = Bun.argv.slice(2);\n` +
        `if (args.includes("--showConfig")) {\n` +
        `  process.stdout.write('{"compilerOptions":{}}');\n` +
        `} else {\n` +
        `  const project = args[args.indexOf("-p") + 1];\n` +
        `  const side = project.includes("/base/") ? "base" : "workspace";\n` +
        `  if (${JSON.stringify(failing)} === "both" || side === ${JSON.stringify(failing)}) {\n` +
        `    const result = Bun.spawnSync([${JSON.stringify(launcher)}], { env: { ...process.env, PATH: ${JSON.stringify(bin)} }, stdout: "inherit", stderr: "inherit" });\n` +
        `    process.exitCode = result.exitCode;\n` +
        `  }\n` +
        `}\n`,
    );
    const lines: string[] = [];
    expect(
      await checkConsumer(
        {
          ...f.consumer,
          command: [process.execPath, adapter, "--noEmit", "-p", "{root}"],
        },
        f.alpha,
        f.alpha,
        (text) => void lines.push(text),
      ),
    ).toBe(1);
    const report = lines.join("");
    expect(report).toContain("FAIL fixture:");
    expect(report).toContain("typecheck failed without a diagnostic");
    expect(report).toContain("node");
    expect(report).not.toContain("PRE-EXISTING");
  });
}

test("an untouched agx-usehooks tree is SKIP; a missing consumer is SKIP", async () => {
  const f = fixture();
  const lines: string[] = [];
  const write = (text: string) => void lines.push(text);
  const untouched = f.tree("untouched", f.shape);
  expect(
    await checkConsumers(
      [{ ...f.consumer, root: "/nonexistent" }],
      untouched,
      f.alpha,
      write,
    ),
  ).toBe(0);
  expect(lines.join("")).toBe(
    "SKIP usehooks:consumers: the landed diff does not touch tools/agx-usehooks\n",
  );

  lines.length = 0;
  const changed = f.tree("changed", `${f.shape}export const touched = 1;\n`);
  expect(
    await checkConsumers(
      [{ ...f.consumer, root: join(f.root, "absent") }],
      changed,
      f.alpha,
      write,
    ),
  ).toBe(0);
  expect(lines.join("")).toContain("SKIP fixture: consumer not present");
});

test("CLI --all checks every L2 consumer with no library diff; default still skips", async () => {
  const f = fixture();
  const repo = join(f.root, "untouched");
  f.tree("untouched", f.shape);
  const bin = join(f.root, "bin");
  const config = join(f.root, "config");
  const registry = join(config, "agx/repos");
  mkdirSync(bin);
  mkdirSync(registry, { recursive: true });
  // Fixture history reader: materialize precisely the identical base library tree.
  const jj = join(bin, "jj");
  writeFileSync(
    jj,
    `#!${process.execPath}\n` +
      `const args = Bun.argv.slice(2);\n` +
      `if (args.includes("list")) process.stdout.write("tools/agx-usehooks/package.json\\ntools/agx-usehooks/src/index.ts\\n");\n` +
      `else if (args.includes("show")) {\n` +
      `  const path = JSON.parse(args.at(-1).slice("root-file:".length));\n` +
      `  process.stdout.write(await Bun.file(${JSON.stringify(join(f.root, "alpha"))} + "/" + path).text());\n` +
      `} else process.exitCode = 1;\n`,
  );
  chmodSync(jj, 0o755);
  for (const consumer of [
    f.consumer,
    { ...f.consumer, name: "absent", root: join(f.root, "absent") },
  ])
    writeFileSync(
      join(registry, `${consumer.name}.toml`),
      `schema = 1\nroot = ${JSON.stringify(consumer.root)}\n[usehooks]\nhooks = ${JSON.stringify(consumer.hooks)}\nlink_task = ${JSON.stringify(consumer.link_task)}\nlink_path = ${JSON.stringify(consumer.link_path)}\ncommand = ${JSON.stringify(consumer.command)}\n`,
    );
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/check-consumers.ts"),
        ...args,
      ],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: config,
          USEHOOKS_REPO_ROOT: repo,
          USEHOOKS_BASE: "alpha",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output: stdout + stderr, exit };
  };
  const defaultRun = await run([]);
  expect(defaultRun.exit).toBe(0);
  expect(defaultRun.output).toContain(
    "SKIP usehooks:consumers: the landed diff does not touch tools/agx-usehooks",
  );
  expect(defaultRun.output).not.toContain("PRE-EXISTING fixture");
  expect(defaultRun.output).not.toContain("SKIP absent");

  const all = await run(["--all"]);
  expect(all.exit).toBe(0);
  expect(all.output).toContain("PRE-EXISTING fixture: 14 error(s)");
  expect(all.output).toContain("SKIP absent: consumer not present");
  expect(all.output).not.toContain("SKIP usehooks:consumers");

  writeFileSync(
    join(f.root, "bun-check-adapter.ts"),
    `if (Bun.argv.includes("--showConfig")) process.stdout.write('{"compilerOptions":{}}');\nelse process.exitCode = 1;\n`,
  );
  const failed = await run(["--all"]);
  expect(failed.exit).toBe(1);
  expect(failed.output).toContain("FAIL fixture:");
  expect(failed.output).toContain("SKIP absent: consumer not present");

  expect((await run(["--help"])).output).toContain("--all");
  expect((await run(["--unknown"])).exit).toBe(1);
  expect((await run(["--__proto__"])).exit).toBe(2);
  expect((await run(["unexpected"])).exit).toBe(2);
}, 120_000);

test("consumer resolution selects exactly L2 usehooks tables and propagates strict errors", async () => {
  const { resolveUsehooksConsumers } =
    await import("../src/check-consumers.ts");
  const root = mkdtempSync(join(tmpdir(), "usehooks-l2-"));
  temporary.push(root);
  const directory = join(root, "agx/repos");
  mkdirSync(directory, { recursive: true });
  const originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  using _restore = {
    [Symbol.dispose]: () => {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
    },
  };
  expect(await resolveUsehooksConsumers()).toEqual({ ok: true, value: [] });
  writeFileSync(
    join(directory, "plain.toml"),
    `schema = 1\nroot = ${JSON.stringify(join(root, "plain"))}\n`,
  );
  const consumer = {
    name: "example",
    root: join(root, "example"),
    hooks: ".agents/hooks",
    link_task: "link:hooks",
    link_path: "node_modules/agx-usehooks",
    command: ["check", "{root}"],
  };
  const path = join(directory, "example.toml");
  writeFileSync(
    path,
    `schema = 1\nroot = ${JSON.stringify(consumer.root)}\n[usehooks]\nhooks = ".agents/hooks"\nlink_task = "link:hooks"\nlink_path = "node_modules/agx-usehooks"\ncommand = ["check", "{root}"]\n`,
  );
  expect(await resolveUsehooksConsumers()).toEqual({
    ok: true,
    value: [consumer],
  });
  writeFileSync(
    path,
    `schema = 1\nroot = ${JSON.stringify(consumer.root)}\n[usehooks]\nunknown = true\n`,
  );
  const invalid = await resolveUsehooksConsumers();
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(String(invalid.error)).toContain(path);
});
