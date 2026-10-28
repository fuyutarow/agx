import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { attempt, errorMessage, type Attempt } from "./attempt.ts";
import { JJ_READ_ARGS } from "./jj-read.ts";
import { readonlyCommand } from "./readonly-command.ts";
import { z } from "./zod.ts";

/** Only this error class changes the ticket CLI's existing failure exit code. */
export class AgxConfigError extends Error {}
/** Inspection did not produce a policy verdict; callers must preserve exit 75. */
export class InspectionUnavailable extends AgxConfigError {}
export class InspectionTimeout extends InspectionUnavailable {
  constructor(
    bound: string,
    milliseconds: number,
    argv: string[],
    cwd: string,
  ) {
    super(
      `inspection timeout ${bound}=${milliseconds}ms; command=${JSON.stringify(argv)}; cwd=${cwd}`,
    );
  }
}
export const CONFIG_READ_TIMEOUT_MS = 60_000;
const NonEmptyStrings = z.array(
  z.string().refine((value) => value.trim().length > 0, "must not be empty"),
);
const VerifyConfig = z.strictObject({
  always: NonEmptyStrings.optional(),
});
const RegenerablePaths = z.array(
  z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.includes("\\") &&
        path
          .replace(/\/$/u, "")
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
      "expected a literal repository-relative path without . or .. components",
    ),
);
const WorkspaceConfig = z.strictObject({
  ready: NonEmptyStrings.optional(),
  trunk: z.string().min(1).optional(),
  keep: NonEmptyStrings.optional(),
  regenerable: RegenerablePaths.optional(),
});
const LocalWorkspaceConfig = z.strictObject({
  ready: NonEmptyStrings.optional(),
  keep: NonEmptyStrings.optional(),
});
const Config = z.strictObject({
  schema: z.literal(1),
  tickets: z.string().trim().min(1).optional(),
  ws: WorkspaceConfig.optional(),
  verify: VerifyConfig.optional(),
});
const ConfigEnvelope = z.record(z.string(), z.unknown());
const LocalConfig = z.strictObject({
  schema: z.literal(1),
  tickets: z.string().trim().min(1).optional(),
  ws: LocalWorkspaceConfig.optional(),
  verify: VerifyConfig.optional(),
  usehooks: z
    .strictObject({
      hooks: z.string().min(1),
      link_task: z.string().min(1),
      link_path: z.string().min(1),
      command: z.array(z.string()).min(1),
    })
    .optional(),
  root: z
    .string()
    .refine(isAbsolute, "root must be an absolute main-checkout path"),
});
/** Normalize BigInt parser output without rounding values outside JS's exact integer range. */
export function normalizeTomlIntegers(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  if (Array.isArray(value)) return value.map(normalizeTomlIntegers);
  if (value === null || typeof value !== "object" || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeTomlIntegers(entry),
    ]),
  );
}
const decodeToml = (text: string): unknown =>
  normalizeTomlIntegers(Bun.TOML.parse(text));
const missing = (error: unknown) =>
  z.object({ code: z.literal("ENOENT") }).safeParse(error).success;
const failure = (message: string) => ({
  ok: false as const,
  error: new AgxConfigError(message.replaceAll(/[\r\n]+/gu, " ")),
});
const good = <T>(value: T) => ({ ok: true as const, value });
const configValue = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? `${item}n` : item,
  ) ?? String(value);
const configIssueMessage = (error: z.ZodError): string =>
  error.issues
    .flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map(
            (key) =>
              `${[...issue.path, key].map(String).join(".")}: unknown key`,
          )
        : [`${issue.path.map(String).join(".") || "config"}: ${issue.message}`],
    )
    .join("; ");
type Vcs = "jj" | "git" | "none";
type CommittedPolicy =
  | { text: string; revision: string; vcs: "jj" | "git" }
  | { text: undefined; revision: string | undefined; vcs: Vcs };
type ConfiguredPolicy = Extract<CommittedPolicy, { text: string }>;

