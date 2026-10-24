// Consumer: land/coordinator. Read-only checks; verdict lines distinguish SKIP from PASS.
// The gate depends only on the tree being integrated: each consumer is typechecked against the
// base revision's agx-usehooks and against the workspace's, and only diagnostics the workspace
// adds fail. A consumer already broken on the base is PRE-EXISTING, never a land failure.
// A compiler failure without diagnostics cannot establish this comparison and fails the check.
import { stat, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  attempt,
  errorMessage,
  type Attempt,
} from "../../shared/src/attempt.ts";
import { listAgxRepos } from "../../shared/src/agx-config.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";
type RegisteredRepo = Extract<
  Awaited<ReturnType<typeof listAgxRepos>>,
  { ok: true }
>["value"][number];
export type Consumer = { name: string; root: string } & NonNullable<
  RegisteredRepo["config"]["usehooks"]
>;

/** Only repositories declaring a usehooks table participate in the consumer check. */
export async function resolveUsehooksConsumers(): Promise<Attempt<Consumer[]>> {
  const repos = await listAgxRepos();
  if (!repos.ok) return repos;
  return {
    ok: true,
    value: repos.value.flatMap(({ name, root, config }) =>
      config.usehooks === undefined ? [] : [{ name, root, ...config.usehooks }],
    ),
  };
}
type Write = (text: string) => void;
const stdout: Write = (text) => void process.stdout.write(text);

const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

async function typecheck(argv: string[], root: string) {
  const signal = AbortSignal.timeout(120_000);
  const child = Bun.spawn(argv, {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: out, output: out + err, exit, timedOut: signal.aborted };
}

const CompilerConfig = z.looseObject({
  compilerOptions: z
    .looseObject({
      baseUrl: z.string().optional(),
      paths: z.record(z.string(), z.array(z.string())).optional(),
      typeRoots: z.array(z.string()).optional(),
      incremental: z.boolean().optional(),
      composite: z.boolean().optional(),
    })
    .optional(),
});

function defaultTypeRoots(root: string): string[] {
  const roots: string[] = [];
  for (let directory = root; ; directory = dirname(directory)) {
    roots.push(join(directory, "node_modules/@types"));
    if (dirname(directory) === directory) return roots;
  }
}

/**
 * tsc error lines with run-specific paths replaced, so the same diagnostic from the base and
 * the workspace run compares equal. `replace` maps a path prefix to its stable placeholder.
 */
export function diagnostics(
  output: string,
  replace: ReadonlyArray<readonly [string, string]>,
): string[] {
  return stripVTControlCharacters(output)
    .replaceAll("\\", "/")
    .split("\n")
    .filter((line) => /error TS\d+/u.test(line))
    .map((line) =>
      replace.reduce(
        (text, [path, placeholder]) =>
          text.replaceAll(path.replaceAll("\\", "/"), placeholder),
        line.trim(),
      ),
    );
}

/** Diagnostics present with the workspace and absent with the base, as a multiset difference. */
export function addedDiagnostics(
  base: string[],
  workspace: string[],
): string[] {
  const remaining = new Map<string, number>();
  for (const line of base) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  return workspace.filter((line) => {
    const left = remaining.get(line) ?? 0;
    if (left === 0) return true;
    remaining.set(line, left - 1);
    return false;
  });
}

async function treeFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: directory,
    dot: true,
    onlyFiles: true,
  }))
    if (!file.split("/").includes("node_modules"))
      files.set(file, await Bun.file(join(directory, file)).text());
  return files;
}

/** True when the workspace agx-usehooks tree differs from the base tree in any file. */
export async function usehooksChanged(
  workspace: string,
  base: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    treeFiles(base),
    treeFiles(workspace),
  ]);
  return (
    left.size !== right.size ||
    [...right].some(([file, text]) => left.get(file) !== text)
  );
}

// A failed run without diagnostics, or a timeout, cannot establish a comparison.
const silent = (run: {
  timedOut: boolean;
  exit: number;
  diagnostics: string[];
}) => run.timedOut || (run.exit !== 0 && run.diagnostics.length === 0);

