import {
  appendFileSync,
  closeSync,
  openSync,
  fstatSync,
  readSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  rename,
  realpath,
  writeFile,
  stat as recordStat,
} from "node:fs/promises";
import { dlopen, FFIType } from "bun:ffi";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fromPromise, fromThrowable } from "neverthrow";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { globsOverlap } from "../ticket.ts";
import { exitWithError } from "./exit.ts";
import { Outcome, deriveOutcome } from "./outcome.ts";
import { lossEvidence, Lease, StopSignal, Evidence } from "./lease.ts";
import {
  LegacyIdentity,
  RunSchema,
  type FoldedRun,
  type ListedRun,
} from "./run-state.ts";
export type { ListedRun } from "./run-state.ts";
import { VerifyResult } from "./verify.ts";
import { runningSummary, listingRows } from "./listing.ts";
import { runHealth } from "./health.ts";
import { ticketContext } from "./ticket-home.ts";
import { Sandbox, SandboxSource } from "./sandbox.ts";

import { recordRoutingPick } from "./routing-events.ts";

export const PickAuditSchema = z.object({
  audit: z.record(z.string(), z.unknown()).optional(),
  source: z.string(),
  anonymization_map: z.record(z.string(), z.string()).optional(),
  answer: z.unknown().optional(),
  probabilities: z.record(z.string(), z.number()).nullable(),
  usage_snapshot: z.unknown(),
  usage_id: z.string().optional(),
  measured_evidence: z
    .record(
      z.string(),
      z.object({
        judged_runs: z.number(),
        accepted_runs: z.number(),
        accepted_percent: z.number().nullable(),
        ended_runs: z.number(),
        median_wall_minutes: z.number().nullable(),
        text: z.string(),
      }),
    )
    .optional(),
  candidates: z.array(z.string()).optional(),
  chosen_row: z.string().optional(),
});
export type PickAudit = z.output<typeof PickAuditSchema>;

let pendingPickAudit: PickAudit | undefined;
export function setPendingPickAudit(audit: PickAudit): void {
  pendingPickAudit = audit;
  if (audit.audit?.launch_expected !== true) return;
  const root = stateDir();
  process.once("exit", (exit) => {
    if (
      pendingPickAudit === audit &&
      audit.audit !== undefined &&
      audit.audit.ticket_path !== null
    )
      recordRoutingPick(
        null,
        "pre-start-failure",
        { ...audit.audit, outcome_kind: "held", exit },
        "pre-start failure",
        root,
      );
  });
}

const EventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refusal"),
    legacy_key: z.string().optional(),
    id: z.string(),
    at: z.string(),
    ticket_path: z.string(),
    ticket_sha256: z.string().nullable(),
    cwd: z.string(),
    violations: z.array(z.string()),
  }),
  z.looseObject({
    kind: z.literal("started"),
    id: z.string(),
    at: z.string(),
    ticket: z.string(),
    writes: z.array(z.string()),
    cwd: z.string(),
    workspace: z.string(),
    worker_name: z.string().optional(),
    unit: z.string().optional(),
    workspace_name: z.string().optional(),
    row: z.string(),
    route: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    sandbox: Sandbox.optional(),
    sandbox_source: SandboxSource.optional(),
    sandbox_effective: z.string().optional(),
    sandbox_effective_source: z.string().optional(),
    dispatcher_session: z.string().nullable(),
    vendor_session: z.string().nullable(),
    continues: z.string().nullable().optional(),
    supersedes: z.string().nullable().optional(),
    base_rev: z.string().optional(),
    premise_commits: z
      .array(z.object({ premise: z.string(), commit: z.string() }))
      .optional(),
    ticket_path: z.string().optional(),
    ticket_orig_path: z.string().optional(),
    ticket_sha256: z.string().optional(),
    pid: z.number(),
    lease: Lease.optional(),
    pick_audit: PickAuditSchema.optional(),
    legacy_key: z.string().optional(),
    legacy: LegacyIdentity.optional(),
  }),
  z.looseObject({
    kind: z.literal("dispatching"),
    id: z.string(),
    at: z.string(),
    ticket: z.string(),
    writes: z.array(z.string()),
    cwd: z.string(),
    workspace: z.string(),
    worker_name: z.string().optional(),
    unit: z.string().optional(),
    workspace_name: z.string().optional(),
    route: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    sandbox: Sandbox.optional(),
    sandbox_source: SandboxSource.optional(),
    sandbox_effective: z.string().optional(),
    sandbox_effective_source: z.string().optional(),
    dispatcher_session: z.string().nullable(),
    vendor_session: z.string().nullable(),
    continues: z.string().nullable().optional(),
    supersedes: z.string().nullable().optional(),
    base_rev: z.string().optional(),
    premise_commits: z
      .array(z.object({ premise: z.string(), commit: z.string() }))
      .optional(),
    ticket_path: z.string().optional(),
    ticket_orig_path: z.string().optional(),
    ticket_sha256: z.string().optional(),
    pid: z.number(),
    lease: Lease.optional(),
    pick_audit: PickAuditSchema.optional(),
    legacy_key: z.string().optional(),
    legacy: LegacyIdentity.optional(),
  }),
  z.looseObject({
    kind: z.literal("session"),
    legacy_key: z.string().optional(),
    id: z.string(),
    at: z.string(),
    vendor_session: z.string(),
  }),
  z.looseObject({
    kind: z.literal("stop-requested"),
    legacy_key: z.string().optional(),
    id: z.string(),
    at: z.string(),
    stopped_by: z.string(),
    vendor_session: z.string().nullable().optional(),
  }),
  z.looseObject({
    kind: z.literal("progress"),
    id: z.string(),
    at: z.string(),
    path: z.string(),
    legacy_key: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("late"),
    id: z.string(),
    at: z.string(),
    first_return_s: z.number().int().positive(),
    elapsed: z.number().nonnegative(),
    legacy_key: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("ended"),
    id: z.string(),
    at: z.string(),
    exit: z.number(),
    outcome: Outcome.optional(),
    launch_stderr: z.string().optional(),
    evidence: Evidence.optional(),
    signal: StopSignal.optional(),
    stopped_by: z.string().optional(),
    report_path: z.string().nullable(),
    vendor_session: z.string().nullable(),
    rows: z.array(z.string()).optional(),
    final_row: z
      .object({
        id: z.string(),
        route: z.string(),
        model: z.string(),
        effort: z.string(),
      })
      .optional(),
    verify: z.array(VerifyResult).default([]),
    returned: z.boolean().optional(),
    changed_files: z.number().int().nonnegative().optional(),
    legacy_key: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("judged"),
    id: z.string(),
    at: z.string(),
    decision: z.string(),
    note: z.string(),
    evidence: z
      .array(
        z.object({ path: z.string(), sha256: z.string(), content: z.string() }),
      )
      .optional(),
    legacy_key: z.string().optional(),
  }),
]);
export type NextEvent = z.output<typeof EventSchema>;
const EventTextSchema = jsonOf(EventSchema);

