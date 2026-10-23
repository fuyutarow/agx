import { mkdir, rm, copyFile, link } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { err, ok } from "neverthrow";
import { jsonOf, z } from "../zod.ts";

export const repository = resolve(import.meta.dir, "../..");
export const packages = new Set([
  "agx",
  "agx-worker",
  "agx-ws",
  "agx-ticket",
  "agx-status",
  "xmsg",
  "jex",
  "agx-usehooks",
]);
const manifestSchema = z.object({
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u),
  source: z.string().optional(),
  bin: z.record(z.string().regex(/^[\da-z-]+$/u), z.string()).optional(),
});

export async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

export async function packageInfo(pkg: string, root = repository) {
  if (!packages.has(pkg)) return err(`Unknown package: ${pkg}`);
  const dir = join(root, "tools", pkg);
  const parsed = jsonOf(manifestSchema).safeParse(
    await Bun.file(join(dir, "package.json")).text(),
  );
  if (!parsed.success)
    return err(`Invalid package.json for ${pkg}: ${parsed.error.message}`);
  const commands =
    pkg === "xmsg"
      ? {
          "agx-msg":
            parsed.data.bin?.["agx-msg"] ??
            parsed.data.bin?.xmsg ??
            "src/xmsg.ts",
          xmsg:
            parsed.data.bin?.["agx-msg"] ??
            parsed.data.bin?.xmsg ??
            "src/xmsg.ts",
        }
      : { ...parsed.data.bin };
  return ok({
    pkg,
    dir,
    version: parsed.data.version,
    tag: `${pkg}@${parsed.data.version}`,
    commands,
    source: parsed.data.source,
  });
}

export function platform(target?: string) {
  if (target === undefined)
    return ok({ os: process.platform, arch: process.arch });
  const match =
    /^bun-(linux|darwin|windows)-(x64|arm64)(?:-(?:baseline|modern|musl))*$/u.exec(
      target,
    );
  const os = match?.[1];
  const arch = match?.[2];
  if (os === undefined || arch === undefined)
    return err(`Invalid Bun target: ${target}`);
  return ok({ os: os === "windows" ? "win32" : os, arch });
}

export type CommandRunner = typeof run;

export async function build(
  pkg: string,
  target?: string,
  root = repository,
  runner: CommandRunner = run,
) {
  if (pkg === "suite") return buildSuite(target, root, runner);
  return buildMember(pkg, target, root, runner);
}

async function buildMember(
  pkg: string,
  target?: string,
  root = repository,
  runner: CommandRunner = run,
  suiteBin?: string,
) {
  const info = await packageInfo(pkg, root);
  if (info.isErr()) return info;
  if (Object.keys(info.value.commands).length === 0)
    return buildLibrary(info.value, root, runner);
  const host = platform(target);
  if (host.isErr()) return host;
  const { dir, version, commands } = info.value;
  const stage = join(root, "dist", pkg);
  const bin = suiteBin ?? join(stage, "bin");
  await rm(stage, { recursive: true, force: true });
  await mkdir(bin, { recursive: true });
  const compiled = new Map<string, string>();
  for (const [command, entry] of Object.entries(commands)) {
    const outfile = join(
      bin,
      `${command}${host.value.os === "win32" ? ".exe" : ""}`,
    );
    const existing = compiled.get(entry);
    if (existing !== undefined) {
      await link(existing, outfile);
      continue;
    }
    const args = [
      process.execPath,
      "build",
      "--compile",
      join(dir, entry),
      "--outfile",
      outfile,
    ];
    if (target !== undefined) args.push("--target", target);
    const result = await runner(args, root);
    if (result.exit !== 0)
      return err(
        `Build failed for ${command}: ${result.stderr}${result.stdout}`,
      );
    compiled.set(entry, outfile);
  }
  if (suiteBin !== undefined)
    return ok({ archive: "", sha256: "", assets: [] });
  const archive = join(
    root,
    "dist",
    `${pkg}-${version}-${host.value.os}-${host.value.arch}.tar.gz`,
  );
  const packed = await runner(
    ["tar", "-czf", archive, "-C", stage, "bin"],
    root,
  );
  if (packed.exit !== 0) return err(`Archive failed: ${packed.stderr}`);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  return ok({ archive, sha256, assets: [{ archive, sha256 }] });
}

