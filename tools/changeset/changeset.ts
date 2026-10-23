import { ResultAsync as AsyncResult } from "neverthrow";
import { access as accessPath } from "node:fs/promises";

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cli } from "cleye";
import { err, ok, type Result } from "neverthrow";
import { jsonOf, z } from "../zod.ts";

export const repository = resolve(import.meta.dir, "../..");
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Directory names identify packages; manifest names may be scoped. */
export async function readPackage(root: string, pkg: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(pkg))
    return err(new Error(`Unknown package: ${pkg}`));
  const dir = join(root, "tools", pkg);
  const manifest = Bun.file(join(dir, "package.json"));
  if (!(await manifest.exists()))
    return err(
      new Error(`Unknown package: ${pkg} (expected tools/${pkg}/package.json)`),
    );
  const parsed = jsonOf(z.record(z.string(), z.unknown())).safeParse(
    await manifest.text(),
  );
  if (!parsed.success)
    return err(
      new Error(
        `tools/${pkg}/package.json: invalid package JSON or missing version`,
      ),
    );
  const version = z.string().safeParse(parsed.data.version);
  if (!version.success)
    return err(new Error(`tools/${pkg}/package.json: missing version`));
  return ok({ dir, manifest: { ...parsed.data, version: version.data } });
}

const pathExists = (path: Parameters<typeof accessPath>[0]) =>
  accessPath(path).then(
    () => true,
    () => false,
  );

const BumpSchema = z.enum(["patch", "minor", "major"]);

export const ChangesetSchema = z.strictObject({
  bump: BumpSchema,
  entry: z
    .string()
    .trim()
    .min(1, "entry must not be empty")
    .refine((entry) => !/[\r\n]/u.test(entry), "entry must be one line")
    .refine(
      (entry) => !entry.startsWith("-") && !entry.startsWith("#"),
      "entry must be plain text, not a Markdown bullet or heading",
    ),
});

export type Changeset = z.infer<typeof ChangesetSchema>;

export function parseChangeset(text: string): Result<Changeset, Error> {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const hasOpeningDelimiter = lines[0] === "---";
  if (hasOpeningDelimiter) lines.shift();

  const bumpLine = lines.shift();
  if (bumpLine === undefined || !bumpLine.startsWith("bump: "))
    return err(new Error("expected bump: patch|minor|major"));
  const bump = BumpSchema.safeParse(bumpLine.slice("bump: ".length));
  if (!bump.success)
    return err(new Error("bump must be patch, minor, or major"));

  if (hasOpeningDelimiter && lines.shift() !== "---")
    return err(new Error("expected closing --- delimiter after bump"));
  if (lines[0] === "") lines.shift();

  const checked = ChangesetSchema.safeParse({
    bump: bump.data,
    entry: lines.join("\n"),
  });
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return err(new Error(issue?.message ?? "invalid changeset"));
  }
  return ok(checked.data);
}

/** The canonical Markdown form retained by the repository formatter. */
export function formatChangeset(changeset: Changeset): string {
  return `---\nbump: ${changeset.bump}\n---\n\n${changeset.entry}\n`;
}

export function changesetDiagnostic(path: string, reason: string): string {
  return `${path}: ${reason}; create a correct changeset with mise run changeset -- <pkg> <patch|minor|major> "<entry>"`;
}

const rejectPrototypeFlag = (type: string, flag: string): void => {
  if (type === "unknown-flag" && flag === "__proto__") {
    process.stderr.write("FATAL: unknown option --__proto__\n");
    process.exit(2);
  }
};

function slugOf(entry: string): string {
  const slug = entry
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 64)
    .replace(/-$/u, "");
  return slug.length === 0 ? "change" : slug;
}

async function uniqueSlug(changesDir: string, base: string): Promise<string> {
  let slug = base;
  let suffix = 2;
  while (await pathExists(join(changesDir, `${slug}.md`))) {
    slug = `${base}-${suffix}`;
    suffix++;
  }
  return slug;
}

export async function writeChangeset(
  root: string,
  tool: string,
  bump: string,
  entry: string,
): Promise<Result<string, Error>> {
  const checked = ChangesetSchema.safeParse({ bump, entry });
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return err(new Error(issue?.message ?? "invalid changeset"));
  }

  const info = await readPackage(root, tool);
  if (info.isErr()) return info;
  const changesDir = join(info.value.dir, ".changes");
  const written = await fromAsyncThrowable(
    async () => {
      await mkdir(changesDir, { recursive: true });
      const slug = await uniqueSlug(changesDir, slugOf(checked.data.entry));
      const path = join(changesDir, `${slug}.md`);
      await writeFile(path, formatChangeset(checked.data), { flag: "wx" });
      return `tools/${tool}/.changes/${slug}.md`;
    },
    (error) => new Error(errorMessage(error)),
  )();
  if (written.isErr()) return err(written.error);
  return ok(written.value);
}

async function main() {
  const parsed = cli({
    name: "changeset",
    parameters: ["<pkg>", "<bump>", "<entry>"],
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
  });
  if (parsed._.length !== 3) {
    process.stderr.write(
      'FATAL: usage: mise run changeset -- <pkg> <patch|minor|major> "<entry>"\n',
    );
    process.exitCode = 2;
  } else
    writeResult(
      await writeChangeset(
        repository,
        String(parsed._[0]),
        String(parsed._[1]),
        String(parsed._[2]),
      ),
    );
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    process.stderr.write(`FATAL: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  });

function writeResult(result: Result<string, Error>): void {
  if (result.isErr()) {
    process.stderr.write(`FATAL: ${result.error.message}\n`);
    process.exitCode = 2;
  } else process.stdout.write(`WROTE ${result.value}\n`);
}

function fromAsyncThrowable<A extends unknown[], T, E = unknown>(
  fn: (...args: A) => Promise<T>,
  mapError: (error: unknown) => E,
) {
  return (...args: A) =>
    AsyncResult.fromPromise(
      Promise.resolve().then(() => fn(...args)),
      (error: unknown) => mapError(error),
    );
}
