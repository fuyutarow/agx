import {
  appendFileSync,
  closeSync,
  openSync,
  fstatSync,
  readSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import packageJson from "../../package.json" with { type: "json" };
import {
  mkdir,
  open,
  rename,
  realpath,
  writeFile,
  stat as recordStat,
} from "node:fs/promises";
import { dlopen, FFIType, read as ffiRead } from "bun:ffi";
import { basename, dirname, join, resolve } from "node:path";
import { fromPromise, fromThrowable } from "neverthrow";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { globsOverlap } from "../ticket.ts";
import { exitWithError } from "./exit.ts";
import { Outcome, deriveOutcome } from "./outcome.ts";
import { lossEvidence, Lease, StopSignal, Evidence } from "./lease.ts";
import {
  EndNoticeResult,
  measureRunDir,
  LegacyIdentity,
  RunSchema,
  type FoldedRun,
  type ListedRun,
} from "./run-state.ts";
export type { ListedRun } from "./run-state.ts";
import { VerifyResult, VerifyRound } from "./verify.ts";
import { runningSummary, listingRows } from "./listing.ts";
import { runHealth } from "./health.ts";
import { ticketContext } from "./ticket-home.ts";
import { Sandbox, SandboxSource } from "./sandbox.ts";

import { recordRoutingPick } from "./routing-events.ts";
import { scheduleEndNotice } from "./end-notice.ts";
import { freeRunTemp, recordedLifetime } from "../temp.ts";

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
        { decision_id: audit.audit.decision_id, outcome_kind: "held", exit },
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
    dispatcher_address: z.string().nullable().optional(),
    vendor_session: z.string().nullable(),
    continues: z.string().nullable().optional(),
    continued_from_row: z.string().optional(),
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
    decision_id: z.string().optional(),
    usage_id: z.string().optional(),
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
    dispatcher_address: z.string().nullable().optional(),
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
    decision_id: z.string().optional(),
    usage_id: z.string().optional(),
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
    run_dir_bytes: z.number().int().nonnegative().optional(),
    id: z.string(),
    at: z.string(),
    exit: z.number(),
    outcome: Outcome.optional(),
    launch_stderr: z.string().optional(),
    cause: z.string().optional(),
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
    verify_round: VerifyRound.optional(),
    returned: z.boolean().optional(),
    changed_files: z.number().int().nonnegative().optional(),
    end_notice: EndNoticeResult.optional(),
    legacy_key: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("end-notice"),
    id: z.string(),
    at: z.string(),
    notice: EndNoticeResult,
    legacy_key: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("judged"),
    id: z.string(),
    at: z.string(),
    decision: z.string(),
    note: z.string(),
    override_reason: z.string().optional(),
    evidence: z
      .array(
        z.object({
          path: z.string(),
          sha256: z.string(),
          content: z.string(),
          content_path: z.string().optional(),
          content_truncated: z.boolean().optional(),
        }),
      )
      .optional(),
    legacy_key: z.string().optional(),
  }),
]);
export type NextEvent = z.output<typeof EventSchema>;
const EventTextSchema = jsonOf(EventSchema);

/** Index just past the JSON value that begins at `start`, or -1 when it is not an object or array. */
function jsonValueEnd(line: string, start: number): number {
  const first = line.codePointAt(start);
  if (first !== 0x7b && first !== 0x5b) return -1;
  let depth = 0;
  let index = start;
  while (index < line.length) {
    const code = line.codePointAt(index);
    // Jump over string bodies: the long payloads are strings.
    const next = code === 0x22 ? stringClose(line, index) + 1 : index + 1;
    if (next <= 0) return -1;
    depth += code === 0x22 ? 0 : nesting(code);
    if (depth === 0) return index + 1;
    index = next;
  }
  return -1;
}