async function buildSuite(
  target: string | undefined,
  root: string,
  runner: CommandRunner,
) {
  const suite = await packageInfo("agx", root);
  if (suite.isErr()) return suite;
  const host = platform(target);
  if (host.isErr()) return host;
  const stage = join(root, "dist", "suite");
  await rm(stage, { recursive: true, force: true });
  const bin = join(stage, "bin");
  await mkdir(bin, { recursive: true });
  for (const member of packages) {
    if (member === "agx-usehooks") continue;
    const compiled = await buildMember(member, target, root, runner, bin);
    if (compiled.isErr()) return compiled;
  }
  const archive = join(
    root,
    "dist",
    `agx-${suite.value.version}-${host.value.os}-${host.value.arch}.tar.gz`,
  );
  const packed = await runner(
    ["tar", "-czf", archive, "-C", stage, "bin"],
    root,
  );
  if (packed.exit !== 0) return err(`Archive failed: ${packed.stderr}`);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  const library = await buildMember("agx-usehooks", target, root, runner);
  if (library.isErr()) return library;
  return ok({
    archive,
    sha256,
    assets: [{ archive, sha256 }, ...library.value.assets],
  });
}

export async function suiteNotes(
  root: string,
  previousTag?: string,
  runner: CommandRunner = run,
) {
  const sections: string[] = [];
  for (const member of packages) {
    const info = await packageInfo(member, root);
    if (info.isErr()) return info;
    const { version, dir } = info.value;
    sections.push(`# ${member} ${version}`);
    const text = await Bun.file(join(dir, "CHANGELOG.md")).text();
    const current = changelogSection(text, version);
    if (current.isErr()) return current;
    if (previousTag === undefined) {
      sections.push(current.value);
      continue;
    }
    const prior = await runner(
      ["git", "show", `${previousTag}:tools/${member}/package.json`],
      root,
    );
    if (prior.exit !== 0)
      return err(`Cannot read previous member version: ${member}`);
    const parsed = jsonOf(manifestSchema).safeParse(prior.stdout);
    if (!parsed.success) return err(`Invalid previous manifest: ${member}`);
    if (parsed.data.version === version) continue;
    const old = changelogSection(text, parsed.data.version);
    if (old.isErr()) return old;
    const start = text.indexOf(current.value.trim());
    const end = text.indexOf(old.value.trim());
    if (end <= start) return err(`Invalid changelog order: ${member}`);
    sections.push(text.slice(start, end).trim());
  }
  return ok(sections.join("\n\n") + "\n");
}

/** Build a standalone ESM package; source and declaration paths stay independent. */
async function buildLibrary(
  info: {
    pkg: string;
    dir: string;
    version: string;
    source: string | undefined;
  },
  root: string,
  runner: CommandRunner,
) {
  const { pkg, dir, version, source } = info;
  if (source === undefined)
    return err(`Package ${pkg} has no library source entry`);
  const stage = join(root, "dist", pkg);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const bundled = await runner(
    [
      process.execPath,
      "build",
      join(dir, source),
      "--target",
      "bun",
      "--format",
      "esm",
      "--outfile",
      join(stage, "index.js"),
    ],
    root,
  );
  if (bundled.exit !== 0)
    return err(`Library build failed: ${bundled.stderr}${bundled.stdout}`);
  const declarations = await runner(
    [
      process.execPath,
      "x",
      "--bun",
      "--offline",
      "--package",
      "typescript@6.0.3",
      "tsc",
      "--project",
      join(dir, "tsconfig.release.json"),
      "--outDir",
      join(stage, "types"),
      "--listFiles",
    ],
    root,
  );
  if (declarations.exit !== 0)
    return err(
      `Declaration build failed: ${declarations.stderr}${declarations.stdout}`,
    );
  // tsc references existing declarations but does not copy them (e.g. vendored types).
  for (const file of declarations.stdout.split("\n")) {
    const rel = relative(root, file.trim());
    if (
      !file.endsWith(".d.ts") ||
      rel.startsWith("..") ||
      rel.split("/").includes("node_modules")
    )
      continue;
    const destination = join(stage, "types", rel);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.trim(), destination);
  }
  // Public shared declarations use NodeJS globals; resolve the consumer's optional type peer
  // even when the consumer does not otherwise load Node types.
  const declarationEntry = join(
    stage,
    "types",
    relative(root, join(dir, source)).replace(/\.ts$/u, ".d.ts"),
  );
  await Bun.write(
    declarationEntry,
    `/// <reference types="node" />\n${await Bun.file(declarationEntry).text()}`,
  );
  for (const file of ["package.json", "README.md", "CHANGELOG.md"])
    await copyFile(join(dir, file), join(stage, file));
  const archive = join(root, "dist", `${pkg}-${version}.tgz`);
  const packed = await runner(
    [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive],
    stage,
  );
  if (packed.exit !== 0)
    return err(`Package archive failed: ${packed.stderr}${packed.stdout}`);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  return ok({ archive, sha256, assets: [{ archive, sha256 }] });
}

