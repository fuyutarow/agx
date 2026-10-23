import { mkdir, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, ok } from "neverthrow";
import { jsonOf, z } from "../zod.ts";

export const repository = resolve(import.meta.dir, "../..");
const packages = new Set([
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
  const commands = { ...parsed.data.bin };
  if (Object.keys(commands).length === 0)
    return err(`Package ${pkg} has no commands`);
  if (pkg === "xmsg") commands["agx-msg"] = commands.xmsg ?? "src/xmsg.ts";
  return ok({
    pkg,
    dir,
    version: parsed.data.version,
    tag: `${pkg}@${parsed.data.version}`,
    commands,
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

export async function build(pkg: string, target?: string, root = repository) {
  const info = await packageInfo(pkg, root);
  if (info.isErr()) return info;
  const host = platform(target);
  if (host.isErr()) return host;
  const { dir, version, commands } = info.value;
  const stage = join(root, "dist", pkg);
  const bin = join(stage, "bin");
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
      await copyFile(existing, outfile);
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
    const result = await run(args, root);
    if (result.exit !== 0)
      return err(
        `Build failed for ${command}: ${result.stderr}${result.stdout}`,
      );
    compiled.set(entry, outfile);
  }
  const archive = join(
    root,
    "dist",
    `${pkg}-${version}-${host.value.os}-${host.value.arch}.tar.gz`,
  );
  const packed = await run(["tar", "-czf", archive, "-C", stage, "bin"], root);
  if (packed.exit !== 0) return err(`Archive failed: ${packed.stderr}`);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  return ok({ archive, sha256 });
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
) {
  const info = await packageInfo(pkg, root);
  if (info.isErr()) return info;
  const { tag, dir, version } = info.value;
  const status = await run(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    root,
  );
  if (status.exit !== 0)
    return err(`Cannot inspect working copy: ${status.stderr}`);
  if (status.stdout.trim().length > 0)
    return err(
      "Working copy is dirty; record or remove changes before publishing",
    );
  const existing = await run(
    ["git", "show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
    root,
  );
  if (existing.exit === 0) return err(`Tag already exists: ${tag}`);
  if (existing.exit !== 1)
    return err(`Cannot inspect tag ${tag}: ${existing.stderr}`);
  const section = changelogSection(
    await Bun.file(join(dir, "CHANGELOG.md")).text(),
    version,
  );
  if (section.isErr()) return section;
  const head = await run(["git", "rev-parse", "HEAD"], root);
  if (head.exit !== 0) return err(`Cannot resolve HEAD: ${head.stderr}`);
  const built = await build(pkg, target, root);
  if (built.isErr()) return built;
  const notes = join(root, "dist", pkg, "release-notes.md");
  await Bun.write(notes, section.value);
  const commands = [
    ["git", "tag", tag],
    [
      "gh",
      "release",
      "create",
      tag,
      built.value.archive,
      "--title",
      tag,
      "--notes-file",
      notes,
      "--target",
      head.stdout.trim(),
    ],
  ];
  if (!yes)
    return ok({
      ...built.value,
      commands: commands.map((command) => shellCommand(command)),
      dryRun: true,
    });
  for (const command of commands) {
    const result = await run(command, root);
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