import { stateDir } from "../state.ts";
export { stateDir };
export const recordPath = (root = stateDir()): string =>
  join(root, "records.jsonl");
export const now = (): string => Temporal.Now.instant().toString();

type AcquiredWorkspaceLock = Readonly<{
  ok: true;
  release: () => Promise<void>;
}>;
type WorkspaceLock =
  | AcquiredWorkspaceLock
  | Readonly<{ ok: false; error: string }>;
const WORKSPACE_LOCK_BUSY = "workspace lock is busy or unavailable";
const workspaceLockPath = (workspace: string, root: string) => {
  const key = createHash("sha256").update(resolve(workspace)).digest("hex");
  return join(root, "locks", key);
};

function linuxDeviceNumbers(device: bigint) {
  return {
    major: Number(
      ((device & 0x00000000000fff00n) >> 8n) |
        ((device & 0xfffff00000000000n) >> 32n),
    ),
    minor: Number(
      (device & 0x00000000000000ffn) | ((device & 0x00000ffffff00000n) >> 12n),
    ),
  };
}

function processCommand(pid: number): string {
  let fromProc = "";
  try {
    fromProc = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replaceAll("\0", " ")
      .trim();
  } catch {
    // /proc is Linux-only and the holder may exit between lookup and inspection.
  }
  if (fromProc !== "") return fromProc.slice(0, 300);
  const result = Bun.spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "command="],
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.stdout.toString("utf8").trim().slice(0, 300);
}

function lockHolder(
  path: string,
): { pid: number; command: string } | undefined {
  if (process.platform === "linux") {
    const info = statSync(path, { bigint: true });
    const { major, minor } = linuxDeviceNumbers(info.dev);
    const lines = readFileSync("/proc/locks", "utf8").split("\n");
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (
        fields[1] !== "FLOCK" ||
        fields[2] !== "ADVISORY" ||
        fields[3] !== "WRITE"
      )
        continue;
      const pid = Number(fields[4]);
      const [lockMajor, lockMinor, inode] = (fields[5] ?? "").split(":");
      if (
        !Number.isInteger(pid) ||
        lockMajor === undefined ||
        lockMinor === undefined ||
        inode === undefined ||
        Number.parseInt(lockMajor, 16) !== major ||
        Number.parseInt(lockMinor, 16) !== minor ||
        BigInt(inode) !== info.ino
      )
        continue;
      return { pid, command: processCommand(pid) || "(unavailable)" };
    }
    return undefined;
  }

  const result = Bun.spawnSync({
    cmd: ["lsof", "-t", path],
    stdout: "pipe",
    stderr: "ignore",
  });
  const pid = Number(result.stdout.toString("utf8").trim().split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, command: processCommand(pid) || "(unavailable)" };
}

/** The file is only a stable inode; ownership lives in the kernel, never in its contents. */
export async function acquireWorkspaceLock(
  workspace: string,
  root = stateDir(),
): Promise<WorkspaceLock> {
  const library = fromThrowable(() =>
    dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }),
  )();
  if (library.isErr())
    return { ok: false, error: `cannot load flock: ${String(library.error)}` };
  const opened = await fromPromise(
    mkdir(join(root, "locks"), { recursive: true }).then(() =>
      open(workspaceLockPath(workspace, root), "a"),
    ),
    String,
  );
  if (opened.isErr()) {
    library.value.close();
    return { ok: false, error: `cannot open workspace lock: ${opened.error}` };
  }
  const file = opened.value;
  // LOCK_EX | LOCK_NB on both Linux and macOS. Node opens the descriptor close-on-exec,
  // so workers cannot inherit ownership and keep a dead dispatcher's lock alive.
  if (library.value.symbols.flock(file.fd, 2 | 4) !== 0) {
    await file.close();
    library.value.close();
    return { ok: false, error: WORKSPACE_LOCK_BUSY };
  }
  return {
    ok: true,
    release: async () => {
      await file.close();
      library.value.close();
      // Never unlink: another process may already have opened this same inode.
    },
  };
}

/** Retry a workspace lock without blocking the event loop; return its owner at the bound. */
export type WorkspaceLockWaitClock = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
};