async function configRefusal(
  root: string,
  policy: ConfiguredPolicy,
  reason: string,
): Promise<Attempt<never>> {
  const path = join(root, "agx.toml");
  let revision = policy.revision;
  if (policy.vcs === "jj") {
    const identity = await readCommand(
      [
        "jj",
        ...JJ_READ_ARGS,
        "log",
        "--no-graph",
        "-r",
        policy.revision,
        "-T",
        'bookmarks.join(", ") ++ " " ++ commit_id.short(8)',
      ],
      root,
    );
    revision =
      identity.ok && identity.value.trim() !== ""
        ? identity.value.trim()
        : `${policy.revision} (revision id unavailable)`;
  }
  const workingCopy = await attempt(() => readFile(path, "utf8"));
  let workingCopyNote =
    "; working copy could not be compared; only the committed revision is read";
  if (workingCopy.ok) {
    if (workingCopy.value.trimEnd() === policy.text) workingCopyNote = "";
    else
      workingCopyNote =
        "; working copy differs from this revision; working copy policy is not read";
  } else if (missing(workingCopy.error))
    workingCopyNote =
      "; working copy differs from this revision; working copy policy is not read";
  return failure(`${path} at ${revision}${workingCopyNote}: ${reason}`);
}
type ResolvedAgxConfig = {
  root: string;
  tickets: string;
  ready: string[];
  trunk: string;
  trunkConfigured: boolean;
  keep: string[];
  regenerable: string[];
  verifyAlways: string[];
};
export type ResolvedAgxConfigWithProvenance = ResolvedAgxConfig & {
  policyRevision: string | undefined;
  workingCopyPolicyDiffers: boolean | undefined;
};

export async function readCommand(
  argv: string[],
  cwd: string,
  timeoutMs = CONFIG_READ_TIMEOUT_MS,
): Promise<Attempt<string>> {
  const result = await attempt(async () => {
    const invocation = readonlyCommand(argv, cwd);
    const started = performance.now();
    const child = Bun.spawn(invocation.cmd, {
      cwd,
      env: invocation.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Allow the same lock-contention window as repository landing reads.
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exit,
      out,
      err,
      timedOut:
        child.signalCode === "SIGKILL" &&
        performance.now() - started >= timeoutMs,
    };
  });
  if (!result.ok) return result;
  if (result.value.timedOut)
    return {
      ok: false,
      error: new InspectionTimeout(
        "CONFIG_READ_TIMEOUT_MS",
        timeoutMs,
        argv,
        cwd,
      ),
    };
  if (result.value.exit === 75)
    return {
      ok: false,
      error: new InspectionUnavailable(
        result.value.err.trim() === ""
          ? `inspection unavailable; command=${JSON.stringify(argv)}; cwd=${cwd}; exit=75; no stderr`
          : result.value.err.trim().replaceAll(/[\r\n]+/gu, "; "),
      ),
    };
  if (result.value.exit === 0) return good(result.value.out.trimEnd());
  const reason =
    result.value.err.trim() === "" ? "no stderr" : result.value.err.trim();
  return failure(
    `config read ${JSON.stringify(argv)} in ${cwd} exited ${result.value.exit}: ${reason}`,
  );
}

async function committedPolicy(
  root: string,
  vcs: Vcs,
): Promise<Attempt<CommittedPolicy>> {
  if (vcs === "none")
    return good({ revision: undefined, text: undefined, vcs });
  let revision: string | undefined;
  if (vcs === "git") {
    const head = await readCommand(
      ["git", "--no-optional-locks", "rev-parse", "--verify", "HEAD^{commit}"],
      root,
    );
    if (!head.ok && head.error instanceof InspectionUnavailable) return head;
    if (!head.ok)
      return good({ revision: undefined, text: undefined, vcs });
    revision = head.value;
  } else {
    const selected = await readCommand(
      [
        "jj",
        ...JJ_READ_ARGS,
        "log",
        "--no-graph",
        "-r",
        "trunk()",
        "-T",
        'commit_id ++ "\\n"',
      ],
      root,
    );
    if (!selected.ok) return selected;
    const revisions = selected.value.split("\n").filter(Boolean);
    if (revisions.length > 1)
      return failure("trunk() must resolve to exactly one policy revision");
    revision = revisions[0];
  }
  if (revision === undefined)
    return good({ revision, text: undefined, vcs });
  const names = (rev: string) =>
    readCommand(
      vcs === "jj"
        ? [
            "jj",
            ...JJ_READ_ARGS,
            "file",
            "list",
            "-r",
            rev,
            ".agx.toml",
            "agx.toml",
          ]
        : [
            "git",
            "--no-optional-locks",
            "ls-tree",
            "--name-only",
            rev,
            "--",
            ".agx.toml",
            "agx.toml",
          ],
      root,
    );
  const inventory = await names(revision);
  if (!inventory.ok) return inventory;
  if (inventory.value.split("\n").includes(".agx.toml")) return retired(root);
  if (!inventory.value.split("\n").includes("agx.toml"))
    return good({ revision, text: undefined, vcs });
  const text = await readCommand(
    vcs === "jj"
      ? ["jj", ...JJ_READ_ARGS, "file", "show", "-r", revision, "agx.toml"]
      : ["git", "--no-optional-locks", "show", revision + ":agx.toml"],
    root,
  );
  return text.ok ? good({ revision, text: text.value, vcs }) : text;
}
const retired = (root: string) =>
  failure(
    `${join(root, ".agx.toml")} is retired; rename it: mv .agx.toml agx.toml (machine-local absolute paths go in $XDG_CONFIG_HOME/agx/repos/<name>.toml (default ~/.config/agx/repos/<name>.toml) with root = ${JSON.stringify(root)})`,
  );

/** Registered repositories are exactly the files in agx's machine-local L2 directory. */
export async function listAgxRepos(): Promise<
  Attempt<
    Array<{
      name: string;
      root: string;
      config: z.output<typeof LocalConfig>;
    }>
  >
> {
  const directory = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "agx/repos",
  );
  const entries = await attempt(() =>
    readdir(directory, { withFileTypes: true }),
  );
  if (!entries.ok) return missing(entries.error) ? good([]) : entries;
  const repos: Array<{
    name: string;
    root: string;
    config: z.output<typeof LocalConfig>;
  }> = [];
  for (const entry of entries.value.toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (
      !entry.name.endsWith(".toml") ||
      (!entry.isFile() && !entry.isSymbolicLink())
    )
      continue;
    const path = join(directory, entry.name);
    const raw = await attempt(async (): Promise<unknown> =>
      decodeToml(await readFile(path, "utf8")),
    );
    if (!raw.ok)
      return failure(`${path}: invalid TOML: ${errorMessage(raw.error)}`);
    const parsed = LocalConfig.safeParse(raw.value);
    if (!parsed.success) return failure(`${path}: ${parsed.error.message}`);
    if (repos.some((repo) => repo.root === parsed.data.root))
      return failure(
        `${directory}: two files claim root ${parsed.data.root}; keep one repository override`,
      );
    repos.push({
      name: entry.name.slice(0, -5),
      root: parsed.data.root,
      config: parsed.data,
    });
  }
  return good(repos);
}

