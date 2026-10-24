import { homedir } from "node:os";
import { mkdir, rm, copyFile, link, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { err, ok, fromPromise } from "neverthrow";
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
const messagingBinSchema = z
  .object({
    "agx-msg": z.string().min(1),
    xmsg: z.string().min(1),
  })
  .refine((bin) => bin["agx-msg"] === bin.xmsg, {
    message: "agx-msg and xmsg must share the same source",
  });

export async function run(cmd: string[], cwd: string) {
  const timeout =
    cmd[0] === "gh" && cmd[1] === "release" && cmd[2] === "upload"
      ? 600_000
      : 120_000;
  const signal = AbortSignal.timeout(timeout);
  const child = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exit,
    stdout,
    stderr: signal.aborted
      ? `${stderr}\nCommand timed out after ${timeout} ms`
      : stderr,
  };
}

export async function packageInfo(pkg: string, root = repository) {
  if (!packages.has(pkg)) return err(`Unknown package: ${pkg}`);
  const dir = join(root, "tools", pkg);
  const parsed = jsonOf(manifestSchema).safeParse(
    await Bun.file(join(dir, "package.json")).text(),
  );
  if (!parsed.success)
    return err(`Invalid package.json for ${pkg}: ${parsed.error.message}`);
  const suite = jsonOf(manifestSchema).safeParse(
    await Bun.file(join(root, "tools/agx/package.json")).text(),
  );
  if (!suite.success) return err("Invalid suite manifest");
  let commands = { ...parsed.data.bin };
  if (pkg === "xmsg") {
    const messaging = messagingBinSchema.safeParse(parsed.data.bin);
    if (!messaging.success)
      return err(`Invalid package.json for ${pkg}: ${messaging.error.message}`);
    commands = messaging.data;
  }
  return ok({
    pkg,
    dir,
    version: suite.data.version,
    tag: `v${suite.data.version}`,
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

export const suiteTargets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
];

export function suiteArchiveName(version: string, target: string) {
  const parsed = platform(target);
  if (parsed.isErr()) return parsed;
  return ok(`agx-${version}-${parsed.value.os}-${parsed.value.arch}.tar.gz`);
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
  const name = suiteArchiveName(
    suite.value.version,
    target ??
      `bun-${host.value.os === "win32" ? "windows" : host.value.os}-${host.value.arch}`,
  );
  if (name.isErr()) return name;
  const archive = join(root, "dist", name.value);
  const packed = await runner(
    ["tar", "-czf", archive, "-C", stage, "bin"],
    root,
  );
  if (packed.exit !== 0) return err(`Archive failed: ${packed.stderr}`);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  return ok({
    archive,
    sha256,
    assets: [{ archive, sha256 }],
  });
}

export async function suiteNotes(
  root: string,
  previousTag?: string,
  runner: CommandRunner = run,
) {
  const info = await packageInfo("agx", root);
  if (info.isErr()) return info;
  const text = await Bun.file(join(root, "CHANGELOG.md")).text();
  const current = changelogSection(text, info.value.version);
  if (current.isErr() || previousTag === undefined) return current;
  const prior = await runner(
    ["git", "show", previousTag + ":tools/agx/package.json"],
    root,
  );
  if (prior.exit !== 0) return err("Cannot read previous suite version");
  const parsed = jsonOf(manifestSchema).safeParse(prior.stdout);
  if (!parsed.success) return err("Invalid previous suite manifest");
  if (parsed.data.version === info.value.version) return current;
  const old = changelogSection(text, parsed.data.version);
  if (old.isErr()) return old;
  const start = text.indexOf(current.value.trim());
  const end = text.indexOf(old.value.trim());
  if (end <= start) return err("Invalid suite changelog order");
  return ok(text.slice(start, end).trim() + "\n");
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
  const manifest = jsonOf(z.record(z.string(), z.unknown())).safeParse(
    await Bun.file(join(stage, "package.json")).text(),
  );
  if (!manifest.success) return err("Invalid library manifest");
  await Bun.write(
    join(stage, "package.json"),
    JSON.stringify({ ...manifest.data, version }, null, 2) + "\n",
  );
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

const releaseAssetsSchema = z.object({
  assets: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
});

function commandFailure(
  command: string[],
  result: Awaited<ReturnType<CommandRunner>>,
) {
  const output = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n");
  return `${shellCommand(command)} exited ${result.exit}: ${output.length > 0 ? output : "no stdout or stderr captured"}`;
}

async function uploadAsset(
  command: string[],
  root: string,
  runner: CommandRunner,
) {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const args = attempt === 1 ? command : [...command, "--clobber"];
    const result = await runner(args, root);
    if (result.exit === 0) return ok(undefined);
    failures.push(`Attempt ${attempt}: ${commandFailure(args, result)}`);
  }
  return err(failures.join("\n"));
}

export async function publish(
  pkg: string,
  yes = false,
  target?: string,
  root = repository,
  runner: CommandRunner = run,
  machine: MachineOptions = {},
) {
  if (pkg !== "suite") return err("Use release:publish -- suite");
  const info = await packageInfo("agx", root);
  if (info.isErr()) return info;
  const tag = `v${info.value.version}`;
  const libraryTag = `usehooks-v${info.value.version}`;
  if (target !== undefined)
    return err(
      "Suite publishing always builds all supported platforms; omit --target",
    );
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
  for (const checkedTag of [tag, libraryTag]) {
    const existing = await runner(
      ["git", "show-ref", "--verify", "--quiet", `refs/tags/${checkedTag}`],
      root,
    );
    if (existing.exit === 0) return err(`Tag already exists: ${checkedTag}`);
    if (existing.exit !== 1)
      return err(`Cannot inspect tag ${checkedTag}: ${existing.stderr}`);
  }
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
  const section = await suiteNotes(root);
  if (section.isErr()) return section;
  const commands = [
    ["git", "tag", tag, headCommit],
    ["git", "tag", libraryTag, headCommit],
    [
      "git",
      "push",
      "--atomic",
      "origin",
      "refs/heads/alpha:refs/heads/alpha",
      `refs/tags/${tag}:refs/tags/${tag}`,
      `refs/tags/${libraryTag}:refs/tags/${libraryTag}`,
    ],
  ];
  let workflowUrl = `https://github.com/fuyutarow/agx/actions/workflows/release.yml?query=branch%3A${tag}`;
  const recovery: string[] = [];
  for (const command of yes ? commands : []) {
    const result = await runner(command, root);
    if (result.exit !== 0)
      return err(`Release stopped at ${commandFailure(command, result)}`);
  }
  if (yes) {
    const inspectedRuns = await fromPromise(
      runner(
        [
          "gh",
          "run",
          "list",
          "--workflow",
          "release.yml",
          "--commit",
          headCommit,
          "--json",
          "url",
          "--limit",
          "1",
        ],
        root,
      ),
      () => "Workflow run is not available yet",
    );
    const runs = inspectedRuns.isOk()
      ? inspectedRuns.value
      : { exit: 1, stdout: "" };
    const parsed = jsonOf(z.array(z.object({ url: z.url() }))).safeParse(
      runs.stdout,
    );
    if (runs.exit === 0 && parsed.success && parsed.data[0] !== undefined) {
      workflowUrl = parsed.data[0].url;
    } else {
      recovery.push(
        "No workflow run found after the tag push. If no run appears, dispatch the existing tags without deleting or moving them:",
        ...[tag, libraryTag].map(
          (releaseTag) =>
            `gh workflow run release.yml --ref alpha -f tag=${releaseTag}`,
        ),
      );
      process.stdout.write(`${workflowUrl}\n${recovery.join("\n")}\n`);
    }
    const installed = await machineSwap(
      info.value.version,
      machine,
      root,
      runner,
    );
    if (installed.isErr()) return installed;
  }
  return ok({
    commands: commands.map((command) => shellCommand(command)),
    workflowUrl,
    dryRun: !yes,
  });
}

/** Runner-side release: uses the same builders and upload verification as before. */
export async function publishCI(
  releaseTag?: string,
  root = repository,
  runner: CommandRunner = run,
) {
  const info = await packageInfo("agx", root);
  if (info.isErr()) return info;
  const tag = info.value.tag;
  const libraryTag = `usehooks-v${info.value.version}`;
  if (
    releaseTag !== undefined &&
    releaseTag !== tag &&
    releaseTag !== libraryTag
  )
    return err(`Tag does not match suite version: ${releaseTag}`);
  const head = await runner(["git", "rev-parse", "HEAD"], root);
  if (head.exit !== 0) return err("Cannot resolve HEAD");
  const previous = await runner(
    ["git", "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD^"],
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
  const suiteAssets: { archive: string; sha256: string }[] = [];
  for (const compileTarget of releaseTag === libraryTag ? [] : suiteTargets) {
    const built = await build("suite", compileTarget, root, runner);
    if (built.isErr()) return built;
    suiteAssets.push(...built.value.assets);
  }
  const library =
    releaseTag === tag
      ? ok({ assets: [] })
      : await build("agx-usehooks", undefined, root, runner);
  if (library.isErr()) return library;
  const notes = join(root, "dist/suite/release-notes.md");
  await Bun.write(notes, section.value);
  const commands: string[] = [];
  for (const release of [
    { tag: libraryTag, assets: library.value.assets, latest: false },
    { tag, assets: suiteAssets, latest: true },
  ].filter(
    (candidate) => releaseTag === undefined || candidate.tag === releaseTag,
  )) {
    const published = await publishAssets(
      release.tag,
      release.assets,
      release.latest,
      notes,
      true,
      root,
      runner,
    );
    if (published.isErr()) return published;
    commands.push(...published.value);
  }
  return ok({
    archive: suiteAssets[0]?.archive ?? "",
    sha256: suiteAssets[0]?.sha256 ?? "",
    assets: [...suiteAssets, ...library.value.assets],
    commands,
    dryRun: false,
  });
}

async function publishAssets(
  tag: string,
  releaseAssets: { archive: string; sha256: string }[],
  latest: boolean,
  notes: string,
  yes: boolean,
  root: string,
  runner: CommandRunner,
) {
  const assets = await Promise.all(
    releaseAssets.map(async ({ archive }) => ({
      archive,
      name: basename(archive),
      size: (await stat(archive)).size,
    })),
  );
  const create = [
    "gh",
    "release",
    "create",
    tag,
    "--draft",
    "--title",
    tag,
    "--notes-file",
    notes,
    "--verify-tag",
  ];
  const upload = (archive: string, retry = false) => [
    "gh",
    "release",
    "upload",
    tag,
    archive,
    ...(retry ? ["--clobber"] : []),
  ];
  const view = ["gh", "release", "view", tag, "--json", "assets"];
  const edit = [
    "gh",
    "release",
    "edit",
    tag,
    "--draft=false",
    latest ? "--latest" : "--latest=false",
  ];
  const tags: string[][] = [];
  const commands = [
    ...tags,
    create,
    ...assets.map((asset) => upload(asset.archive)),
    view,
    edit,
  ];
  if (!yes) return ok(commands.map((command) => shellCommand(command)));
  const recovery = [
    `Recover the existing draft ${tag}; do not re-create the release or rerun publish:`,
    ...assets.map((asset) => shellCommand(upload(asset.archive, true))),
    shellCommand(view),
    `Check every asset is uploaded with these byte sizes: ${assets.map((asset) => `${asset.name}=${asset.size}`).join(", ")}. Only then run:`,
    shellCommand(edit),
  ].join("\n");
  for (const command of [...tags, create]) {
    const result = await runner(command, root);
    if (result.exit !== 0)
      return err(
        `Release stopped at ${commandFailure(command, result)}${command === create ? `\nCreation may have left a draft; inspect it first.\n${recovery}` : ""}`,
      );
  }
  for (const asset of assets) {
    const uploaded = await uploadAsset(upload(asset.archive), root, runner);
    if (uploaded.isErr())
      return err(
        `Asset upload failed for ${asset.name} after 3 attempts. Draft ${tag} retained.\n${uploaded.error}\n${recovery}`,
      );
  }
  const inspected = await runner(view, root);
  if (inspected.exit !== 0)
    return err(
      `Cannot verify assets ${assets.map((asset) => asset.name).join(", ")}. Draft ${tag} retained.\n${commandFailure(view, inspected)}\n${recovery}`,
    );
  const remote = jsonOf(releaseAssetsSchema).safeParse(inspected.stdout);
  if (!remote.success)
    return err(
      `Cannot verify assets ${assets.map((asset) => asset.name).join(", ")}: invalid gh release view response: ${remote.error.message}. Draft ${tag} retained.\n${recovery}`,
    );
  for (const asset of assets) {
    const matches = remote.data.assets.filter(
      (entry) => entry.name === asset.name,
    );
    const found = matches[0];
    if (
      matches.length !== 1 ||
      found?.state !== "uploaded" ||
      found.size !== asset.size
    )
      return err(
        `Asset verification failed for ${asset.name}: expected uploaded, ${asset.size} bytes; got ${JSON.stringify(matches)}. Draft ${tag} retained.\n${recovery}`,
      );
  }
  const published = await runner(edit, root);
  if (published.exit !== 0)
    return err(
      `Release finalization failed for ${tag}. Assets verified; inspect the release state before recovery.\n${commandFailure(edit, published)}\n${recovery}`,
    );
  return ok(commands.map((command) => shellCommand(command)));
}

export type MachineOptions = {
  verifyIn?: string[] | undefined;
  waitSeconds?: number | undefined;
  pollSeconds?: number | undefined;
};

/** Read-only consumer probes; installation runs outside repository configuration. */
export async function machineSwap(
  version: string,
  options: MachineOptions = {},
  root = repository,
  runner: CommandRunner = run,
) {
  const home = homedir();
  const execute: CommandRunner = (cmd, cwd) =>
    fromPromise(
      Promise.resolve().then(() => runner(cmd, cwd)),
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    ).match(
      (value) => value,
      (stderr) => ({ exit: 1, stdout: "", stderr }),
    );
  const waitSeconds = options.waitSeconds ?? 900;
  const pollSeconds = options.pollSeconds ?? 5;
  if (
    !Number.isFinite(waitSeconds) ||
    waitSeconds < 0 ||
    !Number.isFinite(pollSeconds) ||
    pollSeconds <= 0
  )
    return err(`asset-wait in ${root}: invalid wait or poll interval`);
  const expected = suiteTargets.map((target) =>
    suiteArchiveName(version, target)._unsafeUnwrap(),
  );
  const deadline = performance.now() + waitSeconds * 1000;
  let detail = "release unavailable";
  while (true) {
    const view = await execute(
      [
        "gh",
        "release",
        "view",
        `v${version}`,
        "--repo",
        "fuyutarow/agx",
        "--json",
        "assets,isDraft",
      ],
      root,
    );
    const parsed = jsonOf(
      releaseAssetsSchema.extend({ isDraft: z.boolean() }),
    ).safeParse(view.stdout);
    if (view.exit === 0 && parsed.success) {
      const missing = expected.filter((name) => {
        const matches = parsed.data.assets.filter(
          (asset) => asset.name === name,
        );
        return (
          matches.length !== 1 ||
          matches[0]?.state !== "uploaded" ||
          (matches[0]?.size ?? 0) <= 0
        );
      });
      const ready = !parsed.data.isDraft && missing.length === 0;
      detail = ready
        ? "ready"
        : `draft=${parsed.data.isDraft}; missing or incomplete: ${missing.join(", ")}`;
    } else detail = `${view.stderr} ${view.stdout}`.trim();
    if (detail === "ready") break;
    if (performance.now() >= deadline)
      return err(`asset-wait in ${root}: v${version}: ${detail}`);
    await Bun.sleep(
      Math.min(pollSeconds * 1000, Math.max(0, deadline - performance.now())),
    );
  }
  const install = await execute(
    ["mise", "install", `github:fuyutarow/agx@${version}`],
    home,
  );
  if (install.exit !== 0)
    return err(`install in ${home}: ${install.stderr}${install.stdout}`);
  const directories = [
    ...new Set([
      home,
      ...(options.verifyIn ?? []).map((dir) => resolve(root, dir)),
    ]),
  ];
  for (const dir of directories) {
    const checked = await execute(
      ["mise", "exec", "-C", dir, "--", "agx", "-V"],
      home,
    );
    if (
      checked.exit !== 0 ||
      checked.stderr !== "" ||
      (checked.stdout !== `agx ${version}\n` &&
        checked.stdout !== `agx ${version}`)
    )
      return err(
        `verify in ${dir}: expected agx ${version}; exit ${checked.exit}; stdout=${JSON.stringify(checked.stdout)} stderr=${JSON.stringify(checked.stderr)}`,
      );
    process.stdout.write(`OK ${dir}: agx ${version}\n`);
  }
  return ok(undefined);
}