export async function acquireWorkspaceLockUntilAvailable(
  workspace: string,
  root = stateDir(),
  timeoutMs = 30_000,
  clock: WorkspaceLockWaitClock = {
    now: () => performance.now(),
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    pollIntervalMs: 5,
  },
): Promise<WorkspaceLock> {
  const path = workspaceLockPath(workspace, root);
  const deadline = clock.now() + timeoutMs;
  let lock = await acquireWorkspaceLock(workspace, root);
  while (!lock.ok && lock.error === WORKSPACE_LOCK_BUSY) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await clock.sleep(Math.min(clock.pollIntervalMs, remaining));
    lock = await acquireWorkspaceLock(workspace, root);
  }
  if (lock.ok || lock.error !== WORKSPACE_LOCK_BUSY) return lock;

  // Make one last attempt at the deadline so a lock released at the boundary wins.
  lock = await acquireWorkspaceLock(workspace, root);
  if (lock.ok || lock.error !== WORKSPACE_LOCK_BUSY) return lock;
  let owner: { pid: number; command: string } | undefined;
  try {
    owner = lockHolder(path);
  } catch {
    owner = undefined;
  }
  return {
    ok: false,
    error: `workspace lock stayed busy past ${timeoutMs}ms; ${owner === undefined ? "holder pid and command unavailable" : `holder pid=${owner.pid} command=${JSON.stringify(owner.command)}`}`,
  };
}

export const runningWorkspaceRun = async (
  workspace: string,
  exceptId?: string,
) =>
  (await foldedRuns()).find(
    (run) =>
      run.id !== exceptId &&
      run.state === "running" &&
      resolve(run.workspace) === resolve(workspace),
  );

export function append(
  event: z.input<typeof EventSchema>,
  root = stateDir(),
  publish = true,
): void {
  const path = recordPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const pickAudit = event.kind === "started" ? pendingPickAudit : undefined;
  const recorded =
    event.kind === "started" &&
    event.pick_audit === undefined &&
    pickAudit !== undefined
      ? { ...event, pick_audit: pickAudit }
      : event;
  appendFileSync(path, `${JSON.stringify(recorded)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
  if (event.kind === "started") pendingPickAudit = undefined;
  if (event.kind === "ended") {
    const origin = events(root).find(
      (row) => row.kind === "started" && row.id === event.id,
    );
    if (origin?.kind === "started" && origin.pick_audit?.audit !== undefined)
      recordRoutingPick(
        null,
        "lifecycle",
        {
          ...origin.pick_audit.audit,
          outcome_kind: event.returned === true ? "returned" : "held",
          run_id: event.id,
          worker_outcome: event.outcome ?? null,
        },
        event.returned === true ? "returned" : "held",
        root,
      );
  }
  if (publish) schedulePublication(root);
}

export function events(root = stateDir()): NextEvent[] {
  const path = recordPath(root);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  const parsed = lines
    .filter((line) => line !== "")
    .map((line) => EventTextSchema.safeParse(line));
  const invalid = parsed.find((event) => !event.success);
  if (invalid !== undefined)
    exitWithError(
      `agx: invalid record log line: ${invalid.error.message}\n`,
      1,
    );
  return parsed.flatMap((event) => (event.success ? [event.data] : []));
}

type LegacyImportResult = Readonly<{
  runs_imported: number;
  judgments_imported: number;
  progress_imported: number;
  malformed_lines: number;
  ignored_rows: number;
}>;

const LegacyRow = z.record(z.string(), z.unknown());
const rowOf = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = LegacyRow.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const legacyId = (runId: string): string =>
  `legacy-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
const legacySourceDir = (): string => join(stateDir(), "legacy-v1");

const importedEventKeys = (): Set<string> =>
  new Set(
    events().flatMap((event) =>
      event.legacy_key === undefined ? [] : [event.legacy_key],
    ),
  );

type PendingLegacyRow = Readonly<{
  row: Record<string, unknown>;
  key: string;
}>;

type LegacyReadResult = Readonly<{
  pending: PendingLegacyRow[];
  runs_imported: number;
  malformed_lines: number;
  ignored_rows: number;
}>;

const legacyKeyFor = (
  kind: string,
  runId: string,
  row: Record<string, unknown>,
): string => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        runId,
        row.at,
        row.graded_at,
        row.waived_at,
        row.grade,
        row.accept,
        row.reason,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `${kind}:${digest}`;
};

function importLegacyRun(
  legacy: Record<string, unknown>,
  runId: string,
  knownKeys: Set<string>,
): number {
  const startedKey = `run:${runId}`;
  const endedKey = `run-ended:${runId}`;
  const ticket = rowOf(legacy.ticket);
  const pick = rowOf(legacy.pick);
  const worker = rowOf(legacy.worker);
  const cwd = stringOf(legacy.cwd) ?? "unknown";
  const startedAt = stringOf(legacy.started_at) ?? now();
  const endedAt = stringOf(legacy.ended_at) ?? startedAt;
  const writesResult = z.array(z.string()).safeParse(ticket?.writes);
  const writes = writesResult.success ? writesResult.data : [];
  const outcome = worker?.outcome;
  let exit = numberOf(legacy.exit) ?? numberOf(worker?.exit_code);
  if (exit === undefined) {
    if (outcome === "ok" || outcome === "returned") exit = 0;
    else if (outcome === "timeout") exit = 3;
    else exit = 1;
  }
  const id = legacyId(runId);
  let imported = 0;
  if (!knownKeys.has(startedKey)) {
    const brief = rowOf(legacy.brief);
    append({
      kind: "started",
      id,
      at: startedAt,
      ticket:
        stringOf(ticket?.name) ?? basename(stringOf(brief?.path) ?? "legacy"),
      writes,
      cwd,
      workspace: cwd,
      row: stringOf(pick?.choice) ?? "unknown",
      dispatcher_session: stringOf(legacy.dispatcher_session) ?? null,
      vendor_session: stringOf(worker?.session) ?? null,
      continues: null,
      pid: 0,
      legacy_key: startedKey,
      legacy: { run_id: runId, source: "legacy-v1" },
    });
    knownKeys.add(startedKey);
    imported = 1;
  }
  if (!knownKeys.has(endedKey)) {
    append({
      kind: "ended",
      id,
      at: endedAt,
      exit,
      report_path: null,
      vendor_session: stringOf(worker?.session) ?? null,
      verify: [],
      legacy_key: endedKey,
    });
    knownKeys.add(endedKey);
  }
  return imported;
}

async function readLegacyFile(
  filePath: string,
  knownKeys: Set<string>,
): Promise<LegacyReadResult> {
  const pending: PendingLegacyRow[] = [];
  let runsImported = 0;
  let malformedLines = 0;
  let ignoredRows = 0;
  const input = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of input) {
    const parsed = jsonOf(LegacyRow).safeParse(line);
    if (!parsed.success) {
      malformedLines += 1;
      continue;
    }
    const legacy = parsed.data;
    const kind = legacy.type === "judged" ? "judged" : stringOf(legacy.kind);
    const runId = stringOf(legacy.run_id);
    if (kind === "run" && runId !== undefined) {
      runsImported += importLegacyRun(legacy, runId, knownKeys);
      continue;
    }
    const importable = ["acceptance", "interim", "landed", "judged"];
    if (
      kind === undefined ||
      runId === undefined ||
      !importable.includes(kind)
    ) {
      ignoredRows += 1;
      continue;
    }
    const timestamp = z.iso.datetime({ offset: true }).safeParse(legacy.at);
    const validDecision =
      kind !== "judged" ||
      legacy.decision === "accept" ||
      legacy.decision === "reject" ||
      legacy.decision === "landed";
    if (
      kind !== "interim" &&
      (!timestamp.success ||
        !validDecision ||
        (kind === "acceptance" && typeof legacy.accept !== "boolean"))
    ) {
      malformedLines += 1;
      continue;
    }
    const key =
      kind === "judged"
        ? `judged:${createHash("sha256")
            .update(
              JSON.stringify([
                runId,
                legacy.at,
                legacy.decision,
                legacy.note ?? legacy.reason ?? "",
              ]),
            )
            .digest("hex")}`
        : legacyKeyFor(kind, runId, legacy);
    pending.push({ row: { ...legacy, kind }, key });
  }
  return {
    pending,
    runs_imported: runsImported,
    malformed_lines: malformedLines,
    ignored_rows: ignoredRows,
  };
}