export async function checkConsumer(
  consumer: Consumer,
  workspace: string,
  base: string,
  write: Write = stdout,
): Promise<number> {
  const root = resolve(
    consumer.root.startsWith("~/")
      ? join(homedir(), consumer.root.slice(2))
      : consumer.root,
  );
  if (!(await exists(root))) {
    write(
      `SKIP ${consumer.name}: consumer not present on this host (${root}); run on a host with this checkout\n`,
    );
    return 0;
  }
  // The consumer's own state is not the landed change: a missing hook tree or an unusable
  // project config is reported, and the land is not failed for it.
  if (!(await exists(join(root, consumer.hooks)))) {
    write(
      `PRE-EXISTING ${consumer.name}: declared hooks missing: ${consumer.hooks}\n`,
    );
    return 0;
  }
  const argv = consumer.command.map((part) => part.replaceAll("{root}", root));
  const checked = await attempt(async () => {
    const shown = await typecheck(
      argv.map((arg) => (arg === "--noEmit" ? "--showConfig" : arg)),
      root,
    );
    const parsedConfig = jsonOf(CompilerConfig).safeParse(shown.stdout);
    // A compiler that cannot run proves nothing about the change; only a config the compiler
    // itself rejects (a located TS diagnostic) is the consumer's own pre-existing state.
    if (
      shown.timedOut ||
      (!parsedConfig.success && diagnostics(shown.output, []).length === 0)
    )
      return {
        kind: "error" as const,
        message: `typecheck could not run (exit ${shown.exit}${shown.timedOut ? ", timeout" : ""}): ${shown.output.trim()}`,
      };
    if (shown.exit !== 0 || !parsedConfig.success)
      return {
        kind: "unusable" as const,
        unusable: `project config unreadable (tsc --showConfig exit ${shown.exit}${shown.timedOut ? ", timeout" : ""})\n${shown.output}`,
      };
    const options = parsedConfig.data.compilerOptions;
    if (options?.incremental === true || options?.composite === true)
      return {
        kind: "unusable" as const,
        unusable:
          "exact consumer command would write incremental build state; read-only check refused\n",
      };
    const files: string[] = [];
    for await (const file of new Bun.Glob("**/*.{ts,tsx,mts,cts}").scan({
      cwd: join(root, consumer.hooks),
      absolute: true,
    }))
      files.push(file);
    if (files.length === 0)
      return {
        kind: "unusable" as const,
        unusable: "no hook TypeScript files found\n",
      };
    const projectBase = resolve(root, options?.baseUrl ?? ".");
    const aliases = Object.fromEntries(
      Object.entries(options?.paths ?? {}).map(([key, values]) => [
        key,
        values.map((value) => resolve(projectBase, value)),
      ]),
    );
    const temporary = await mkdtemp(join(tmpdir(), "agx-usehooks-typecheck-"));
    await using _temporary = {
      [Symbol.asyncDispose]: async () => {
        await rm(temporary, { recursive: true, force: true });
      },
    };
    // Same consumer files and options; only the agx-usehooks resolution differs per side.
    const side = async (name: string, usehooks: string) => {
      const directory = join(temporary, name);
      await mkdir(directory);
      const config = join(directory, "tsconfig.json");
      await Bun.write(
        config,
        JSON.stringify({
          extends: join(root, "tsconfig.json"),
          files,
          include: [],
          compilerOptions: {
            noEmit: true,
            incremental: false,
            composite: false,
            paths: {
              ...aliases,
              "agx-usehooks": [join(resolve(usehooks), "src/index.ts")],
            },
            typeRoots:
              options?.typeRoots?.map((path) => resolve(root, path)) ??
              defaultTypeRoots(root),
          },
        }),
      );
      const result = await typecheck(
        argv.map((arg) => (arg === root ? config : arg)),
        root,
      );
      return {
        ...result,
        diagnostics: diagnostics(result.output, [
          // The repo layout around agx-usehooks (tools/shared included) differs per side.
          [resolve(usehooks, "../.."), "<repo>"],
          [directory, "<config>"],
          [`${root}/`, ""],
        ]),
      };
    };
    const [before, after] = await Promise.all([
      side("base", base),
      side("workspace", workspace),
    ]);
    return { kind: "checked" as const, before, after };
  });
  if (!checked.ok) {
    write(`FAIL ${consumer.name}: ${errorMessage(checked.error)}\n`);
    return 1;
  }
  if (checked.value.kind === "error") {
    write(`FAIL ${consumer.name}: ${checked.value.message}\n`);
    return 1;
  }
  if (checked.value.kind === "unusable") {
    write(checked.value.unusable);
    write(
      `PRE-EXISTING ${consumer.name}: consumer cannot be typechecked independently of this change\n`,
    );
    return 0;
  }
  const { before, after } = checked.value;
  const summary = `workspace ${workspace}; base ${base}; tsc exit ${before.exit} -> ${after.exit}${after.timedOut ? " (timeout)" : ""}`;
  const inconclusive = (
    [
      ["base", before],
      ["workspace", after],
    ] as const
  ).filter(([, run]) => silent(run));
  if (inconclusive.length > 0) {
    for (const [side, run] of inconclusive) {
      write(
        `FAIL ${consumer.name}: ${side} typecheck ${run.timedOut ? "timed out" : "failed without a diagnostic"} (exit ${run.exit}); comparison inconclusive; ${summary}\n`,
      );
      write(run.output);
    }
    return 1;
  }
  const added = addedDiagnostics(before.diagnostics, after.diagnostics);
  if (added.length > 0) {
    for (const line of added) write(`${line}\n`);
    write(
      `FAIL ${consumer.name}: ${added.length} diagnostic(s) added by the workspace; ${summary}\n`,
    );
    return 1;
  }
  if (after.diagnostics.length > 0) {
    write(
      `PRE-EXISTING ${consumer.name}: ${after.diagnostics.length} error(s) present with the base too; none added; ${summary}\n`,
    );
    return 0;
  }
  write(`PASS ${consumer.name}: ${summary}\n`);
  return 0;
}