/** Index of the quote that closes the string opened at `quote`, or -1. */
function stringClose(line: string, quote: number): number {
  let close = line.indexOf('"', quote + 1);
  while (close > 0 && backslashesBefore(line, close) % 2 === 1)
    close = line.indexOf('"', close + 1);
  return close;
}

function backslashesBefore(line: string, at: number): number {
  let count = 0;
  while (line.codePointAt(at - 1 - count) === 0x5c) count += 1;
  return count;
}

function nesting(code: number | undefined): number {
  if (code === 0x7b || code === 0x5b) return 1;
  if (code === 0x7d || code === 0x5d) return -1;
  return 0;
}

/** Remove the top-level `"key":<object|array>` member (and its leading comma) without parsing it. */
function dropMember(
  line: string,
  key: string,
): { line: string; dropped: string } | undefined {
  const marker = `,"${key}":`;
  const at = line.indexOf(marker);
  if (at < 0) return undefined;
  const valueStart = at + marker.length;
  const end = jsonValueEnd(line, valueStart);
  if (end < 0) return undefined;
  return {
    line: line.slice(0, at) + line.slice(end),
    dropped: line.slice(valueStart, end),
  };
}

const DECISION_ID = /"decision_id":"([^"\\]+)"/u;

/**
 * Readers never print routing audits or judged evidence, so they are skipped before decoding.
 * Old started lines keep their decision_id by lifting it out of the copied audit; the audit
 * itself stays readable in routing.jsonl and the line on disk is untouched.
 */
function withoutAuditPayloads(line: string): string {
  let slim = line;
  if (slim.includes(',"pick_audit":')) {
    const dropped = dropMember(slim, "pick_audit");
    if (dropped !== undefined) {
      const id = DECISION_ID.exec(dropped.dropped)?.[1];
      slim =
        id === undefined || slim.includes(',"decision_id":')
          ? dropped.line
          : dropped.line.replace(/\}$/u, `,"decision_id":"${id}"}`);
    }
  }
  if (
    slim.startsWith('{"kind":"judged"') &&
    slim.includes(',"evidence":[{"path":"')
  )
    slim = dropMember(slim, "evidence")?.line ?? slim;
  return slim;
}

function parseCompleteRecordLines(
  text: string,
  path: string,
  firstLine = 1,
  malformed?: Record<string, unknown>[],
): { events: NextEvent[]; lineCount: number } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const parsedEvents: NextEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const event = EventTextSchema.safeParse(withoutAuditPayloads(line));
    if (event.success) {
      parsedEvents.push(event.data);
      continue;
    }
    const raw = jsonOf(z.record(z.string(), z.unknown())).safeParse(line);
    if (
      malformed !== undefined &&
      raw.success &&
      raw.data.kind === "started" &&
      (LegacyIdentity.safeParse(raw.data.legacy).success ||
        (typeof raw.data.legacy_key === "string" &&
          raw.data.legacy_key.startsWith("run:")))
    )
      malformed.push(raw.data);
    const reason = event.error.issues[0]?.message ?? "invalid event";
    process.stderr.write(
      `agx: skipped unreadable record log line ${path}:${firstLine + index}: ${reason}\n`,
    );
  }
  return { events: parsedEvents, lineCount: lines.length };
}

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
  const fromProcResult = fromThrowable(() =>
    readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
  )();
  const fromProc = fromProcResult.isOk() ? fromProcResult.value : "";
  if (fromProc !== "") return fromProc.slice(0, 300);
  const result = Bun.spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "command="],
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.stdout.toString("utf8").trim().slice(0, 300);
}

function processCommandOrUnavailable(pid: number): string {
  const command = processCommand(pid);
  return command === "" ? "(unavailable)" : command;
}