function importLegacyEvent(
  row: Record<string, unknown>,
  key: string,
): "judged" | "progress" | undefined {
  const kind = stringOf(row.kind);
  const runId = stringOf(row.run_id);
  if (kind === undefined || runId === undefined) return undefined;
  const id = legacyId(runId);
  const at =
    stringOf(row.at) ??
    stringOf(row.graded_at) ??
    stringOf(row.waived_at) ??
    now();
  if (kind === "interim") {
    const interim = rowOf(row.interim_report);
    const reportValue = interim?.return ?? interim ?? row.interim_report;
    const path = join(stateDir(), "runs", id, "last-progress.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(reportValue)}\n`);
    append({ kind: "progress", id, at, path, legacy_key: key });
    return "progress";
  }
  let decision: string | undefined;
  if (kind === "acceptance")
    decision = row.accept === true ? "accept" : "reject";
  if (kind === "landed") decision = "accept";
  if (kind === "judged") decision = stringOf(row.decision);
  if (decision === undefined) return undefined;
  const note = stringOf(row.note) ?? stringOf(row.reason) ?? "";
  append({ kind: "judged", id, at, decision, note, legacy_key: key });
  return "judged";
}

/** Import old agx rows idempotently; malformed source lines are counted and skipped. */
export async function importLegacyRecords(): Promise<LegacyImportResult> {
  const sourceDir = legacySourceDir();
  const files = existsSync(sourceDir)
    ? readdirSync(sourceDir)
        .filter(
          (name) =>
            name === "runs.jsonl" ||
            name === "lifecycle.jsonl" ||
            /^(runs|lifecycle)-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name),
        )
        .toSorted()
    : [];
  const knownKeys = importedEventKeys();
  const pending: PendingLegacyRow[] = [];
  let runsImported = 0;
  let judgmentsImported = 0;
  let progressImported = 0;
  let malformedLines = 0;
  let ignoredRows = 0;

  for (const file of files) {
    const read = await readLegacyFile(join(sourceDir, file), knownKeys);
    pending.push(...read.pending);
    runsImported += read.runs_imported;
    malformedLines += read.malformed_lines;
    ignoredRows += read.ignored_rows;
  }

  for (const { row, key } of pending) {
    if (knownKeys.has(key)) continue;
    if (!knownKeys.has(`run:${stringOf(row.run_id) ?? ""}`)) {
      ignoredRows += 1;
      continue;
    }
    const imported = importLegacyEvent(row, key);
    if (imported === "progress") progressImported += 1;
    if (imported === "judged") judgmentsImported += 1;
    knownKeys.add(key);
  }
  return {
    runs_imported: runsImported,
    judgments_imported: judgmentsImported,
    progress_imported: progressImported,
    malformed_lines: malformedLines,
    ignored_rows: ignoredRows,
  };
}

export async function overlapWarnings(
  writes: string[],
  repositoryRoot: string,
): Promise<void> {
  const started = new Map<string, Extract<NextEvent, { kind: "started" }>>();
  const ended = new Set<string>();
  for (const event of events()) {
    if (event.kind === "started") started.set(event.id, event);
    if (event.kind === "ended") ended.add(event.id);
  }
  for (const [id, run] of started) {
    if (ended.has(id)) continue;
    const live = fromThrowable(
      () => process.kill(run.pid, 0),
      (error) => error,
    )();
    if (live.isErr()) continue;
    const sameRepository = async (path: string, isTicket = false) => {
      const context = await ticketContext(
        isTicket ? dirname(resolve(path)) : resolve(path),
      );
      return context.ok && context.root === repositoryRoot;
    };
    const sharesRepository =
      (run.ticket_path !== undefined &&
        (await sameRepository(run.ticket_path, true))) ||
      (await sameRepository(run.workspace)) ||
      (await sameRepository(run.cwd));
    if (!sharesRepository) continue;
    const intersections = run.writes.flatMap((a) =>
      writes.filter((b) => globsOverlap(a, b)),
    );
    if (intersections.length > 0)
      process.stderr.write(`WARN overlap run=${id} ticket=tkt_${run.ticket}\n`);
  }
}