async function localConfig(
  root: string,
): Promise<Attempt<z.output<typeof LocalConfig> | undefined>> {
  const repos = await listAgxRepos();
  if (!repos.ok) return repos;
  return good(repos.value.find((repo) => repo.root === root)?.config);
}

async function resolveConfig(
  repoRoot: string,
  options: { vcs?: Vcs },
): Promise<Attempt<ResolvedAgxConfigWithProvenance>> {
  const workspace = await realpath(repoRoot);
  const vcs =
    options.vcs ??
    ((await lstat(join(workspace, ".jj")).catch(() => null)) !== null
      ? "jj"
      : "git");
  let root = workspace;
  if (vcs === "jj") {
    const main = await readCommand(
      ["jj", ...JJ_READ_ARGS, "workspace", "root", "--name", "default"],
      workspace,
    );
    if (!main.ok) return main;
    root = await realpath(main.value);
  }
  const policy = await committedPolicy(root, vcs);
  if (!policy.ok) return policy;
  let workingCopyPolicyDiffers: boolean | undefined;
  if (policy.value.revision !== undefined) {
    const workingCopyPolicy = await attempt(() =>
      readFile(join(root, "agx.toml"), "utf8"),
    );
    if (workingCopyPolicy.ok)
      workingCopyPolicyDiffers =
        policy.value.text === undefined ||
        workingCopyPolicy.value.trimEnd() !== policy.value.text;
    else if (missing(workingCopyPolicy.error))
      workingCopyPolicyDiffers = policy.value.text !== undefined;
    else
      return failure(
        `${join(root, "agx.toml")}: cannot compare working-copy policy: ${errorMessage(workingCopyPolicy.error)}`,
      );
  }
  let tickets = ".agents/tickets";
  let ready: string[] = [];
  let trunk = "trunk()";
  let trunkConfigured = false;
  let keep: string[] = [];
  let regenerable: string[] = [];
  let verifyAlways: string[] = [];
  const committed = policy.value;
  if (committed.text !== undefined) {
    const text = committed.text;
    const decoded = await attempt((): unknown => decodeToml(text));
    if (!decoded.ok)
      return configRefusal(
        root,
        committed,
        `invalid TOML: ${errorMessage(decoded.error)}`,
      );
    const envelope = ConfigEnvelope.safeParse(decoded.value);
    if (!envelope.success)
      return configRefusal(root, committed, configIssueMessage(envelope.error));
    if (!Object.hasOwn(envelope.data, "schema"))
      return configRefusal(
        root,
        committed,
        "missing required schema; expected schema = 1",
      );
    const schema = z.literal(1).safeParse(envelope.data.schema);
    if (!schema.success)
      return configRefusal(
        root,
        committed,
        `unsupported schema ${configValue(envelope.data.schema)}; expected schema = 1`,
      );
    const parsed = Config.safeParse(envelope.data);
    if (!parsed.success)
      return configRefusal(root, committed, configIssueMessage(parsed.error));
    const declared = parsed.data.tickets;
    if (
      declared !== undefined &&
      (isAbsolute(declared) ||
        win32.isAbsolute(declared) ||
        declared.startsWith("~/"))
    )
      return configRefusal(
        root,
        committed,
        `tickets must be relative; move absolute paths into $XDG_CONFIG_HOME/agx/repos/<name>.toml (default ~/.config/agx/repos/<name>.toml) with root = ${JSON.stringify(root)}`,
      );
    tickets = declared ?? tickets;
    ready = parsed.data.ws?.ready ?? ready;
    trunk = parsed.data.ws?.trunk ?? trunk;
    trunkConfigured = parsed.data.ws?.trunk !== undefined;
    keep = parsed.data.ws?.keep ?? keep;
    regenerable = parsed.data.ws?.regenerable ?? regenerable;
    verifyAlways = parsed.data.verify?.always ?? verifyAlways;
  }
  const local = await localConfig(root);
  if (!local.ok) return local;
  tickets = local.value?.tickets ?? tickets;
  ready = local.value?.ws?.ready ?? ready;
  keep = [...new Set([...keep, ...(local.value?.ws?.keep ?? [])])];
  verifyAlways = local.value?.verify?.always ?? verifyAlways;
  return good({
    root,
    tickets: resolve(
      root,
      tickets.startsWith("~/") ? join(homedir(), tickets.slice(2)) : tickets,
    ),
    ready,
    trunk,
    trunkConfigured,
    keep,
    regenerable,
    verifyAlways,
    policyRevision: policy.value.revision,
    workingCopyPolicyDiffers,
  });
}