function lockHolder(
  path: string,
): { pid: number; command: string } | undefined {
  if (process.platform === "linux") {
    const info = statSync(path, { bigint: true });
    const { major, minor } = linuxDeviceNumbers(info.dev);
    const lines = readFileSync("/proc/locks", "utf8").split("\n");
    const matchingFields = lines
      .map((line) => line.trim().split(/\s+/u))
      .find((fields) => {
        const pid = Number(fields[4]);
        const [lockMajor, lockMinor, inode] = (fields[5] ?? "").split(":");
        return (
          fields[1] === "FLOCK" &&
          fields[2] === "ADVISORY" &&
          fields[3] === "WRITE" &&
          Number.isInteger(pid) &&
          lockMajor !== undefined &&
          lockMinor !== undefined &&
          inode !== undefined &&
          Number.parseInt(lockMajor, 16) === major &&
          Number.parseInt(lockMinor, 16) === minor &&
          BigInt(inode) === info.ino
        );
      });
    if (matchingFields === undefined) return undefined;
    const pid = Number(matchingFields[4]);
    return { pid, command: processCommandOrUnavailable(pid) };
  }

  const result = Bun.spawnSync({
    cmd: ["lsof", "-t", path],
    stdout: "pipe",
    stderr: "ignore",
  });
  const pid = Number(result.stdout.toString("utf8").trim().split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, command: processCommandOrUnavailable(pid) };
}