const SnapshotSchema = z
  .object({
    version: z.literal(1),
    inode: z.number(),
    device: z.number(),
    size: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    runs: z.array(RunSchema),
    malformed: z.array(LegacyRow),
  })
  .refine((snapshot) => snapshot.offset <= snapshot.size);

/** Pure event fold, shared by full replay and incremental replay. */
function foldInto(runs: Map<string, FoldedRun>, input: NextEvent[]): void {
  for (const event of input) {
    if (event.kind === "started" || event.kind === "dispatching")
      runs.set(event.id, {
        id: event.id,
        legacy:
          event.legacy ??
          (event.legacy_key?.startsWith("run:") === true
            ? { run_id: event.legacy_key.slice(4), source: "legacy-v1" }
            : undefined),
        started_at: event.at,
        ended_at: null,
        ticket: event.ticket,
        state: "running",
        lease: event.lease,
        exit: null,
        outcome: null,
        row: event.kind === "started" ? event.row : "dispatching",
        route: event.route,
        model: event.model,
        effort: event.effort,
        sandbox: event.sandbox,
        sandbox_source: event.sandbox_source,
        sandbox_effective: event.sandbox_effective,
        sandbox_effective_source: event.sandbox_effective_source,
        worker_name: event.worker_name ?? `agt_${event.ticket}`,
        unit: event.unit ?? event.worker_name ?? `agt_${event.ticket}`,
        workspace_name: event.workspace_name ?? basename(event.workspace),
        dispatcher_session: event.dispatcher_session,
        cwd: event.cwd,
        workspace: event.workspace,
        writes: event.writes,
        judgment: null,
        report_path: null,
        verify: [],
        last_progress_path: null,
        continues: event.continues ?? null,
        supersedes: event.supersedes,
        base_rev: event.base_rev,
        premise_commits: event.premise_commits,
        ticket_path: event.ticket_path,
        ticket_orig_path: event.ticket_orig_path,
        ticket_sha256: event.ticket_sha256,
        vendor_session: event.vendor_session,
        pid: event.pid,
        failed_early_quit: false,
        returned: undefined,
        changed_files: undefined,
      });
    const run = runs.get(event.id);
    if (run === undefined) continue;
    if (event.kind === "progress") run.last_progress_path = event.path;
    if (event.kind === "session") run.vendor_session = event.vendor_session;
    if (event.kind === "ended" && event.launch_stderr !== undefined)
      run.launch_stderr = event.launch_stderr;
    if (event.kind === "ended") {
      run.state = "ended";
      run.signal = event.signal;
      run.stopped_by = event.stopped_by;
      run.evidence = event.evidence;
      run.ended_at = event.at;
      run.exit = event.exit;
      // Historical records without workspace/report evidence must never become successes.
      run.outcome =
        event.outcome ??
        deriveOutcome({
          timedOut: event.exit === 3 || event.exit === 124,
          refused: event.exit !== 0,
          verify: event.verify,
          reportValid: false,
          changed: event.changed_files ?? 0,
        });
      run.report_path = event.report_path;
      run.verify = event.verify;
      Object.assign(run, {
        ...(event.rows === undefined
          ? {}
          : {
              rows: event.rows,
              row: event.rows.at(-1) ?? run.row,
            }),
        ...(event.final_row === undefined
          ? {}
          : {
              row: event.final_row.id,
              route: event.final_row.route,
              model: event.final_row.model,
              effort: event.final_row.effort,
            }),
      });
      run.returned = event.returned;
      run.changed_files = event.changed_files;
      run.vendor_session = event.vendor_session;
    }
    if (event.kind !== "judged") continue;
    const decision = event.decision === "landed" ? "accept" : event.decision;
    if (decision !== "accept" && decision !== "reject") continue;
    const previous = run.judgment;
    const compared =
      previous === null ? 1 : Temporal.Instant.compare(event.at, previous.at);
    if (compared < 0) continue;
    if (
      compared === 0 &&
      event.legacy_key !== undefined &&
      (previous?.legacy_key === undefined ||
        event.legacy_key <= previous.legacy_key)
    )
      continue;
    run.judgment = {
      decision,
      note: event.note,
      at: event.at,
      ...(event.legacy_key === undefined
        ? {}
        : { legacy_key: event.legacy_key }),
    };
  }
}

/** Full replay oracle; does not read or write the snapshot. */
export async function fullFoldedRuns() {
  const root = stateDir();
  await publications.get(root);
  const before = await recordStat(recordPath(root)).catch(() => null);
  const runs = new Map<string, FoldedRun>();
  foldInto(runs, events(root));
  return liveRuns(runs, before, root);
}

/** Read-only, process-local cursor. Partial lines retain their original bytes. */
export function recordCursor(root = stateDir()) {
  let offset = 0;
  let identity: { ino: number; dev: number } | undefined;
  let pending = Buffer.alloc(0);
  const runs = new Map<string, FoldedRun>();
  const read = async (): Promise<ListedRun[]> => {
    const file = await open(recordPath(root), "r").catch(() => null);
    if (file === null) return [];
    const stat = await file.stat();
    if (
      identity?.ino !== stat.ino ||
      identity.dev !== stat.dev ||
      stat.size < offset
    ) {
      offset = 0;
      pending = Buffer.alloc(0);
      runs.clear();
    }
    identity = stat;
    const bytes = Buffer.alloc(stat.size - offset);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read({
        buffer: bytes,
        offset: length,
        length: bytes.length - length,
        position: offset + length,
      });
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    await file.close();
    offset += length;
    const tail = Buffer.concat([pending, bytes.subarray(0, length)]);
    const complete = tail.lastIndexOf(10) + 1;
    const input = tail
      .subarray(0, complete)
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => EventTextSchema.safeParse(line));
    const invalid = input.find((event) => !event.success);
    if (invalid !== undefined)
      return exitWithError(
        `agx: invalid record log line: ${invalid.error.message}\n`,
        1,
      );
    foldInto(
      runs,
      input.flatMap((event) => (event.success ? [event.data] : [])),
    );
    pending = Buffer.from(tail.subarray(complete));
    return liveRuns(runs, stat, root, read);
  };
  return { read };
}