/** L1 is immutable trunk policy; XDG L2 is selected by the real main-checkout root. */
export async function resolveAgxConfig(
  repoRoot: string,
  options: { vcs?: Vcs } = {},
): Promise<Attempt<ResolvedAgxConfig>> {
  const result = await resolveAgxConfigWithProvenance(repoRoot, options);
  if (!result.ok) return result;
  const config = result.value;
  return good({
    root: config.root,
    tickets: config.tickets,
    ready: config.ready,
    trunk: config.trunk,
    trunkConfigured: config.trunkConfigured,
    keep: config.keep,
    regenerable: config.regenerable,
    verifyAlways: config.verifyAlways,
  });
}

/** Return the committed policy source so callers can explain workspace readiness decisions. */
export async function resolveAgxConfigWithProvenance(
  repoRoot: string,
  options: { vcs?: Vcs } = {},
): Promise<Attempt<ResolvedAgxConfigWithProvenance>> {
  const result = await attempt(() => resolveConfig(repoRoot, options));
  const resolved = result.ok ? result.value : result;
  if (resolved.ok) return resolved;
  if (resolved.error instanceof AgxConfigError) return resolved;
  return failure(
    `${repoRoot}: cannot resolve agx configuration: ${errorMessage(resolved.error)}`,
  );
}