/** The file is only a stable inode; ownership lives in the kernel, never in its contents. */
export async function acquireWorkspaceLock(
  workspace: string,
  root = stateDir(),
  lockFd: (fd: number) => number = (fd) => fd,
): Promise<WorkspaceLock> {
  const errnoSymbol =
    process.platform === "darwin" ? "__error" : "__errno_location";
  const library = fromThrowable(() =>
    dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
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
  if (library.value.symbols.flock(lockFd(file.fd), 2 | 4) !== 0) {
    const errnoPointer = library.value.symbols[errnoSymbol]?.();
    const errno =
      errnoPointer === null || errnoPointer === undefined
        ? undefined
        : ffiRead.i32(errnoPointer, 0);
    await file.close();
    library.value.close();
    // EWOULDBLOCK is 11 on Linux and 35 on Darwin.
    if (errno === (process.platform === "darwin" ? 35 : 11))
      return { ok: false, error: WORKSPACE_LOCK_BUSY };
    return {
      ok: false,
      error: `flock failed: errno ${errno ?? "unavailable"}`,
    };
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

const defaultWorkspaceLockWaitClock = {
  now: () => performance.now(),
  sleep: (milliseconds: number) => Bun.sleep(milliseconds),
  pollIntervalMs: 5,
} satisfies WorkspaceLockWaitClock;

export async function acquireWorkspaceLockUntilAvailable(
  workspace: string,
  root = stateDir(),
  timeoutMs = 30_000,
  clock: WorkspaceLockWaitClock = defaultWorkspaceLockWaitClock,
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
  const ownerResult = fromThrowable(() => lockHolder(path))();
  const owner = ownerResult.isOk() ? ownerResult.value : undefined;
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

/** The routing audit is written once, to routing.jsonl; a started record carries only its decision_id. */
function withDecisionReference(
  event: z.input<typeof EventSchema>,
  pickAudit: PickAudit | undefined,
): z.input<typeof EventSchema> {
  const decisionId = pickAudit?.audit?.decision_id;
  if (
    event.kind !== "started" ||
    event.pick_audit !== undefined ||
    event.decision_id !== undefined ||
    typeof decisionId !== "string"
  )
    return event;
  const usage =
    pickAudit?.usage_id === undefined ? {} : { usage_id: pickAudit.usage_id };
  return { ...event, decision_id: decisionId, ...usage };
}

function endEventWithSize(
  event: Extract<z.input<typeof EventSchema>, { kind: "ended" }>,
  root: string,
) {
  if (event.run_dir_bytes !== undefined && event.end_notice !== undefined)
    return event;
  if (!/^[a-zA-Z0-9_-]+$/u.test(event.id)) return event;
  const dir = join(root, "runs", event.id);
  const measured = fromThrowable(() =>
    existsSync(dir) ? measureRunDir(dir) : { bytes: 0 },
  )();
  if (measured.isErr()) return event;
  const size = measured.value;
  const bytes = event.run_dir_bytes ?? size.bytes;
  if (event.end_notice !== undefined || size.bytes <= 256 * 1024 * 1024)
    return { ...event, run_dir_bytes: bytes };
  const origin = events(root).findLast(
    (row) =>
      row.id === event.id &&
      (row.kind === "started" || row.kind === "dispatching"),
  );
  if (origin?.kind !== "started" && origin?.kind !== "dispatching")
    return { ...event, run_dir_bytes: bytes };
  const notice = scheduleEndNotice({
    id: event.id,
    ticket: origin.ticket,
    dispatcher: origin.dispatcher_session,
    startedAt: origin.at,
    endedAt: event.at,
    outcome: event.outcome ?? "unknown",
    exit: event.exit,
    resultPath: event.report_path,
    verifyExits: (event.verify ?? []).map((check) => check.exit),
    runDirSize: size,
    env: { AGX_STATE_DIR: root },
  });
  return { ...event, run_dir_bytes: bytes, end_notice: notice };
}

export function append(
  event: z.input<typeof EventSchema>,
  root = stateDir(),
  publish = true,
): void {
  const path = recordPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const recorded =
    event.kind === "ended"
      ? endEventWithSize(event, root)
      : withDecisionReference(event, pendingPickAudit);
  appendFileSync(path, `${JSON.stringify(recorded)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
  if (event.kind === "started") pendingPickAudit = undefined;
  if (event.kind === "ended") {
    const origin = events(root).find(
      (row) => row.kind === "started" && row.id === event.id,
    );
    if (origin?.kind === "started" && origin.decision_id !== undefined)
      recordRoutingPick(
        null,
        "lifecycle",
        {
          decision_id: origin.decision_id,
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

const RECORD_CHUNK_BYTES = 4 * 1024 * 1024;

function readChunk(fd: number, position: number, size: number): Buffer {
  const chunk = Buffer.alloc(size);
  let length = 0;
  while (length < size) {
    const count = readSync(fd, chunk, {
      offset: length,
      length: size - length,
      position: position + length,
    });
    if (count === 0) break;
    length += count;
  }
  return chunk.subarray(0, length);
}

/**
 * Decode the complete lines in bytes [from, to) of the record log, one bounded chunk at a time,
 * so the log is never held whole as a buffer, a string and a line array. Chunks end on a newline
 * byte, so a multi-byte character is never split; an incomplete tail is left unconsumed.
 */
function readRecordBatches(
  fd: number,
  from: number,
  to: number,
  path: string,
  firstLine: number,
  onEvents: (batch: NextEvent[]) => void,
  malformed?: Record<string, unknown>[],
): { consumed: number; lineCount: number } {
  let position = from;
  let pending = Buffer.alloc(0);
  let consumed = 0;
  let lineCount = 0;
  while (position < to) {
    const chunk = readChunk(
      fd,
      position,
      Math.min(RECORD_CHUNK_BYTES, to - position),
    );
    if (chunk.length === 0) break;
    position += chunk.length;
    const joined =
      pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const complete = joined.lastIndexOf(10) + 1;
    if (complete > 0) {
      const decoded = parseCompleteRecordLines(
        joined.subarray(0, complete).toString("utf8"),
        path,
        firstLine + lineCount,
        malformed,
      );
      onEvents(decoded.events);
      lineCount += decoded.lineCount;
      consumed += complete;
    }
    pending = Buffer.from(joined.subarray(complete));
  }
  return { consumed, lineCount };
}

export function events(root = stateDir()): NextEvent[] {
  const path = recordPath(root);
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  const all: NextEvent[] = [];
  const read = fromThrowable(() =>
    readRecordBatches(fd, 0, fstatSync(fd).size, path, 1, (batch) => {
      for (const event of batch) all.push(event);
    }),
  )();
  closeSync(fd);
  if (read.isErr())
    return exitWithError(
      "agx: cannot read record log: " + String(read.error) + "\n",
      1,
    );
  return all;
}

const LegacyRow = z.record(z.string(), z.unknown());

export async function overlapWarnings(
  writes: string[],
  repositoryRoot: string,
): Promise<void> {
  // Running runs come from the folded snapshot and the appended tail, never from a replay of
  // the whole log: this advisory warning must not cost a pass over every record.
  const started = new Map(
    (await foldedRuns())
      .filter((run) => run.state === "running")
      .map((run) => [run.id, run] as const),
  );
  for (const [id, run] of started) {
    const live = fromThrowable(
      () => process.kill(run.lease.pid, 0),
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
    lineCount: z.number().int().nonnegative(),
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
        dispatcher_address: event.dispatcher_address,
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
    if (event.kind === "ended" && event.cause !== undefined)
      run.cause = event.cause;
    if (event.kind === "ended") {
      run.run_dir_bytes = event.run_dir_bytes;
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
      run.verify_round = event.verify_round;
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
      run.end_notice = event.end_notice;
      run.vendor_session = event.vendor_session;
    }
    if (event.kind === "end-notice") run.end_notice = event.notice;
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
      ...(event.override_reason === undefined
        ? {}
        : { override_reason: event.override_reason }),
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
  let lineCount = 0;
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
      lineCount = 0;
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
    const decoded = parseCompleteRecordLines(
      tail.subarray(0, complete).toString("utf8"),
      recordPath(root),
      lineCount + 1,
    );
    foldInto(runs, decoded.events);
    lineCount += decoded.lineCount;
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

function readRecordedFold(root: string, malformed?: Record<string, unknown>[]) {
  const path = recordPath(root);
  // oxlint-disable-next-line unicorn/no-useless-undefined -- the absence is part of this reader's return contract.
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  const stat = fstatSync(fd);
  // The process cache holds this process's own fold; it is not re-parsed, which would reorder
  // each run's keys into schema order and make a second read differ from the first.
  const snapshot = foldCache.get(path) ?? loadFoldFile(root, fd, stat, path);
  const valid =
    snapshot !== undefined &&
    snapshot.inode === stat.ino &&
    snapshot.device === stat.dev &&
    stat.size >= snapshot.size &&
    stat.size >= snapshot.offset;
  const offset = valid ? snapshot.offset : 0;
  let lineCount = valid ? snapshot.lineCount : 0;
  const runs = new Map<string, FoldedRun>(
    valid ? snapshot.runs.map((run) => [run.id, run]) : [],
  );
  const malformedRows = valid ? snapshot.malformed : [];
  const read = fromThrowable(() =>
    readRecordBatches(
      fd,
      offset,
      stat.size,
      path,
      lineCount + 1,
      (batch) => {
        foldInto(runs, batch);
      },
      malformedRows,
    ),
  )();
  closeSync(fd);
  if (read.isErr())
    return exitWithError(
      "agx: cannot read record log: " + String(read.error) + "\n",
      1,
    );
  const { consumed: complete, lineCount: readLines } = read.value;
  lineCount += readLines;
  malformed?.push(...malformedRows);
  foldCache.set(path, {
    version: 1,
    inode: stat.ino,
    device: stat.dev,
    size: stat.size,
    offset: offset + complete,
    lineCount,
    runs: [...runs.values()],
    malformed: malformedRows,
  });
  return { runs, stat };
}

/** The recorded fold excludes PID-based live/lost inference. */
export function recordedFoldedRuns(root = stateDir()): FoldedRun[] {
  return [...(readRecordedFold(root)?.runs.values() ?? [])];
}

async function readFoldedRuns(
  root: string,
  malformed?: Record<string, unknown>[],
  probes?: Map<string, ListedRun>,
) {
  const fold = readRecordedFold(root, malformed);
  if (fold === undefined) return [];
  return liveRuns(fold.runs, fold.stat, root, undefined, probes);
}

export async function recordedRuns(root = stateDir()) {
  return readFoldedRuns(root, undefined, new Map());
}

const foldCache = new Map<string, z.output<typeof SnapshotSchema>>();

/**
 * The folded log prefix, published so a reader replays only the bytes appended after it. The
 * prefix identity is the log's inode and device, its consumed byte length, and the hash of its
 * last complete line (`tailStart` is where that line begins): an append keeps the identity, any
 * rewrite or truncation breaks it, and a reader that finds a mismatch folds the whole log.
 */
const FoldFileSchema = z
  .object({
    version: z.literal(2),
    writer: z.literal(packageJson.version),
    inode: z.number(),
    device: z.number(),
    offset: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    tailStart: z.number().int().nonnegative(),
    tailHash: z.string(),
    // Written by the fold of this same release (`writer`), so not re-validated per run: parsing
    // through RunSchema would cost seconds and reorder keys the full fold emits in fold order.
    runs: z.array(
      z.custom<FoldedRun>((run) => typeof run === "object" && run !== null),
    ),
    malformed: z.array(LegacyRow),
  })
  .refine((file) => file.tailStart <= file.offset);
const foldFilePath = (root: string) => join(root, "records.snapshot.json");
/** What the reader last proved equal to the file on disk, so an unchanged prefix is not rewritten. */
const persisted = new Map<string, { inode: number; offset: number }>();

function hashRange(fd: number, from: number, to: number): string {
  return createHash("sha256")
    .update(readChunk(fd, from, to - from))
    .digest("hex");
}

/** Start of the last complete line in bytes [0, offset); `offset` ends on a newline. */
function lastLineStart(fd: number, offset: number): number {
  let end = offset - 1; // the newline that ends the last line
  while (end > 0) {
    const from = Math.max(0, end - 65_536);
    const block = readChunk(fd, from, end - from);
    const newline = block.lastIndexOf(10);
    if (newline >= 0) return from + newline + 1;
    end = from;
  }
  return 0;
}

/** Read-only: a missing, unparsable or mismatching file means no snapshot, never an error. */
function loadFoldFile(
  root: string,
  fd: number,
  stat: { ino: number; dev: number; size: number },
  path: string,
): z.output<typeof SnapshotSchema> | undefined {
  const text = fromThrowable(() => readFileSync(foldFilePath(root), "utf8"))();
  if (text.isErr()) return undefined;
  const file = jsonOf(FoldFileSchema).safeParse(text.value);
  if (
    !file.success ||
    file.data.inode !== stat.ino ||
    file.data.device !== stat.dev ||
    file.data.offset > stat.size
  )
    return undefined;
  const hash = fromThrowable(() =>
    hashRange(fd, file.data.tailStart, file.data.offset),
  )();
  if (hash.isErr() || hash.value !== file.data.tailHash) return undefined;
  persisted.set(path, { inode: file.data.inode, offset: file.data.offset });
  return {
    version: 1,
    inode: file.data.inode,
    device: file.data.device,
    size: file.data.offset,
    offset: file.data.offset,
    lineCount: file.data.lineCount,
    runs: file.data.runs,
    malformed: file.data.malformed,
  };
}

/** Writers only: publish the fold the last read left in the cache, atomically. */
async function publishFoldFile(root: string): Promise<void> {
  const path = recordPath(root);
  const cached = foldCache.get(path);
  if (cached === undefined) return;
  const done = persisted.get(path);
  if (done?.inode === cached.inode && done.offset === cached.offset) return;
  const fd = openSync(path, "r");
  const prefix = fromThrowable(() => {
    const info = fstatSync(fd);
    if (info.ino !== cached.inode || info.dev !== cached.device) return null;
    if (info.size < cached.offset) return null;
    const tailStart =
      cached.offset === 0 ? 0 : lastLineStart(fd, cached.offset);
    return { tailStart, tailHash: hashRange(fd, tailStart, cached.offset) };
  })();
  closeSync(fd);
  if (prefix.isErr() || prefix.value === null) return;
  const target = foldFilePath(root);
  const temp = target + "." + crypto.randomUUID() + ".tmp";
  await writeFile(
    temp,
    JSON.stringify({
      version: 2,
      writer: packageJson.version,
      inode: cached.inode,
      device: cached.device,
      offset: cached.offset,
      lineCount: cached.lineCount,
      ...prefix.value,
      runs: cached.runs,
      malformed: cached.malformed,
    }),
    { mode: 0o600 },
  );
  await rename(temp, target);
  persisted.set(path, { inode: cached.inode, offset: cached.offset });
}

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
  probes?: Map<string, ListedRun>,
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
    const probed = probes?.get(run.id);
    const matchingProbe =
      probed !== undefined &&
      JSON.stringify(probed.lease) === JSON.stringify(lease);
    let evidence: z.output<typeof Evidence> | undefined;
    if (probes === undefined) evidence = await lossEvidence(lease);
    else if (matchingProbe && probed.outcome === "lost")
      evidence = probed.evidence;
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
  if (losses.size === 0 || probes !== undefined) return listed;
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

/** The workspace lock excludes the run owner while sealing a confirmed loss. */
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
    const lifetime = recordedLifetime(run.id, root);
    if (lifetime.state === "ended")
      freeRunTemp(lifetime, undefined, root).mapErr((error) =>
        process.stderr.write(`${error}\n`),
      );
  }
}

export async function publishCurrentRuns(
  root = stateDir(),
  ownership?: AcquiredWorkspaceLock,
  clock?: WorkspaceLockWaitClock,
): Promise<void> {
  const path = join(root, "current-runs.json");
  // Probe and reconcile before acquiring the publication lock. A judge already
  // holding it publishes recorded state immediately without probing.
  let probes = new Map<string, ListedRun>();
  if (ownership === undefined) {
    await reconcileLostRuns(root);
    probes = new Map((await readFoldedRuns(root)).map((run) => [run.id, run]));
  }
  const lock =
    ownership ??
    (await acquireWorkspaceLockUntilAvailable(path, root, undefined, clock));
  if (!lock.ok) {
    process.stderr.write(
      "agx: cannot publish current runs: " + lock.error + "\n",
    );
    return;
  }
  const held = lock;
  let captured: z.output<typeof RecordIdentity> | null | undefined;
  const result = await fromPromise(
    (async () => {
      const source = await recordIdentity(root);
      const runs = await readFoldedRuns(root, undefined, probes);
      captured = source;
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
  // The per-workspace files are rewritten for every workspace in the log (thousands), so they
  // never sit under the lock: readers compare each file's source with the log and rescan when stale.
  if (ownership === undefined && captured !== undefined)
    await publishFoldFile(root).catch((error: unknown) =>
      process.stderr.write(`agx: cannot publish fold: ${String(error)}\n`),
    );
  if (ownership === undefined && captured !== undefined)
    await publishWorkspaceRuns(root, captured).catch((error: unknown) =>
      process.stderr.write(
        `agx: cannot publish workspace runs: ${String(error)}\n`,
      ),
    );
}

/** Rewrite the per-workspace files for the current log; callers hold no lock. */
export async function publishWorkspacePublications(
  root = stateDir(),
): Promise<void> {
  const source = await recordIdentity(root);
  await readFoldedRuns(root);
  await publishWorkspaceRuns(root, source).catch((error: unknown) =>
    process.stderr.write(
      `agx: cannot publish workspace runs: ${String(error)}\n`,
    ),
  );
}