/** Wait for already scheduled owner writes; readers never initiate publication. */
export async function foldedRuns(root = stateDir()) {
  await publications.get(root);
  return readFoldedRuns(root);
}

/** Recorded identity must not depend on the caller's visibility of the owner's PID. */
export function recordedRun(id: string, root = stateDir()) {
  const runs = new Map<string, FoldedRun>();
  foldInto(
    runs,
    events(root).filter((event) => event.id === id),
  );
  return runs.get(id);
}

/** Decode legacy records before applying listing visibility; preserve raw failures. */
export async function listingHistory(workspace?: string, root = stateDir()) {
  const malformed: Record<string, unknown>[] = [];
  const runs =
    workspace === undefined
      ? await readFoldedRuns(root, malformed)
      : await workspaceRuns(workspace, root, malformed);
  return { runs, malformed };
}

async function readFoldedRuns(
  root: string,
  malformed?: Record<string, unknown>[],
) {
  const path = recordPath(root);
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  const stat = fstatSync(fd);
  const parsed = SnapshotSchema.safeParse(foldCache.get(path));
  const snapshot = parsed.success ? parsed.data : undefined;
  const valid =
    snapshot !== undefined &&
    // Strict readers must still reject malformed imports cached by a listing.
    (malformed !== undefined || snapshot.malformed.length === 0) &&
    snapshot.inode === stat.ino &&
    snapshot.device === stat.dev &&
    stat.size >= snapshot.size &&
    stat.size >= snapshot.offset;
  const offset = valid ? snapshot.offset : 0;
  const runs = new Map<string, FoldedRun>(
    valid ? snapshot.runs.map((run) => [run.id, run]) : [],
  );
  const malformedRows = valid ? snapshot.malformed : [];
  const read = fromThrowable(() => {
    const bytes = Buffer.alloc(stat.size - offset);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, {
        offset: length,
        length: bytes.length - length,
        position: offset + length,
      });
      if (count === 0) break;
      length += count;
    }
    return bytes.subarray(0, length);
  })();
  closeSync(fd);
  if (read.isErr())
    return exitWithError(
      "agx: cannot read record log: " + String(read.error) + "\n",
      1,
    );
  const bytes = read.value;
  const complete = bytes.lastIndexOf(10) + 1;
  const input = bytes
    .subarray(0, complete)
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const event = EventTextSchema.safeParse(line);
      if (!event.success && malformed !== undefined) {
        const raw = jsonOf(z.record(z.string(), z.unknown())).safeParse(line);
        if (
          raw.success &&
          raw.data.kind === "started" &&
          (LegacyIdentity.safeParse(raw.data.legacy).success ||
            (typeof raw.data.legacy_key === "string" &&
              raw.data.legacy_key.startsWith("run:")))
        ) {
          malformedRows.push(raw.data);
          return [];
        }
      }
      return [event];
    });
  const invalid = input.find((event) => !event.success);
  if (invalid !== undefined)
    exitWithError(
      "agx: invalid record log line: " + invalid.error.message + "\n",
      1,
    );
  foldInto(
    runs,
    input.flatMap((event) => (event.success ? [event.data] : [])),
  );
  malformed?.push(...malformedRows);
  foldCache.set(path, {
    version: 1,
    inode: stat.ino,
    device: stat.dev,
    size: stat.size,
    offset: offset + complete,
    runs: [...runs.values()],
    malformed: malformedRows,
  });
  return liveRuns(runs, stat, root);
}

const foldCache = new Map<string, z.output<typeof SnapshotSchema>>();