/** Every declared consumer, or SKIP when the workspace tree equals the base tree. */
export async function checkConsumers(
  consumers: Consumer[],
  workspace: string,
  base: string,
  write: Write = stdout,
): Promise<number> {
  if (!(await usehooksChanged(workspace, base))) {
    write(
      "SKIP usehooks:consumers: the landed diff does not touch tools/agx-usehooks\n",
    );
    return 0;
  }
  let exit = 0;
  for (const consumer of consumers)
    exit = Math.max(
      exit,
      await checkConsumer(consumer, workspace, base, write),
    );
  return exit;
}

const SHARED_TREES = ["tools/agx-usehooks", "tools/shared"];

async function jj(repo: string, argv: string[]): Promise<ArrayBuffer | Error> {
  const child = Bun.spawn(
    [
      "jj",
      "--no-pager",
      "--color",
      "never",
      "--ignore-working-copy",
      "--at-operation=@",
      ...argv,
    ],
    { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return exit === 0 ? out : new Error(`jj ${argv.join(" ")}: ${err.trim()}`);
}

/**
 * Write the base revision's agx-usehooks (and the shared code it imports) into `into`, laid out
 * as in the repo, with the repo's node_modules linked so third-party imports resolve alike.
 * Reads committed history only; the working copy is never snapshotted.
 */
export async function materializeBase(
  repo: string,
  revision: string,
  into: string,
): Promise<string | Error> {
  const listed = await jj(repo, [
    "file",
    "list",
    "-r",
    revision,
    ...SHARED_TREES.map((tree) => `root:"${tree}"`),
  ]);
  if (listed instanceof Error) return listed;
  const files = new TextDecoder()
    .decode(listed)
    .split("\n")
    .filter((line) => line.length > 0);
  const shown = await Promise.all(
    files.map(async (file) => {
      const content = await jj(repo, [
        "file",
        "show",
        "-r",
        revision,
        `root-file:"${file}"`,
      ]);
      return content instanceof Error
        ? content
        : Bun.write(join(into, file), content);
    }),
  );
  const failed = shown.find((result) => result instanceof Error);
  if (failed !== undefined) return failed;
  if (await exists(join(repo, "node_modules")))
    await symlink(join(repo, "node_modules"), join(into, "node_modules"));
  return join(into, "tools/agx-usehooks");
}

export async function main(): Promise<number> {
  const consumers = await resolveUsehooksConsumers();
  if (!consumers.ok) {
    process.stderr.write(
      `FAIL consumer registry: ${errorMessage(consumers.error)}\n`,
    );
    return 1;
  }
  const repo = resolve(process.env.USEHOOKS_REPO_ROOT ?? process.cwd());
  const workspace = join(repo, "tools/agx-usehooks");
  const revision = process.env.USEHOOKS_BASE ?? "alpha";
  const temporary = await mkdtemp(join(tmpdir(), "agx-usehooks-base-"));
  await using _temporary = {
    [Symbol.asyncDispose]: async () => {
      await rm(temporary, { recursive: true, force: true });
    },
  };
  const base = await materializeBase(repo, revision, temporary);
  if (base instanceof Error) {
    process.stderr.write(
      `FAIL usehooks:consumers: cannot read ${revision}'s agx-usehooks: ${base.message}\n`,
    );
    return 1;
  }
  stdout(`usehooks:consumers: base ${revision}\n`);
  return await checkConsumers(consumers.value, workspace, base);
}

if (import.meta.main)
  process.exitCode = await main().catch((error: unknown) => {
    process.stderr.write(`FATAL: ${errorMessage(error)}\n`);
    return 2;
  });
