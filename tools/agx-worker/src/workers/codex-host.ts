import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fromThrowable } from "neverthrow";
import { errorMessage } from "../../../shared/src/attempt.ts";
import { z } from "../../../shared/src/zod.ts";

const HostDeclaration = z
  .object({
    schema: z.literal(1),
    unsandboxed_reason: z.string().trim().min(1),
  })
  .strict();

export type CodexHostDeclaration = Readonly<{
  unsandboxedReason: string;
}>;

export type CodexHostDeclarationResult =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "valid"; declaration: CodexHostDeclaration }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export function codexHostDeclarationPath(): string {
  return (
    process.env.AGX_CODEX_HOST_FILE ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "agx",
      "host.toml",
    )
  );
}

function fileError(error: unknown) {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  return {
    code: parsed.success ? parsed.data.code : undefined,
    reason: errorMessage(error),
  };
}

function retiredHostPath(path: string): string | undefined {
  const directory = dirname(path);
  return basename(directory) === "agx"
    ? join(dirname(directory), "codex-run", "host.toml")
    : undefined;
}

function missingHostDeclaration(path: string): CodexHostDeclarationResult {
  const legacyPath = retiredHostPath(path);
  if (legacyPath === undefined) return { kind: "absent" };
  const legacy = fromThrowable(() => lstatSync(legacyPath), fileError)();
  if (legacy.isOk())
    return {
      kind: "invalid",
      reason: `legacy host declaration found; run: mv "${legacyPath}" "${path}"`,
    };
  return legacy.error.code === "ENOENT"
    ? { kind: "absent" }
    : { kind: "invalid", reason: legacy.error.reason };
}

/** Parse the one agx host declaration schema. */
export function readCodexHostDeclaration(
  path: string,
): CodexHostDeclarationResult {
  const metadata = fromThrowable(() => lstatSync(path), fileError)();
  if (metadata.isErr()) {
    if (metadata.error.code !== "ENOENT")
      return { kind: "invalid", reason: metadata.error.reason };
    return missingHostDeclaration(path);
  }
  if (!metadata.value.isFile())
    return {
      kind: "invalid",
      reason: `${path} must be a regular file, not a symlink or directory`,
    };
  const hostText = fromThrowable(
    () => readFileSync(path, "utf8"),
    (error) => errorMessage(error),
  )();
  if (hostText.isErr()) {
    return { kind: "invalid", reason: hostText.error };
  }

  const toml = fromThrowable(
    () => Bun.TOML.parse(hostText.value),
    errorMessage,
  )();
  const parsed = toml.isOk()
    ? HostDeclaration.safeParse(toml.value)
    : undefined;
  if (parsed?.success !== true)
    return {
      kind: "invalid",
      reason: `${path} is not a valid host declaration (want exactly: schema = 1, unsandboxed_reason = "<why this box is itself the isolation>"): ${toml.isOk() ? (parsed?.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? "") : toml.error}`,
    };

  return {
    kind: "valid",
    declaration: { unsandboxedReason: parsed.data.unsandboxed_reason },
  };
}

/** Exclusive owner writer; never truncates an existing file or follows a final symlink. */
export function declareCodexHost(
  path: string,
  reason: string,
): CodexHostDeclarationResult {
  const parsed = HostDeclaration.safeParse({
    schema: 1,
    unsandboxed_reason: reason,
  });
  if (!parsed.success)
    return {
      kind: "invalid",
      reason: "--unsandboxed-reason must contain non-whitespace text",
    };
  const existing = readCodexHostDeclaration(path);
  if (existing.kind !== "absent")
    return {
      kind: "invalid",
      reason:
        existing.kind === "invalid"
          ? existing.reason
          : `${path} already exists; declaration was not changed`,
    };
  const written = fromThrowable(() => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    using _file = {
      [Symbol.dispose]: () => {
        closeSync(fd);
      },
    };
    writeFileSync(
      fd,
      `schema = 1\nunsandboxed_reason = ${JSON.stringify(parsed.data.unsandboxed_reason)}\n`,
    );
  }, errorMessage)();
  if (written.isErr()) return { kind: "invalid", reason: written.error };
  return readCodexHostDeclaration(path);
}