const RecordIdentity = z.object({
  size: z.number(),
  ino: z.number(),
  dev: z.number(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
});
const WorkspacePublication = z.object({
  version: z.literal(1),
  workspace: z.string(),
  source: RecordIdentity,
  runs: z.array(RunSchema),
});
const recordIdentity = async (root: string) => {
  const info = await recordStat(recordPath(root)).catch(() => null);
  const parsed = RecordIdentity.safeParse(info);
  return parsed.success ? parsed.data : null;
};
const sameSource = (
  a: z.output<typeof RecordIdentity> | null,
  b: z.output<typeof RecordIdentity> | null,
) => a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
const workspacePublicationPath = (workspace: string, root: string) =>
  join(
    root,
    "workspaces",
    createHash("sha256").update(workspace).digest("hex") + ".json",
  );

/** Only the selected workspace's full fold is read; the event log is stat'ed, never opened. */
export async function workspaceRuns(
  workspace: string,
  root = stateDir(),
  malformed?: Record<string, unknown>[],
): Promise<ListedRun[]> {
  const before = await recordIdentity(root);
  const publication = jsonOf(WorkspacePublication).safeParse(
    await Bun.file(workspacePublicationPath(workspace, root))
      .text()
      .catch(() => ""),
  );
  if (
    publication.success &&
    publication.data.workspace === workspace &&
    sameSource(before, publication.data.source) &&
    sameSource(before, await recordIdentity(root))
  ) {
    return liveRuns(
      new Map(publication.data.runs.map((run) => [run.id, run])),
      before,
      root,
      () => workspaceRuns(workspace, root),
    );
  }
  process.stderr.write(
    `agx: workspace publication missing, invalid, or stale; scanning records.jsonl for ${workspace}\n`,
  );
  const runs =
    malformed === undefined
      ? await foldedRuns(root)
      : await readFoldedRuns(root, malformed);
  const canonical = new Map(
    await Promise.all(
      [...new Set(runs.map((run) => run.workspace))].map(
        async (path) =>
          [path, await realpath(path).catch(() => resolve(path))] as const,
      ),
    ),
  );
  return runs.filter((run) => canonical.get(run.workspace) === workspace);
}

async function publishWorkspaceRuns(
  root: string,
  source: z.output<typeof RecordIdentity> | null,
) {
  const cached = foldCache.get(recordPath(root));
  if (
    cached === undefined ||
    !sameSource(source, await recordIdentity(root)) ||
    cached.size !== source?.size ||
    cached.inode !== source.ino ||
    cached.device !== source.dev
  )
    return;
  const groups = new Map<string, FoldedRun[]>();
  const canonical = new Map(
    await Promise.all(
      [...new Set(cached.runs.map((run) => run.workspace))].map(
        async (path) =>
          [path, await realpath(path).catch(() => resolve(path))] as const,
      ),
    ),
  );
  for (const run of cached.runs) {
    const workspace = canonical.get(run.workspace) ?? resolve(run.workspace);
    const rows = groups.get(workspace) ?? [];
    rows.push(run);
    groups.set(workspace, rows);
  }
  await mkdir(join(root, "workspaces"), { recursive: true });
  for (const [workspace, runs] of groups) {
    const path = workspacePublicationPath(workspace, root);
    const temp = path + "." + crypto.randomUUID() + ".tmp";
    await writeFile(
      temp,
      JSON.stringify({ version: 1, workspace, source, runs }),
      { mode: 0o600 },
    );
    await rename(temp, path);
  }
}

function withHealth(run: ListedRun, legacy: boolean): ListedRun {
  return Object.assign(run, {
    health: runHealth(run, legacy) ?? null,
    phase: run.state === "running" ? "working" : undefined,
  });
}

async function liveRuns(
  runs: Map<string, FoldedRun>,
  before: { size: number; ino: number; dev: number } | null,
  root = stateDir(),
  reread?: () => Promise<ListedRun[]>,
): Promise<ListedRun[]> {
  const listed: ListedRun[] = [];
  const losses = new Set<string>();
  const retired = join(dirname(root), "agx-next") + "/";
  const reports = new Map<string, string>();
  const currentReport = (path: string | null) => {
    if (path === null || !path.startsWith(retired)) return path;
    const cached = reports.get(path);
    if (cached !== undefined) return cached;
    const current = join(root, path.slice(retired.length));
    const result = existsSync(current) ? current : path;
    reports.set(path, result);
    return result;
  };
  for (const stored of runs.values()) {
    const run = { ...stored };
    run.report_path = currentReport(run.report_path);
    run.worker_name ??= `agt_${run.ticket}`;
    run.workspace_name ??= basename(run.workspace);
    // Old event logs and snapshots used verify-failed for every nonzero check.
    if (
      run.outcome === "verify-failed" &&
      run.verify.some(
        (check) => check.kind === "unrunnable" || check.kind === "killed",
      )
    )
      run.outcome = deriveOutcome({
        timedOut: false,
        refused: false,
        verify: run.verify,
        reportValid: true,
        changed: run.changed_files ?? 0,
      });
    const endedAt = run.ended_at;
    const elapsedResult =
      endedAt === null ||
      run.returned !== false ||
      run.changed_files !== 0 ||
      run.exit !== 0
        ? undefined
        : fromThrowable(
            () =>
              Temporal.Instant.from(endedAt)
                .since(Temporal.Instant.from(run.started_at))
                .total({ unit: "seconds" }),
            (error) => error,
          )();
    const elapsed =
      elapsedResult?.isOk() === true ? elapsedResult.value : Infinity;
    run.failed_early_quit =
      run.state === "ended" &&
      run.exit === 0 &&
      elapsed < 120 &&
      run.returned === false &&
      run.changed_files === 0;
    const { pid, state, outcome, lease: storedLease, ...fields } = run;
    const lease = storedLease ?? { pid, start: null, unit: null };
    if (state === "ended") {
      listed.push(
        withHealth(
          { ...fields, state, outcome: outcome ?? "refused", lease },
          storedLease === undefined,
        ),
      );
      continue;
    }
    const evidence = await lossEvidence(lease);
    if (evidence === undefined)
      listed.push(
        withHealth(
          { ...fields, state: "running", outcome: null, lease },
          storedLease === undefined,
        ),
      );
    else {
      losses.add(run.id);
      listed.push(
        withHealth(
          {
            ...fields,
            state: "ended",
            outcome: "lost",
            lease,
            evidence,
          },
          storedLease === undefined,
        ),
      );
    }
  }
  if (losses.size === 0) return listed;
  const after = await recordStat(recordPath(root)).catch(() => null);
  if (
    before !== null &&
    after?.size === before.size &&
    after.ino === before.ino &&
    after.dev === before.dev
  )
    return listed;
  // Liveness observation awaits /proc or ps and possibly systemd. The owner can
  // append ended and exit after our initial replay. Only infer loss after reading
  // the log again *after* observing death; never persist that inference in cache.
  if (reread !== undefined) return reread();
  const latest = new Map<string, FoldedRun>();
  foldInto(latest, events(root));
  const completed = new Map(
    [...latest].filter(([id, run]) => losses.has(id) && run.state === "ended"),
  );
  const recovered = new Map(
    (await liveRuns(completed, after, root)).map((run) => [run.id, run]),
  );
  return listed.map((run) => recovered.get(run.id) ?? run);
}

// Serialize publications across processes using the same kernel-owned lock discipline as runs.
const publications = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
export const flushRunPublications = async () => {
  await Promise.all(publications.values());
};
function schedulePublication(root: string): void {
  generations.set(root, (generations.get(root) ?? 0) + 1);
  if (publications.has(root)) return;
  const pending = (async () => {
    let seen: number | undefined;
    do {
      seen = generations.get(root);
      await publishCurrentRuns(root);
    } while (seen !== generations.get(root));
    publications.delete(root);
    generations.delete(root);
  })().catch((error: unknown) => {
    publications.delete(root);
    generations.delete(root);
    process.stderr.write(
      `agx: snapshot publication failed: ${String(error)}\n`,
    );
  });
  publications.set(root, pending);
}
/** Ended-run facts are retained this long in `endedRuns`; readers re-apply their own cutoff. */
const ENDED_WINDOW_MS = 24 * 60 * 60_000;

const endedRow = (run: ListedRun, endedAt: string) => ({
  id: run.id,
  dispatcher_session: run.dispatcher_session,
  workspace: run.workspace,
  ended_at: endedAt,
  judgment: run.judgment === null ? null : { decision: run.judgment.decision },
});

/**
 * Facts for readers that must not replay the log: recent ended runs (any judgment) and every
 * accepted run whose workspace directory still exists. Runs without an `ended` record (running,
 * or derived loss) carry no `ended_at` and are omitted. Order follows the fold.
 */
export async function endedFacts(runs: ListedRun[], at: number) {
  const ended = runs.flatMap((run) =>
    run.ended_at === null ? [] : [{ run, endedAt: run.ended_at }],
  );
  const endedRuns = ended.flatMap(({ run, endedAt }) => {
    const ms = fromThrowable(
      () => Temporal.Instant.from(endedAt).epochMilliseconds,
    )().unwrapOr(Number.NaN);
    return ms >= at - ENDED_WINDOW_MS ? [endedRow(run, endedAt)] : [];
  });
  const accepted = ended.filter(
    ({ run }) => run.judgment?.decision === "accept",
  );
  const present = new Map(
    await Promise.all(
      [...new Set(accepted.map(({ run }) => run.workspace))].map(
        async (workspace) =>
          [
            workspace,
            await recordStat(workspace)
              .then((info) => info.isDirectory())
              .catch(() => false),
          ] as const,
      ),
    ),
  );
  const acceptedRuns = accepted.flatMap(({ run, endedAt }) =>
    present.get(run.workspace) === true ? [endedRow(run, endedAt)] : [],
  );
  return { endedRuns, acceptedRuns };
}

/** Called only under the publication lock; the workspace lock excludes the run owner. */
async function reconcileLostRuns(root: string): Promise<void> {
  const candidates = (await readFoldedRuns(root)).filter(
    (run) => run.outcome === "lost" && run.ended_at === null,
  );
  for (const workspace of new Set(candidates.map((run) => run.workspace))) {
    const lock = await acquireWorkspaceLock(workspace, root);
    if (!lock.ok) continue;
    await using _ownership = { [Symbol.asyncDispose]: lock.release };
    await sealWorkspaceLosses(workspace, root);
  }
}

async function sealWorkspaceLosses(
  workspace: string,
  root: string,
): Promise<void> {
  // Replay and observe liveness again after taking ownership. An owner may
  // have completed normally while publication was waiting for either lock.
  const before = await recordStat(recordPath(root)).catch(() => null);
  const stored = new Map<string, FoldedRun>();
  foldInto(stored, events(root));
  const selected = new Map(
    [...stored].filter(([, run]) => run.workspace === workspace),
  );
  for (const run of await liveRuns(selected, before, root)) {
    if (
      run.workspace !== workspace ||
      run.outcome !== "lost" ||
      run.ended_at !== null ||
      run.evidence === undefined
    )
      continue;
    append(
      {
        kind: "ended",
        id: run.id,
        at: now(),
        exit: 1,
        outcome: "lost",
        evidence: run.evidence,
        report_path: run.report_path,
        vendor_session: run.vendor_session,
        verify: run.verify,
      },
      root,
    );
  }
}

export async function publishCurrentRuns(
  root = stateDir(),
  ownership?: AcquiredWorkspaceLock,
): Promise<void> {
  const path = join(root, "current-runs.json");
  let lock: WorkspaceLock =
    ownership ?? (await acquireWorkspaceLock(path, root));
  if (ownership === undefined) {
    const deadline = performance.now() + 5000;
    while (!lock.ok && performance.now() < deadline) {
      await Bun.sleep(5);
      lock = await acquireWorkspaceLock(path, root);
    }
  }
  if (!lock.ok) {
    process.stderr.write(
      "agx: cannot publish current runs: " + lock.error + "\n",
    );
    return;
  }
  const held = lock;
  const result = await fromPromise(
    (async () => {
      await reconcileLostRuns(root);
      const source = await recordIdentity(root);
      const runs = await readFoldedRuns(root);
      await publishWorkspaceRuns(root, source);
      const output = JSON.stringify({
        runs: listingRows(
          runs.filter(
            (run) => run.state === "running" || run.health === "orphaned",
          ),
        ),
        summary: runningSummary(runs),
      });
      const capturedAt = Temporal.Now.instant().epochMilliseconds;
      const temp = path + "." + crypto.randomUUID() + ".tmp";
      await writeFile(
        temp,
        JSON.stringify({
          output,
          capturedAt,
          exit: 0,
          ...(await endedFacts(runs, capturedAt)),
        }),
        { mode: 0o600 },
      );
      await rename(temp, path);
    })(),
    String,
  );
  if (ownership === undefined) await held.release();
  if (result.isErr())
    process.stderr.write(
      "agx: cannot publish current runs: " + result.error + "\n",
    );
}