export function changelogSection(text: string, version: string) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    const heading = /^##\s+\[?([^\]\s]+)\]?(?:\s|$)/u.exec(line);
    return heading?.[1] === version;
  });
  if (start === -1) return err(`CHANGELOG.md has no entry for ${version}`);
  const next = lines.findIndex(
    (line, index) => index > start && /^##\s/u.test(line),
  );
  const section = lines
    .slice(start, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  if (section.split("\n").slice(1).join("\n").trim().length === 0)
    return err(`CHANGELOG.md entry for ${version} is empty`);
  return ok(`${section}\n`);
}

/** Shell quoting is for the preview only; execution always uses argument vectors. */
export function shellCommand(args: string[]) {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

export async function publish(
  pkg: string,
  yes = false,
  target?: string,
  root = repository,
  runner: CommandRunner = run,
) {
  if (pkg !== "suite") return err("Use release:publish -- suite");
  const info = await packageInfo("agx", root);
  if (info.isErr()) return info;
  const tag = `v${info.value.version}`;
  const status = await runner(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    root,
  );
  if (status.exit !== 0)
    return err(`Cannot inspect working copy: ${status.stderr}`);
  if (status.stdout.trim().length > 0)
    return err(
      "Working copy is dirty; record or remove changes before publishing",
    );
  const existing = await runner(
    ["git", "show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
    root,
  );
  if (existing.exit === 0) return err(`Tag already exists: ${tag}`);
  if (existing.exit !== 1)
    return err(`Cannot inspect tag ${tag}: ${existing.stderr}`);
  const head = await runner(["git", "rev-parse", "HEAD"], root);
  if (head.exit !== 0) return err(`Cannot resolve HEAD: ${head.stderr}`);
  const alpha = await runner(
    ["git", "rev-parse", "--verify", "refs/heads/alpha"],
    root,
  );
  if (alpha.exit !== 0)
    return err(`Cannot resolve refs/heads/alpha: ${alpha.stderr}`);
  const headCommit = head.stdout.trim();
  const alphaCommit = alpha.stdout.trim();
  if (headCommit !== alphaCommit)
    return err(
      `Publish requires HEAD ${headCommit} to match refs/heads/alpha ${alphaCommit}`,
    );
  const remoteAlpha = await runner(
    ["git", "show-ref", "--verify", "--quiet", "refs/remotes/origin/alpha"],
    root,
  );
  if (remoteAlpha.exit !== 0 && remoteAlpha.exit !== 1)
    return err(
      `Cannot inspect refs/remotes/origin/alpha: ${remoteAlpha.stderr}`,
    );
  if (remoteAlpha.exit === 0) {
    const remote = await runner(
      ["git", "rev-parse", "--verify", "refs/remotes/origin/alpha"],
      root,
    );
    if (remote.exit !== 0)
      return err(`Cannot resolve refs/remotes/origin/alpha: ${remote.stderr}`);
    const remoteCommit = remote.stdout.trim();
    if (alphaCommit !== remoteCommit)
      return err(
        `Publish requires refs/heads/alpha ${alphaCommit} to match refs/remotes/origin/alpha ${remoteCommit}`,
      );
  }
  const previous = await runner(
    ["git", "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD"],
    root,
  );
  if (previous.exit !== 0 && previous.exit !== 128)
    return err("Cannot resolve previous suite tag");
  const section = await suiteNotes(
    root,
    previous.exit === 0 ? previous.stdout.trim() : undefined,
    runner,
  );
  if (section.isErr()) return section;
  const built = await build(pkg, target, root, runner);
  if (built.isErr()) return built;
  const notes = join(root, "dist", pkg, "release-notes.md");
  await Bun.write(notes, section.value);
  const commands: string[][] = [
    ["git", "tag", tag],
    [
      "gh",
      "release",
      "create",
      tag,
      ...built.value.assets.map((asset) => asset.archive),
      "--title",
      tag,
      "--notes-file",
      notes,
      "--target",
      headCommit,
    ],
  ];
  for (const member of packages) {
    const memberInfo = await packageInfo(member, root);
    if (memberInfo.isErr()) return memberInfo;
    const memberTag = memberInfo.value.tag;
    const exists = await runner(
      ["git", "show-ref", "--verify", "--quiet", `refs/tags/${memberTag}`],
      root,
    );
    if (exists.exit === 1)
      commands.splice(commands.length - 1, 0, ["git", "tag", memberTag]);
    else if (exists.exit !== 0) return err(`Cannot inspect tag ${memberTag}`);
  }
  if (!yes)
    return ok({
      ...built.value,
      commands: commands.map((command) => shellCommand(command)),
      dryRun: true,
    });
  for (const command of commands) {
    const result = await runner(command, root);
    if (result.exit !== 0)
      return err(
        `Release stopped at ${shellCommand(command)}: ${result.stderr}${result.stdout}`,
      );
  }
  return ok({
    ...built.value,
    commands: commands.map((command) => shellCommand(command)),
    dryRun: false,
  });
}
