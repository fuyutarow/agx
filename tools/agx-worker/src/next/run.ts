import { newRoutingAudit, recordRoutingPick } from "./routing-events.ts";
import { fromThrowable } from "neverthrow";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { stableCommand, stableSelfCommand } from "../self-command.ts";
import { legacyLandStatus } from "../state.ts";
import { verifyLine } from "../ticket.ts";
import { claudeBashDenyLines } from "../claude-bash-denies.ts";
import {
  EMPTY_FINAL_MESSAGE,
  managerReport,
  parseReport,
  parseReturn,
  receiptReportInput,
  withReportInstruction,
} from "../report.ts";
import { type NextTicket } from "./ticket.ts";
import {
  resolveTicketReference,
  ticketContext,
  ticketPlacement,
} from "./ticket-home.ts";
import {
  append,
  flushRunPublications,
  acquireWorkspaceLock,
  acquireWorkspaceLockUntilAvailable,
  events,
  foldedRuns,
  now,
  overlapWarnings,
  publishCurrentRuns,
  publishWorkspacePublications,
  recordedRuns,
  recordedFoldedRuns,
  recordPath,
  runningWorkspaceRun,
  stateDir,
  type WorkspaceLockWaitClock,
} from "./store.ts";
import {
  codexHostDeclarationPath,
  readCodexHostDeclaration,
} from "../workers/codex-host.ts";
import { resourceBriefFallback } from "../workers/codex-resource-probe.ts";
import { leaseFor, type StopSignal } from "./lease.ts";
import { route, type CapacityRetryRouteResult } from "./route.ts";
import { pinContinuation } from "./continue.ts";
import { resolveRunId } from "./run-id.ts";
import { routeFilterLabel } from "../roster/index.ts";
import {
  earlyQuitRows,
  preflight,
  printPreflightFailures,
  recordRefusal,
} from "./preflight.ts";
import {
  agxTempRoot,
  createRunTemp,
  freeRunTemp,
  recordedLifetime,
} from "../temp.ts";
import {
  claudeWorkspaceWriteAllowedTools,
  claudeWorkspaceWriteSettings,
  removeClaudeSandboxStubs,
} from "../workers/environment.ts";
import { exitWithError } from "./exit.ts";
import { guardPreLaunch } from "./launch-guard.ts";
import {
  Outcome,
  changedPaths,
  deriveOutcome,
  workspaceSnapshot,
} from "./outcome.ts";
import {
  verifyKind,
  verifyLogName,
  verifyRoundOf,
  ownSuiteDirectory,
  withSuitePath,
  type VerifyKind,
} from "./verify.ts";
import { measureRunDir } from "./run-state.ts";
import { scheduleEndNotice } from "./end-notice.ts";
import { completionFor } from "./completion.ts";
import {
  lookupAddress,
  type Outcome as LookupOutcome,
} from "../../../reason-transport/src/index.ts";

export type Flags = Readonly<Record<string, string | boolean | undefined>>;
const fatal = (message: string, exitCode = 2): never =>
  exitWithError(`agx: ${message}\n`, exitCode);
const value = (flags: Flags, key: string): string | undefined =>
  typeof flags[key] === "string" ? flags[key] : undefined;
export function systemdUnitName(cgroup: string): string | undefined {
  const unit = cgroup
    .split(/\r?\n/u)
    .flatMap((line) => line.split("/"))
    .findLast((part) => part.endsWith(".service"));
  return unit?.slice(0, -".service".length);
}
export const dispatcherIdentityFor = (
  session: string | null,
  env: NodeJS.ProcessEnv,
): string | null => {
  if (session === null || session.trim() === "") return null;
  if (session.startsWith("claude:")) return session;
  if (session.startsWith("codex:"))
    return `codex:${env.CODEX_THREAD_ID ?? session.slice(6)}`;
  const declaredVendor =
    env.AGX_DISPATCHER_VENDOR === "codex" ||
    env.AGX_DISPATCHER_VENDOR === "claude"
      ? env.AGX_DISPATCHER_VENDOR
      : undefined;
  const matchingVendors = [
    ...(env.CLAUDE_CODE_SESSION_ID === session ? ["claude"] : []),
    ...(env.CODEX_SESSION_ID === session || env.CODEX_THREAD_ID === session
      ? ["codex"]
      : []),
  ];
  const vendor =
    declaredVendor ??
    (matchingVendors.length === 1 ? matchingVendors[0] : undefined);
  const target =
    vendor === "codex" ? (env.CODEX_THREAD_ID ?? session) : session;
  return vendor === undefined ? null : `${vendor}:${target}`;
};
const invocationUnitFor = async (): Promise<string | undefined> => {
  if (
    process.env.INVOCATION_ID === undefined ||
    process.env.INVOCATION_ID === ""
  )
    return undefined;
  const cgroup = await readFile("/proc/self/cgroup", "utf8").catch(() => null);
  return cgroup === null ? undefined : systemdUnitName(cgroup);
};
const refuseRunningWorkspace = async (
  cwd: string,
  exceptId?: string,
): Promise<void> => {
  const holder = await runningWorkspaceRun(cwd, exceptId);
  if (holder !== undefined)
    fatal(`workspace ${cwd} already has running run ${holder.id}`, 2);
};
const contextFor = async (path: string, cwd: string, ticket: NextTicket) => {
  const located = await ticketContext(dirname(resolve(path)));
  if (!located.ok) return fatal(located.error);
  // External declared homes have no repository ancestor. In that case only,
  // use the supplied workspace to find the declaration and verify placement.
  const repository =
    located.vcs === undefined ? await ticketContext(cwd) : located;
  if (!repository.ok) return fatal(repository.error);
  const placement = await ticketPlacement(path, repository);
  if (placement !== null) return fatal(placement);
  // Placement belongs to the ticket repository; execution provenance belongs to
  // --cd, including a scratch directory with no repository or commit.
  const worker =
    resolve(cwd) === repository.root ? repository : await ticketContext(cwd);
  if (!worker.ok) return fatal(worker.error);
  const ctx = {
    ...repository,
    base_rev: worker.base_rev,
    revision: worker.revision,
    vcs: worker.vcs,
    verifyAlways: worker.verifyAlways,
  };
  if (ticket.base_rev !== undefined && ticket.base_rev !== ctx.base_rev)
    return fatal(
      `base_rev mismatch: ticket ${resolve(path)}, declared ${ticket.base_rev}, repository ${ctx.root}, worker ${cwd} commit ${ctx.base_rev ?? null}`,
    );
  return ctx;
};
export async function lookupDispatcher(
  identity: string | null,
): Promise<LookupOutcome<string>> {
  if (identity === null)
    return { kind: "unavailable", text: "dispatcher identity unavailable" };
  const binary = Bun.which(
    "reason-network",
    process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
  );
  if (binary === null)
    return { kind: "unavailable", text: "reason-network not found" };
  const separator = identity.indexOf(":");
  return lookupAddress({
    binary,
    vendor: identity.slice(0, separator),
    session: identity.slice(separator + 1),
    deadlineMs: 5000,
  });
}
const ackLines = (
  routeName: string | undefined,
  result: LookupOutcome<string> | undefined,
): string[] => {
  if (routeName === "claude") return [];
  if (result?.kind !== "accepted")
    return ["No completion ACK: the run-end notice reports the end."];
  return [
    `Before ending, send one completion ACK with the Reason Network MCP tool send_message to ${result.value} (locator, verification result, remaining work). If the tool is unavailable, skip the ACK; the run-end notice reports the end.`,
    "If the dispatcher renames its session during the run, this address goes stale; the run-end notice still resolves it at the end.",
  ];
};
export const renderPromise = (
  ticket: NextTicket,
  cwd: string,
  sandbox: string,
  prose: string,
  runDir: string,
  continuation?: {
    judgment: Readonly<{ decision: string; note: string }> | null;
    ticketDiff: string;
  },
  ackLookup?: LookupOutcome<string>,
  routeName?: string,
): string =>
  withReportInstruction(
    [
      ...(continuation === undefined
        ? []
        : [
            "Continuation correction:",
            `Prior judgment: ${formatJudgment(continuation.judgment)}`,
            "Ticket diff (continued run's ticket.orig.md → current ticket):",
            continuation.ticketDiff,
            "The prior judgment note and current ticket override the earlier brief.",
            "",
          ]),
      `Proposition ${ticket.proposition.id}: ${ticket.proposition.claim}`,
      `refuted_by: ${ticket.proposition.refuted_by}`,
      "Everything below serves this proposition; do not let a side task displace it.",
      "",
      sandbox === "read-only"
        ? `AGX_RUN_DIR=${runDir}. Return your results in the final response; the runner records the response in its report.`
        : `AGX_RUN_DIR=${runDir}. Write results needed to judge the run directly in $AGX_RUN_DIR (result.md and small files). Put large outputs in $AGX_RUN_DIR/artifacts/; they are reclaimable after judgment. Put caches, venvs and build trees in shared caches or the run temp directory, never the run directory; keep only source changes in the workspace.`,
      "Promise:",
      `outcome: ${ticket.outcome}`,
      `writes: ${JSON.stringify(ticket.writes.map((glob) => resolve(cwd, glob)))}`,
      ...(ticket.verify.length === 0 ? [] : [verifyLine(ticket.verify)]),
      ...(routeName === "claude" ? claudeBashDenyLines(cwd) : []),
      `Sandbox mode: ${sandbox}${sandbox === "none" ? " (unsandboxed)" : ""}.`,
      ...(
        [
          "resources",
          "base_rev",
          "external_reads",
          "first_return_s",
          "network",
        ] as const
      ).flatMap((key) =>
        ticket[key] === undefined
          ? []
          : [`${key}: ${JSON.stringify(ticket[key])}`],
      ),
      'If this work needs a tool release changeset, create it with `mise run changeset -- <tool> <patch|minor|major> "<entry>"`; do not hand-write a `.changes` file.',
      ...ackLines(routeName, ackLookup),
      "",
      prose.trim(),
    ].join("\n"),
  );
const formatJudgment = (
  judgment: Readonly<{ decision: string; note: string }> | null,
): string => {
  if (judgment === null) return "None was recorded.";
  return `${judgment.decision}: ${judgment.note}`;
};
const diffTicket = (original: string, current: string): string => {
  if (!existsSync(original))
    return "(ticket diff unavailable; current ticket text is included below)";
  const result = Bun.spawnSync(
    [
      "diff",
      "-u",
      "--label",
      "ticket.orig.md",
      "--label",
      "current ticket",
      original,
      current,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0) return "(no ticket changes)";
  if (result.exitCode === 1) return result.stdout.toString().trimEnd();
  return "(ticket diff unavailable; current ticket text is included below)";
};
const persistInterim = (id: string, path: string, message: string): boolean => {
  const parsed = parseReturn(message);
  if (parsed.kind !== "valid" || parsed.record.interim !== true) return false;
  const progressText = `${JSON.stringify(parsed.record)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === progressText)
    return true;
  writeFileSync(path, progressText);
  append({ kind: "progress", id, at: now(), path });
  return true;
};

export { earlyQuitRows } from "./preflight.ts";

export function appendVerifyKilledNote(
  logPath: string,
  exit: number,
  signal: string | null,
  unit: string,
): void {
  if (exit !== 137 && signal !== "SIGKILL") return;
  const output = readFileSync(logPath, "utf8");
  appendFileSync(
    logPath,
    `${output !== "" && !output.endsWith("\n") ? "\n" : ""}agx: verify killed by SIGKILL (exit 137); the kernel OOM killer is a common cause; see journalctl --user -u ${unit}\n`,
  );
}

const runVerify = async (
  commands: string[],
  cwd: string,
  runDir: string,
  env: NodeJS.ProcessEnv,
  always: string[],
  unit: string,
  round: number,
  onStart: (
    cmd: string,
    logPath: string,
    child: ReturnType<typeof Bun.spawn>,
  ) => void,
  onResult: (result: {
    cmd: string;
    exit: number;
    log_path: string;
    kind: VerifyKind;
    source?: "[verify].always";
  }) => void,
): Promise<
  {
    cmd: string;
    exit: number;
    log_path: string;
    kind: VerifyKind;
    source?: "[verify].always";
  }[]
> => {
  const results: {
    cmd: string;
    exit: number;
    log_path: string;
    kind: VerifyKind;
    source?: "[verify].always";
  }[] = [];
  for (const [index, cmd] of [...always, ...commands].entries()) {
    const source =
      index < always.length ? ("[verify].always" as const) : undefined;
    const logPath = join(runDir, verifyLogName(round + 1, index));
    const fd = openSync(logPath, "w");
    const child = Bun.spawn(
      ["sh", "-c", 'exec 2>&1; sh -c "$1"', "agx-verify", cmd],
      {
        cwd,
        stdin: "ignore",
        stdout: fd,
        stderr: "ignore",
        detached: process.platform !== "win32",
        env,
      },
    );
    closeSync(fd);
    onStart(cmd, logPath, child);
    const exit = await child.exited;
    appendVerifyKilledNote(logPath, exit, child.signalCode, unit);
    const kind = verifyKind(exit, child.signalCode);
    process.stderr.write(
      `VERIFY exit=${exit} ${cmd} kind=${kind}${source === undefined ? "" : ` source=${source}`}\n`,
    );
    const result = {
      cmd,
      exit,
      log_path: logPath,
      kind,
      ...(source === undefined ? {} : { source }),
    };
    results.push(result);
    onResult(result);
  }
  return results;
};

export async function check(flags: Flags): Promise<number> {
  const input = value(flags, "ticket");
  const cwd = resolve(value(flags, "cd") ?? process.cwd());
  if (input === undefined) return fatal("check requires positional TICKET", 2);
  const reference = await resolveTicketReference(input, process.cwd());
  if (reference.contextError !== undefined)
    return fatal(reference.contextError, reference.contextExitCode ?? 2);
  const { path } = reference;
  const inspected = await preflight(path, cwd, flags, reference);
  if (inspected.lineageRefusal !== undefined)
    return fatal(inspected.lineageRefusal, 2);
  if (inspected.temporary !== undefined)
    return fatal(inspected.temporary.message, 75);
  if (inspected.failures.length > 0) {
    if (inspected.effectFreeRefusal !== true)
      recordRefusal(path, cwd, inspected.bytes, inspected.failures);
    if (flags.json === true)
      process.stdout.write(
        `${JSON.stringify({ ok: false, violations: inspected.failures.map(String) })}\n`,
      );
    return printPreflightFailures(inspected.failures);
  }
  const { ticket, loaded } = inspected;
  if (ticket === undefined || !loaded.ok)
    return fatal("preflight did not resolve ticket and roster");
  await overlapWarnings(ticket.writes, inspected.ctx?.root ?? cwd);
  if (flags.skipRouting === true) {
    process.stdout.write(
      flags.json === true
        ? `${JSON.stringify({ ok: true, routing_checked: false, violations: [] })}\n`
        : "preflight passed; routing not checked\n",
    );
    return 0;
  }
  const routing = await route(
    `Proposition ${ticket.proposition.id}: ${ticket.proposition.claim}\n${inspected.prose}`,
    ticket.capabilities,
    ticket.timeout_s ?? 600,
    await earlyQuitRows(ticket.name ?? basename(path, ".md"), cwd),
    {},
    {
      path: resolve(path),
      sha256: createHash("sha256")
        .update(inspected.bytes ?? "")
        .digest("hex"),
      min_effort: ticket.min_effort,
    },
    {
      capacityRetry: true,
      timeoutMs: (ticket.timeout_s ?? 600) * 1000,
      inspect: true,
    },
  );
  if (routing.kind !== "selected") {
    const message =
      routing.kind === "refused"
        ? routing.message
        : "route refused: no eligible row\n";
    if (flags.json === true)
      process.stdout.write(
        `${JSON.stringify({ ok: false, routing_checked: true, violations: [message.trim()] })}\n`,
      );
    process.stderr.write(message);
    return routing.kind === "refused" ? routing.exitCode : 2;
  }
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, routing_checked: true, violations: [] })}\n`,
    );
    return 0;
  }
  process.stdout.write(
    `OK ticket=${ticket.name ?? basename(path, ".md")} cwd=${cwd} ${routeFilterLabel(loaded.value.auto)}\n`,
  );
  if (inspected.pinned !== undefined && inspected.pinned !== null)
    process.stdout.write(
      `CONTINUE run=${inspected.pinned.previousId} row=${inspected.pinned.previousRow} -> ${inspected.pinned.row.id} workspace=${inspected.pinned.workspace}\n`,
    );
  if ((inspected.ctx?.verifyAlways.length ?? 0) > 0)
    process.stdout.write(
      `[verify].always=${JSON.stringify(inspected.ctx?.verifyAlways)}\n`,
    );
  return 0;
}

const lastLine = (file: string): string | undefined =>
  existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").at(-1)
    : undefined;

/** Publications already scheduled by earlier records get this long to finish before a run process exits. */
const PUBLICATION_SETTLE_MS = 2_000;

/**
 * Wait briefly for in-flight publications, never for a contended one: a publication replays the
 * whole log under the current-runs lock, which other writers and judges may hold for minutes.
 */
export async function settleRunPublications(
  limitMs = PUBLICATION_SETTLE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((done) => {
    timer = setTimeout(done, limitMs);
  });
  await Promise.race([flushRunPublications(), limit]);
  clearTimeout(timer);
}

export async function run(flags: Flags): Promise<number> {
  const guard = guardPreLaunch(value(flags, "dispatchBinding"));
  const running = runUnguarded(flags);
  // The side branch records the failure; the caller still sees the original rejection.
  running.catch((error: unknown) => {
    guard.noteError(error);
  });
  return running;
}

async function runUnguarded(flags: Flags): Promise<number> {
  if (process.env.AGX_NEXT_WORKER !== undefined)
    return fatal(
      "AGX_NEXT_WORKER is no longer supported; use AGX_WORKER_BIN",
      2,
    );
  const input = value(flags, "ticket");
  const cwd = resolve(value(flags, "cd") ?? process.cwd());
  if (input === undefined) return fatal("run requires positional TICKET", 2);
  const reference = await resolveTicketReference(input, process.cwd());
  if (reference.contextError !== undefined)
    return fatal(reference.contextError, reference.contextExitCode ?? 2);
  const { path } = reference;
  const inspected = await preflight(path, cwd, flags, reference);
  if (inspected.lineageRefusal !== undefined)
    return fatal(inspected.lineageRefusal, 2);
  if (
    inspected.effectFreeRefusal !== true &&
    (inspected.temporary !== undefined || inspected.failures.length > 0)
  ) {
    const audit = newRoutingAudit(
      {
        path: resolve(path),
        sha256:
          inspected.bytes === null || inspected.bytes === undefined
            ? "unavailable"
            : createHash("sha256").update(inspected.bytes).digest("hex"),
        launch: true,
      },
      inspected.ticket?.capabilities,
      inspected.ticket?.timeout_s,
    );
    audit.outcome_kind = "held";
    audit.reason =
      inspected.temporary?.message ??
      (inspected.failures ?? []).map(String).join("; ");
    if (inspected.loaded?.ok === true) {
      audit.policy_version = inspected.loaded.provenance.policy_version;
      audit.catalog_version = inspected.loaded.provenance.catalog_version;
      audit.pick_temperature = inspected.loaded.value.auto.pick_temperature;
    }
    recordRoutingPick(null, "preflight-refusal", audit, "refusal");
  }
  if (inspected.temporary !== undefined)
    return fatal(inspected.temporary.message, 75);
  if (inspected.failures.length > 0) {
    if (inspected.effectFreeRefusal !== true)
      recordRefusal(path, cwd, inspected.bytes, inspected.failures);
    return printPreflightFailures(inspected.failures);
  }
  const {
    ticket,
    prose,
    bytes,
    ctx,
    sandbox,
    sandbox_source,
    binding,
    pinned: inspectedContinuation,
    premise_commits,
    environment,
  } = inspected;
  if (
    ticket === undefined ||
    bytes === null ||
    ctx === undefined ||
    environment === undefined
  )
    return fatal("preflight did not resolve ticket and context");
  const timeoutMs = (ticket.timeout_s ?? 600) * 1000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const runStartedAt = performance.now();
  const actualUnit = await invocationUnitFor();
  const ticketName = ticket.name ?? basename(path, ".md");
  const continuationId = value(flags, "continue");
  const routing = {
    brief: `Proposition ${ticket.proposition.id}: ${ticket.proposition.claim}\n${prose}`,
    capabilities: ticket.capabilities ?? [],
    timeoutS: ticket.timeout_s ?? 600,
    maskedRows: await earlyQuitRows(ticketName, cwd),
    min_effort: ticket.min_effort,
  };
  const selectedContinuation =
    continuationId === undefined
      ? undefined
      : await pinContinuation(continuationId, path, routing);
  const pinned = selectedContinuation ?? inspectedContinuation;
  const supersedes =
    pinned?.supersedes ?? value(flags, "supersedes") ?? ticket.supersedes;
  const resumeSession = pinned?.resumeSession;
  const continuation =
    pinned === undefined || pinned === null
      ? undefined
      : {
          judgment: pinned.judgment,
          ticketDiff: diffTicket(pinned.ticketOrigPath, resolve(path)),
        };
  let currentResumeSession = resumeSession;
  let latestVendorSession = resumeSession ?? null;
  await overlapWarnings(ticket.writes, ctx.root);
  if (ctx.vcs === undefined)
    process.stderr.write(
      "agx: no repository in --cd; base_rev absent; repository changes, end commit and landing unavailable\n",
    );
  const selectedRoute =
    pinned?.row === undefined
      ? await route(
          routing.brief,
          routing.capabilities,
          routing.timeoutS,
          routing.maskedRows,
          {},
          {
            path: resolve(path),
            launch: true,
            min_effort: routing.min_effort,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          { capacityRetry: true, timeoutMs },
        )
      : ({
          kind: "selected",
          row: pinned.row,
        } satisfies CapacityRetryRouteResult);
  if (deadline.aborted)
    return fatal("ticket time box expired before worker startup", 124);
  if (selectedRoute.kind === "exhausted")
    return fatal("no roster row satisfies the ticket's requirements", 2);
  if (selectedRoute.kind === "refused") {
    recordRefusal(path, cwd, bytes, [selectedRoute.message.trimEnd()]);
    const id = binding?.id ?? randomUUID();
    const runDir = resolve(stateDir(), "runs", id);
    const reportPath = join(runDir, "report.json");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      reportPath,
      `${JSON.stringify({ outcome: "route-refused", summary: selectedRoute.message, changes: [], checks: [], for_coordinator: [], open: [selectedRoute.message] })}\n`,
    );
    if (binding !== undefined)
      append({
        kind: "ended",
        id: binding.id,
        at: now(),
        exit: selectedRoute.exitCode,
        outcome: "refused",
        cause: selectedRoute.message.trimEnd(),
        report_path: reportPath,
        vendor_session: resumeSession ?? null,
        verify: [],
      });
    process.stdout.write(
      `${JSON.stringify({ id, outcome: "route-refused", report_path: reportPath, refusal: selectedRoute.message })}\n`,
    );
    return fatal(selectedRoute.message, selectedRoute.exitCode);
  }
  const row = selectedRoute.row;
  let activeRow = row;
  const attemptedRows = [row.id];
  let claudeRouteRan = false;
  const id = binding?.id ?? randomUUID();
  // Reclaim only recorded terminal runs, including owners killed after recording the end.
  const endedIds = new Set(
    recordedFoldedRuns()
      .filter((record) => record.state === "ended" && record.ended_at !== null)
      .map((record) => record.id),
  );
  for (const endedId of endedIds) {
    if (!existsSync(join(agxTempRoot(), endedId, "tmp"))) continue;
    const lifetime = recordedLifetime(endedId);
    if (lifetime.state === "ended")
      freeRunTemp(lifetime).mapErr((error) =>
        process.stderr.write(`${error}\n`),
      );
  }
  const made = createRunTemp(id);
  if (made.isErr()) return exitWithError(`${made.error}\n`, 1);
  const temp = made.value;
  Object.assign(process.env, temp.env);
  const cleanupTemp = () => {
    const lifetime = recordedLifetime(id);
    if (lifetime.state === "ended")
      freeRunTemp(lifetime).mapErr((error) =>
        process.stderr.write(`${error}\n`),
      );
  };
  process.on("exit", cleanupTemp);
  const runDir = resolve(stateDir(), "runs", id);
  let activeProgressPath = join(runDir, "worker-progress.jsonl");
  let started = false;
  let ended = false;
  let dispatcherIdentity: string | null = null;
  let stopTask: Promise<never> | undefined;
  let killWorker: (() => void) | undefined;
  let verifyProgress: {
    cmd: string;
    exit: number;
    log_path: string;
    kind: VerifyKind;
    source?: "[verify].always";
  }[] = [];
  let activeVerify:
    | { cmd: string; log_path: string; child: ReturnType<typeof Bun.spawn> }
    | undefined;
  let stoppedRound = 0;
  const vendorSessionFromProgress = (): string | undefined => {
    const progress = fromThrowable(() =>
      readFileSync(activeProgressPath, "utf8"),
    )();
    if (progress.isErr()) return undefined;
    const parsed = jsonOf(
      z.looseObject({ session: z.string().optional() }),
    ).safeParse(progress.value);
    return parsed.success ? parsed.data.session : undefined;
  };
  let recordedVendorSession = resumeSession;
  const persistVendorSession = (
    session = vendorSessionFromProgress(),
  ): void => {
    if (session === undefined || session === recordedVendorSession) return;
    append({ kind: "session", id, at: now(), vendor_session: session });
    recordedVendorSession = session;
  };
  const stop = (signal: StopSignal, code: number): void => {
    if (stopTask !== undefined) return;
    const requested = events().findLast(
      (event) => event.kind === "stop-requested" && event.id === id,
    );
    const request =
      requested?.kind === "stop-requested" ? requested : undefined;
    const vendorSession =
      request?.vendor_session ??
      latestVendorSession ??
      currentResumeSession ??
      vendorSessionFromProgress() ??
      null;
    persistVendorSession(vendorSession ?? undefined);
    killWorker?.();
    if (activeVerify !== undefined) {
      const { cmd, log_path, child } = activeVerify;
      if (process.platform !== "win32")
        fromThrowable(() => process.kill(-child.pid, "SIGKILL"))();
      child.kill("SIGKILL");
      verifyProgress.push({ cmd, log_path, exit: code, kind: "interrupted" });
      activeVerify = undefined;
    }
    if (started && !ended) {
      ended = true;
      const endedAt = now();
      stopTask = (async () => {
        const stoppedReportPath = join(runDir, "report.json");
        const resultFile = join(runDir, "result.md");
        writeFileSync(
          stoppedReportPath,
          `${JSON.stringify({ outcome: "stopped", result: existsSync(resultFile) ? resultFile : "unknown", verify: verifyProgress, verify_round: stoppedRound === 0 ? undefined : stoppedRound })}\n`,
        );
        const parts = verifyProgress.map((v) => {
          const label =
            v.kind === "interrupted"
              ? "interrupted"
              : `completed exit=${v.exit}`;
          return `${label}: ${v.cmd} (log: ${v.log_path})`;
        });
        const details = parts.length === 0 ? "not run" : parts.join(", ");
        const runDirSize = measureRunDir(runDir);
        const endNotice = scheduleEndNotice({
          runDirSize,
          id,
          ticket: ticketName,
          dispatcher: dispatcherIdentity,
          startedAt,
          endedAt,
          outcome: "stopped",
          exit: code,
          resultPath: stoppedReportPath,
          verifyExits: verifyProgress
            .filter((v) => v.kind !== "interrupted")
            .map((v) => v.exit),
          verifyDetails: details,
          detachUnit: process.env.INVOCATION_ID !== undefined,
        });
        append(
          {
            kind: "ended",
            id,
            run_dir_bytes: runDirSize.bytes,
            at: endedAt,
            exit: code,
            outcome: "stopped",
            end_notice: endNotice,
            signal,
            stopped_by: request?.stopped_by ?? `signal:${signal}`,
            report_path: stoppedReportPath,
            vendor_session: vendorSession,
            ...(attemptedRows.length > 1 ? { rows: attemptedRows } : {}),
            ...(attemptedRows.length > 1
              ? {
                  final_row: {
                    id: activeRow.id,
                    route: activeRow.route,
                    model: activeRow.model,
                    effort: activeRow.effort,
                  },
                }
              : {}),
            verify: verifyProgress,
          },
          stateDir(),
          false,
        );
        await settleRunPublications();
        process.exit(code);
      })();
      return;
    }
    if (started && ended) return;
    stopTask = (async () => {
      await settleRunPublications();
      process.exit(code);
    })();
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    process.on(signal, stop.bind(undefined, signal, code));
  mkdirSync(runDir, { recursive: true });
  const ticketPath = join(runDir, "ticket.orig.md");
  const ticket_sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(ticketPath, bytes, { flag: "wx" });
  await writeFile(
    join(runDir, "ticket.orig.md.sha256"),
    `${ticket_sha256}  ticket.orig.md\n`,
    { flag: "wx" },
  );
  const reportPath = join(runDir, "report.json");
  const workerBrief = join(runDir, "brief.md");
  const progressPath = join(runDir, "last-progress.json");
  const interimPath = join(runDir, "interim.jsonl");
  const agxDispatcherSession = process.env.AGX_DISPATCHER_SESSION;
  const claudeSession = process.env.CLAUDE_CODE_SESSION_ID;
  const codexSession =
    process.env.CODEX_SESSION_ID ?? process.env.CODEX_THREAD_ID;
  let dispatcher: string | null = null;
  const explicitSession = value(flags, "session");
  if (explicitSession !== undefined && explicitSession !== "")
    dispatcher = explicitSession;
  else if (agxDispatcherSession !== undefined && agxDispatcherSession !== "")
    dispatcher = agxDispatcherSession;
  else if (claudeSession !== undefined && claudeSession !== "")
    dispatcher = claudeSession;
  else if (codexSession !== undefined && codexSession !== "")
    dispatcher = codexSession;
  dispatcherIdentity = dispatcherIdentityFor(dispatcher, process.env);
  const ackLookup = await lookupDispatcher(dispatcherIdentity);
  if (dispatcher === null)
    process.stderr.write(
      "WARN dispatcher session is unavailable; pass --session ID or preserve CLAUDE_CODE_SESSION_ID/CODEX_SESSION_ID (systemd-run: use -E NAME).\n",
    );
  const workspace = resolve(pinned?.workspace ?? cwd);
  writeFileSync(
    workerBrief,
    withReportInstruction(
      renderPromise(
        ticket,
        cwd,
        sandbox,
        prose,
        runDir,
        continuation,
        ackLookup,
        row.route,
      ),
    ),
  );
  let briefIsOriginal = true;
  let sandbox_effective: string = sandbox;
  let sandbox_effective_source: string = sandbox_source;
  if (row.route === "codex") {
    const hostPath = codexHostDeclarationPath();
    const host = readCodexHostDeclaration(hostPath);
    if (host.kind === "invalid") return fatal(host.reason);
    if (sandbox === "none") sandbox_effective = "danger-full-access";
    if (host.kind === "valid") {
      sandbox_effective = "danger-full-access";
      sandbox_effective_source = `host declaration: ${hostPath}: ${host.declaration.unsandboxedReason}`;
    } else if (sandbox !== "none" && process.env.AGX_WORKER_BIN === undefined) {
      const blocked = resourceBriefFallback(
        readFileSync(workerBrief, "utf8"),
        sandbox,
      );
      sandbox_effective =
        blocked === undefined ? sandbox : "danger-full-access";
      sandbox_effective_source =
        blocked === undefined
          ? sandbox_source
          : `resource probe: sandbox blocks ${blocked}`;
    }
  }
  const launchContext = await contextFor(path, cwd, ticket);
  if (launchContext.base_rev !== ctx.base_rev)
    return fatal(
      `--cd commit changed before launch: checked ${ctx.base_rev}, now ${launchContext.base_rev ?? "unavailable"}`,
    );
  const workspaceLock = await acquireWorkspaceLock(workspace);
  if (!workspaceLock.ok) {
    // The winning process may be between flock and publishing its started event.
    // Only diagnostics wait (at most 100 ms); acquisition itself never waits or retries.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await refuseRunningWorkspace(cwd, id);
      await Bun.sleep(10);
    }
    return fatal(
      `cannot start in workspace ${workspace}: ${workspaceLock.error}`,
      2,
    );
  }
  // Also covers runs started by an older binary while this invocation was routing.
  await refuseRunningWorkspace(cwd, id);
  const unit = binding?.unit ?? actualUnit ?? `agt_${ticketName}`;
  const workerName = unit;
  const startedLease = await leaseFor(
    process.pid,
    process.env.INVOCATION_ID !== undefined && process.env.INVOCATION_ID !== ""
      ? `${unit}.service`
      : null,
  );
  if (stopTask !== undefined) await stopTask;
  const startedAt = now();
  append({
    kind: "started",
    id,
    at: startedAt,
    ticket: binding?.ticket ?? ticketName,
    writes: ticket.writes,
    cwd,
    workspace,
    worker_name: workerName,
    unit,
    workspace_name: basename(workspace),
    row: row.id,
    route: row.route,
    model: row.model,
    effort: row.effort,
    sandbox,
    sandbox_source,
    sandbox_effective,
    sandbox_effective_source,
    dispatcher_session: dispatcher,
    ack_lookup_kind: ackLookup.kind,
    vendor_session: resumeSession ?? null,
    continues:
      supersedes === undefined
        ? (pinned?.previousId ?? continuationId ?? null)
        : null,
    continued_from_row: pinned?.previousRow,
    supersedes: supersedes ?? null,
    base_rev: ctx.base_rev ?? undefined,
    premise_commits,
    ticket_path: resolve(path),
    ticket_orig_path: ticketPath,
    ticket_sha256,
    pid: process.pid,
    lease: startedLease,
  });

  started = true;

  const ownCommand = stableSelfCommand();
  const ownExecutable = ownCommand[0];
  if (ownExecutable === undefined)
    return fatal("worker executable unavailable: current command is empty");
  const workerPath =
    process.env.AGX_WORKER_BIN ??
    process.env.AGX_WORKER_COMMAND ??
    ownExecutable;
  const workerArgs = (): string[] => {
    if (process.env.AGX_WORKER_BIN !== undefined)
      return [
        workerPath,
        "--ticket",
        path,
        "--cd",
        cwd,
        "--row",
        activeRow.id,
        ...(currentResumeSession === undefined
          ? []
          : ["--resume", currentResumeSession]),
      ];
    if (activeRow.route === "codex")
      return [
        workerPath,
        "--internal-codex",
        "--choice",
        activeRow.id,
        "--sandbox",
        sandbox,
        "--cd",
        cwd,
        "--prompt-file",
        workerBrief,
        "--run-id",
        id,
        "--receipt-dir",
        runDir,
        "--timeout-s",
        String(ticket.timeout_s ?? 600),
        ...(currentResumeSession === undefined
          ? []
          : ["--resume", currentResumeSession]),
      ];
    let permissionMode = "acceptEdits";
    if (sandbox === "read-only") permissionMode = "plan";
    if (sandbox === "none") permissionMode = "bypassPermissions";
    const claudeSettings =
      sandbox === "workspace-write"
        ? JSON.stringify(
            claudeWorkspaceWriteSettings({ runDir, runTemp: temp.dir }),
          )
        : undefined;
    return [
      workerPath,
      "--internal-claude",
      "--target",
      cwd,
      "--prompt-file",
      workerBrief,
      "--model",
      activeRow.model,
      "--effort",
      activeRow.effort,
      "--permission-mode",
      permissionMode,
      ...(sandbox === "workspace-write"
        ? ["--allowed-tools", claudeWorkspaceWriteAllowedTools()]
        : []),
      ...(claudeSettings === undefined ? [] : ["--settings", claudeSettings]),
      "--max-turns",
      "60",
      "--max-budget-usd",
      "2",
      "--timeout-ms",
      String((ticket.timeout_s ?? 600) * 1000),
      "--progress-file",
      activeProgressPath,
      "--persist-session",
      ...(currentResumeSession === undefined
        ? []
        : ["--resume", currentResumeSession]),
    ];
  };
  const before = workspaceSnapshot(cwd);
  if (activeRow.route === "claude") claudeRouteRan = true;
  const suiteDirectory = ownSuiteDirectory(process.execPath, Bun.main);
  const baseEnv: NodeJS.ProcessEnv = withSuitePath(
    { ...environment, ...temp.env },
    suiteDirectory,
  );
  const workerCommand = Bun.which(workerPath, {
    PATH: baseEnv.PATH ?? "/usr/bin:/bin",
    cwd,
  });
  if (process.env.AGX_WORKER_BIN === undefined && workerCommand === null)
    return fatal(
      `worker executable unavailable: looked for ${workerPath} on PATH=${baseEnv.PATH ?? ""}; set AGX_WORKER_COMMAND to an executable or AGX_WORKER_BIN to a worker script`,
    );
  if (stopTask !== undefined) await stopTask;
  const defaultCommand =
    process.env.AGX_WORKER_COMMAND === undefined
      ? stableSelfCommand()
      : stableCommand([workerCommand ?? workerPath]);
  const execution = {
    executable_path: ownExecutable,
    executable_argv: ownCommand,
    ...(suiteDirectory === undefined
      ? {}
      : { suite_directory: suiteDirectory }),
    path_source:
      process.env.AGX_WORKER_PATH_SOURCE === "dispatcher"
        ? "PATH from dispatcher"
        : "PATH from caller",
  };
  const runEnv = {
    ...baseEnv,
    AGX_RUN_ID: id,
    AGX_RUN_DIR: runDir,
    AGX_INTERIM_REPORTS_FILE: interimPath,
    AGX_CODEX_PROGRESS_FILE: join(runDir, "worker-progress.jsonl"),
  };
  const firstReturnS =
    ticket.first_return_s ?? Math.floor((ticket.timeout_s ?? 600) / 2);
  let progressSeen = false;
  let lateRecorded = false;
  let progressOffset = 0;
  const observeInterim = (): void => {
    if (!existsSync(interimPath)) return;
    const data = readFileSync(interimPath, "utf8");
    const fresh = data.slice(progressOffset);
    progressOffset = data.length;
    const last = fresh.trim().split("\n").at(-1);
    if (last === undefined || last === "") return;
    const record = jsonOf(
      z.looseObject({ last_message: z.string() }),
    ).safeParse(last);
    if (record.success)
      progressSeen ||= persistInterim(
        id,
        progressPath,
        record.data.last_message,
      );
  };
  const workerReceiptSchema = jsonOf(
    z.looseObject({
      report: z.unknown().optional(),
      structured_output: z.unknown().optional(),
      last_message: z.string().optional(),
      result: z.string().optional(),
      vendor_session: z.string().optional(),
      session: z.string().optional(),
      session_id: z.string().optional(),
      outcome: z.string().optional(),
      cause: z.string().optional(),
      timed_out: z.boolean().optional(),
      exit_code: z.number().optional(),
      credential: z.enum(["api_key", "subscription"]).optional(),
      credential_source: z.enum(["env", "fnox", "file"]).optional(),
    }),
  );
  let workerReceipt: z.output<typeof workerReceiptSchema> = {};
  let receiptLine = "";
  let output = "";
  let exit = 0;
  let timedOut = false;
  let capacityExhausted = false;
  let capacityRerouteRefusal: string | undefined;
  let endedOnCapacity = false;
  let routeFailure:
    | Extract<CapacityRetryRouteResult, { kind: "refused" }>
    | undefined;
  let activeChild: ReturnType<typeof Bun.spawn> | undefined;
  killWorker = () => {
    const child = activeChild;
    if (child === undefined) return;
    if (process.platform !== "win32")
      fromThrowable(() => process.kill(-child.pid, "SIGKILL"))();
    child.kill("SIGKILL");
  };
  process.on("exit", killWorker);
  const progressWatcher = setInterval(() => {
    observeInterim();
    persistVendorSession();
    const elapsed = (performance.now() - runStartedAt) / 1000;
    if (!progressSeen && !lateRecorded && elapsed >= firstReturnS) {
      append({
        kind: "late",
        id,
        at: now(),
        first_return_s: firstReturnS,
        elapsed: Math.floor(elapsed),
      });
      lateRecorded = true;
    }
  }, 100);
  let environmentLost = false;
  const checkEnvironment = () => {
    if (existsSync(temp.dir)) return true;
    environmentLost = true;
    return false;
  };
  let attemptNumber = 0;
  let verify: Awaited<ReturnType<typeof runVerify>> = [];
  const verifyRounds: (typeof verify)[] = [];
  // 1-based round that produced `verify`; 0 until verification has run.
  let verifyRoundNumber = 0;
  const verificationFeedback = async (
    session: string | null,
  ): Promise<boolean> => {
    if (!checkEnvironment()) return false;
    verifyRoundNumber = verifyRounds.length + 1;
    stoppedRound = verifyRoundNumber;
    verifyProgress = [];
    verify = await runVerify(
      ticket.verify,
      cwd,
      runDir,
      runEnv,
      ctx.verifyAlways,
      unit,
      verifyRounds.length,
      (cmd, log_path, child) => {
        activeVerify = { cmd, log_path, child };
        writeFileSync(
          join(runDir, "verify-progress.json"),
          `${JSON.stringify({ completed: verifyProgress, active: { cmd, log_path } })}\n`,
        );
      },
      (result) => {
        activeVerify = undefined;
        verifyProgress.push(result);
        writeFileSync(
          join(runDir, "verify-progress.json"),
          `${JSON.stringify({ completed: verifyProgress })}\n`,
        );
      },
    );
    const failed = verify.filter(
      (result) => result.exit !== 0 && result.kind !== "killed",
    );
    if (
      timedOut ||
      deadline.aborted ||
      workerReceipt.timed_out === true ||
      workerReceipt.outcome === "timeout" ||
      exit !== 0 ||
      workerReceipt.outcome === "refused" ||
      (workerReceipt.exit_code !== undefined &&
        workerReceipt.exit_code !== 0) ||
      routeFailure !== undefined ||
      failed.length === 0 ||
      verifyRounds.length >= 2 ||
      session === null ||
      session.trim() === ""
    )
      return false;
    verifyRounds.push(verify);
    currentResumeSession = session;
    const details = failed.map((result) => {
      const lines = readFileSync(result.log_path, "utf8").split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      return `Command: ${result.cmd}\nExit: ${result.exit}\nLog: ${result.log_path}\nLast 80 lines:\n${lines.slice(-80).join("\n")}`;
    });
    briefIsOriginal = false;
    writeFileSync(
      workerBrief,
      withReportInstruction(
        [
          "Verification failed. Fix the errors and finish.",
          "",
          details.join("\n\n"),
        ].join("\n"),
      ),
    );
    return true;
  };
  while (true) {
    if (!checkEnvironment()) break;
    attemptNumber += 1;
    activeProgressPath = join(
      runDir,
      attemptNumber === 1
        ? "worker-progress.jsonl"
        : `worker-progress-${String(attemptNumber).padStart(2, "0")}.jsonl`,
    );
    progressOffset = 0;
    const spawnCommand =
      process.env.AGX_WORKER_BIN === undefined
        ? [...defaultCommand, ...workerArgs().slice(1)]
        : [
            process.execPath,
            "--eval",
            "delete process.env.BUN_BE_BUN; await import(process.argv[1]);",
            "--",
            resolve(cwd, workerPath),
            ...workerArgs().slice(1),
          ];
    writeFileSync(
      join(runDir, `spawn-${String(attemptNumber).padStart(2, "0")}.json`),
      `${JSON.stringify({ attempt: attemptNumber, executable: spawnCommand[0], argv: spawnCommand })}\n`,
    );
    const child = Bun.spawn(spawnCommand, {
      cwd,
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...runEnv,
        AGX_CODEX_PROGRESS_FILE: activeProgressPath,
        ...(process.env.AGX_WORKER_BIN === undefined
          ? {}
          : { BUN_BE_BUN: "1" }),
      },
      signal: deadline,
      killSignal: "SIGTERM",
    });
    activeChild = child;
    const outputPromise =
      child.stdout === null
        ? Promise.resolve("")
        : new Response(child.stdout).text();
    exit = await child.exited;
    timedOut = deadline.aborted;
    activeChild = undefined;
    output = await outputPromise;
    if (stopTask !== undefined) await stopTask;
    receiptLine = output.trim().split("\n").at(-1) ?? "";
    const receipt = workerReceiptSchema.safeParse(receiptLine);
    workerReceipt = receipt.success ? receipt.data : {};
    if (receipt.success) {
      const attemptReceipt = {
        ...workerReceipt,
        row: activeRow.id,
        attempt: attemptNumber,
        sandbox,
        sandbox_source,
      };
      writeFileSync(
        join(runDir, `attempt-${String(attemptNumber).padStart(2, "0")}.json`),
        `${JSON.stringify(attemptReceipt)}\n`,
      );
      writeFileSync(
        join(runDir, `${id}.json`),
        `${JSON.stringify(attemptReceipt)}\n`,
      );
    }
    const session =
      workerReceipt.vendor_session ??
      workerReceipt.session ??
      workerReceipt.session_id ??
      vendorSessionFromProgress() ??
      currentResumeSession ??
      null;
    latestVendorSession = session;
    endedOnCapacity = workerReceipt.outcome === "capacity";
    if (!endedOnCapacity && (await verificationFeedback(session))) continue;
    if (!endedOnCapacity || timedOut) break;

    const remainingMs = Math.floor(
      timeoutMs - (performance.now() - runStartedAt),
    );
    if (deadline.aborted || remainingMs <= 0) {
      timedOut = true;
      exit = 124;
      break;
    }
    const next = await route(
      routing.brief,
      routing.capabilities,
      routing.timeoutS,
      [...routing.maskedRows, ...attemptedRows],
      {},
      {
        path: resolve(path),
        launch: true,
        sha256: ticket_sha256,
        min_effort: routing.min_effort,
      },
      { capacityRetry: true, timeoutMs: remainingMs },
    );
    if (deadline.aborted) {
      timedOut = true;
      exit = 124;
      break;
    }
    if (next.kind === "exhausted") {
      capacityExhausted = true;
      break;
    }
    // The worker reported vendor capacity and no further row is usable for any reason:
    // contract.md "Vendor capacity ends a run with outcome `capacity` and temporary-unavailability exit 75."
    // The refusal reason is kept on stderr and in the report so it is not lost.
    if (next.kind === "refused" && endedOnCapacity) {
      capacityExhausted = true;
      capacityRerouteRefusal = next.message.trim();
      process.stderr.write(
        `WARN capacity reroute found no row: ${capacityRerouteRefusal}\n`,
      );
      break;
    }
    if (next.kind === "refused") {
      routeFailure = next;
      exit = next.exitCode;
      break;
    }
    const previousRow = activeRow;
    const previousSession =
      latestVendorSession ?? vendorSessionFromProgress() ?? undefined;
    activeRow = next.row;
    attemptedRows.push(activeRow.id);
    if (briefIsOriginal && previousRow.route !== activeRow.route)
      writeFileSync(
        workerBrief,
        withReportInstruction(
          renderPromise(
            ticket,
            cwd,
            sandbox,
            prose,
            runDir,
            continuation,
            ackLookup,
            activeRow.route,
          ),
        ),
      );
    if (activeRow.route === "claude") claudeRouteRan = true;
    currentResumeSession =
      previousRow.route === activeRow.route ? previousSession : undefined;
    if (currentResumeSession === undefined) latestVendorSession = null;
  }
  clearInterval(progressWatcher);
  // A capacity receipt is terminal only after the active run exhausted its eligible rows.
  const capacity = capacityExhausted && endedOnCapacity;
  // contract.md: a capacity run exits with temporary-unavailability status 75.
  if (capacity) exit = 75;
  // A killed claude sandbox leaves empty read-only placeholders; remove them before measuring.
  const beforeSnapshot = before.isOk() ? before.value : undefined;
  const sandboxStubsRemoved = claudeRouteRan
    ? removeClaudeSandboxStubs(cwd, beforeSnapshot)
    : [];
  const after = workspaceSnapshot(cwd);
  const changedPathsMeasured =
    before.isOk() && after.isOk()
      ? changedPaths(before.value, after.value)
      : undefined;
  const changed = changedPathsMeasured?.length;
  const reportInput = receiptReportInput(workerReceipt, receiptLine);
  const parsedReport = parseReport(reportInput.structured, reportInput.message);
  for (const warning of parsedReport.ok ? (parsedReport.warnings ?? []) : [])
    process.stderr.write(`WARN ${warning}\n`);
  const outcome = environmentLost
    ? "environment-lost"
    : deriveOutcome({
        capacity,
        timedOut:
          timedOut ||
          workerReceipt.timed_out === true ||
          workerReceipt.outcome === "timeout" ||
          exit === 3 ||
          exit === 124,
        refused:
          exit !== 0 ||
          routeFailure !== undefined ||
          workerReceipt.outcome === "refused" ||
          (workerReceipt.exit_code !== undefined &&
            workerReceipt.exit_code !== 0),
        verify,
        reportValid: parsedReport.ok,
        changed,
      });
  let report: unknown = parsedReport.ok
    ? parsedReport.report
    : {
        raw: output.trim(),
        error: parsedReport.error,
      };
  if (capacity)
    report = {
      summary: `Vendor capacity on ${attemptedRows.join(" → ")}: ${workerReceipt.cause ?? "model unavailable"}`,
      changes: [],
      checks: [],
      for_coordinator: [
        capacityRerouteRefusal === undefined
          ? "Every eligible roster row answered capacity."
          : `No further roster row was usable after capacity: ${capacityRerouteRefusal}`,
      ],
      open: [
        "The vendor did not complete this ticket; this is not a worker failure.",
      ],
    };
  else if (routeFailure !== undefined)
    report = {
      summary: `Capacity on ${attemptedRows.join(" → ")}; rerouting stopped: ${routeFailure.message.trim()}`,
      changes: [],
      checks: [],
      for_coordinator: [],
      open: ["The vendor did not complete this ticket."],
    };
  else if (timedOut && endedOnCapacity)
    report = {
      summary: `Ticket time box expired after capacity on ${attemptedRows.join(" → ")}.`,
      changes: [],
      checks: [],
      for_coordinator: [],
      open: ["The vendor did not complete this ticket."],
    };
  else if (!parsedReport.ok && parsedReport.error === EMPTY_FINAL_MESSAGE) {
    const progressLine = lastLine(activeProgressPath);
    const progress =
      progressLine === undefined
        ? undefined
        : jsonOf(z.looseObject({})).safeParse(progressLine);
    const interimLine = lastLine(interimPath);
    const interim =
      interimLine === undefined
        ? undefined
        : jsonOf(z.looseObject({ last_message: z.string() })).safeParse(
            interimLine,
          );
    report = {
      ...managerReport(
        {
          outcome,
          timedOut:
            timedOut ||
            workerReceipt.timed_out === true ||
            workerReceipt.outcome === "timeout",
          exit,
          changedPaths: changedPathsMeasured,
          progress: progress?.success === true ? progress.data : undefined,
          interim:
            interim?.success === true ? interim.data.last_message : undefined,
          verify,
        },
        parsedReport.error,
      ),
      raw: output.trim(),
      error: parsedReport.error,
    };
  }
  if (ctx.verifyAlways.length > 0)
    report = {
      ...(typeof report === "object" && report !== null ? report : {}),
      verify,
    };
  report = {
    ...(typeof report === "object" && report !== null ? report : {}),
    ...(attemptedRows.length > 1 ? { rows: attemptedRows } : {}),
    verify_rounds: verifyRounds,
    ...(environmentLost ? { environment_lost: temp.dir } : {}),
    execution,
    sandbox,
    sandbox_source,
    ...(sandboxStubsRemoved.length === 0
      ? {}
      : { sandbox_stubs_removed: sandboxStubsRemoved }),
    ...(changedPathsMeasured === undefined
      ? {}
      : {
          workspace_changes: {
            changed_files: changedPathsMeasured.length,
            changed_paths: changedPathsMeasured,
          },
        }),
  };
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  const vendorSession = latestVendorSession;
  if (existsSync(interimPath)) {
    const finalInterim = readFileSync(interimPath, "utf8")
      .trim()
      .split("\n")
      .at(-1);
    const interim =
      finalInterim === undefined
        ? undefined
        : jsonOf(z.looseObject({ last_message: z.string() })).safeParse(
            finalInterim,
          );
    if (interim?.success === true)
      progressSeen ||= persistInterim(
        id,
        progressPath,
        interim.data.last_message,
      );
  }
  if (stopTask !== undefined) await stopTask;
  ended = true;
  const endedAt = now();
  const verifyRound =
    verifyRoundNumber === 0
      ? undefined
      : verifyRoundOf(verifyRoundNumber, verifyRounds);
  const runDirSize = measureRunDir(runDir);
  const endNotice = scheduleEndNotice({
    runDirSize,
    id,
    ticket: ticketName,
    dispatcher: dispatcherIdentity,
    startedAt,
    endedAt,
    outcome,
    exit,
    resultPath: reportPath,
    verifyExits: verify.map((result) => result.exit),
    ...(verifyRound === undefined ? {} : { verifyRound }),
    env: runEnv,
    detachUnit: process.env.INVOCATION_ID !== undefined,
  });
  append(
    {
      kind: "ended",
      id,
      run_dir_bytes: runDirSize.bytes,
      at: endedAt,
      exit,
      outcome,
      ...(environmentLost
        ? { cause: `run temp directory missing: ${temp.dir}` }
        : {}),
      end_notice: endNotice,
      report_path: reportPath,
      vendor_session: vendorSession,
      ...(workerReceipt.credential === undefined
        ? {}
        : { credential: workerReceipt.credential }),
      ...(workerReceipt.credential_source === undefined
        ? {}
        : { credential_source: workerReceipt.credential_source }),
      ...(attemptedRows.length > 1 ? { rows: attemptedRows } : {}),
      ...(attemptedRows.length > 1
        ? {
            final_row: {
              id: activeRow.id,
              route: activeRow.route,
              model: activeRow.model,
              effort: activeRow.effort,
            },
          }
        : {}),
      verify,
      ...(verifyRound === undefined ? {} : { verify_round: verifyRound }),
      returned: /```agx-return\s*\n/u.test(reportInput.message),
      changed_files: changed,
    },
    stateDir(),
    false,
  );
  // The ended record is durable; no publication is scheduled or awaited for it. A publication
  // replays the whole log under the current-runs lock other writers and judges may hold, and this
  // process held its workspace lock and unit open for all of it. The next writer or reader
  // publishes; workspace readers rescan a stale publication themselves.
  cleanupTemp();
  await workspaceLock.release();
  process.stdout.write(
    `${JSON.stringify({ id, ticket: ticketName, workspace, row: activeRow.id, ...(pinned === null || pinned === undefined ? {} : { continued_from_row: pinned.previousRow }), route: activeRow.route, model: activeRow.model, effort: activeRow.effort, ...(workerReceipt.credential === undefined ? {} : { credential: workerReceipt.credential }), ...(attemptedRows.length > 1 ? { rows: attemptedRows } : {}), sandbox, sandbox_source, sandbox_effective, sandbox_effective_source, exit, outcome, report_path: reportPath, state_file: recordPath(), host: hostname(), unit, execution })}\n`,
  );
  return exit;
}

export { list } from "./list-command.ts";
export { runningSummary } from "./listing.ts";

/** How long judge waits for the publication lock before it fails naming the holder. */
const PUBLICATION_LOCK_WAIT_MS = 30_000;

async function reclaimAfterJudge(root: string): Promise<void> {
  const configured = process.env.XDG_CONFIG_HOME;
  const config =
    configured === undefined || configured === ""
      ? join(process.env.HOME ?? homedir(), ".config")
      : configured;
  const directory = join(config, "agx", "run-pins.d");
  const listing = fromThrowable(() => readdirSync(directory))();
  if (listing.isErr()) {
    const parsed = z.object({ code: z.string() }).safeParse(listing.error);
    if (!parsed.success || parsed.data.code !== "ENOENT")
      process.stderr.write(
        `stopped at automatic reclaim: ${String(listing.error)}\n`,
      );
    return;
  }
  await Promise.try(async () => {
    const files = listing.value
      .filter((name) => name.endsWith(".txt"))
      .toSorted()
      .map((name) => join(directory, name));
    const args =
      files.length === 0
        ? ["--no-pins"]
        : files.flatMap((file) => ["--pin", file]);
    const child = Bun.spawn(
      [
        ...stableSelfCommand(),
        "reclaim-runs",
        "--older-than",
        "14",
        "--apply",
        ...args,
      ],
      {
        env: {
          ...process.env,
          AGX_STATE_DIR: root,
          AGX_RECLAIM_AUTOMATIC: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
        detached: true,
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      fromThrowable(() => process.kill(-child.pid, "SIGKILL"))().mapErr(() => {
        child.kill("SIGKILL");
      });
    }, 3000);
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    if (stderr !== "") process.stderr.write(stderr);
    if (timedOut)
      process.stderr.write(
        "stopped at automatic reclaim: time limit exceeded\n",
      );
    else if (exit !== 0 && !stderr.includes("stopped at"))
      process.stderr.write("stopped at automatic reclaim: sweep failed\n");
  }).catch((error: unknown) => {
    process.stderr.write(`stopped at automatic reclaim: ${String(error)}\n`);
  });
}

/** Judge's lock failure names the lock (the publication lock, `current-runs.json`) and its holder. */
const publicationLockFailure = (root: string, reason: string): string =>
  `cannot publish current runs: publication lock ${join(root, "current-runs.json")} (the lock every run, judge and publication takes to rewrite the snapshot): ${reason}; nothing was recorded, retry`;

type JudgeRunRuntime = {
  root?: string;
  lockWaitMs?: number;
  lockWaitClock?: WorkspaceLockWaitClock;
  writeStdout?: (line: string) => void;
  onLockFailure?: (message: string, exitCode: number) => number;
};

const JudgeBatchLine = jsonOf(
  z
    .object({
      run: z.string().min(1),
      decision: z.enum(["accept", "reject"]),
      note: z.string().optional(),
      override: z.string().optional(),
    })
    .strict(),
);

export async function judgeBatch(
  path: string,
  runtime: {
    root?: string;
    lockWaitMs?: number;
    load?: typeof recordedRuns;
    lock?: typeof acquireWorkspaceLockUntilAvailable;
    publish?: typeof publishCurrentRuns;
    writeStdout?: (line: string) => void;
  } = {},
): Promise<number> {
  const content = await readFile(path, "utf8").catch(() =>
    fatal(`cannot read judgment batch: ${path}`, 2),
  );
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const errors: string[] = [];
  const parsed = lines.flatMap((line, index) => {
    const result = JudgeBatchLine.safeParse(line);
    if (!result.success) {
      errors.push(`line ${index + 1}: invalid judgment JSON or fields`);
      return [];
    }
    return [{ ...result.data, line: index + 1 }];
  });
  const root = runtime.root ?? stateDir();
  const runs = await (runtime.load ?? recordedRuns)(root);
  const pending: {
    id: string;
    decision: "accept" | "reject";
    note: string;
    overrideReason?: string;
    status: "applied" | "unchanged";
  }[] = [];
  const latest = new Map(runs.map((row) => [row.id, row.judgment]));
  for (const entry of parsed) {
    const resolution = resolveRunId(runs, entry.run);
    if (resolution.kind === "error") {
      errors.push(`line ${entry.line}: ${resolution.error}`);
      continue;
    }
    const overrideReason = entry.override?.trim();
    const completion = completionFor(resolution.row);
    let error: string | undefined;
    if (entry.override !== undefined && overrideReason === "")
      error = "judge override reason must not be empty";
    else if (entry.decision === "accept" && completion.completion === null)
      error = `cannot accept run '${resolution.row.id}' before it ends`;
    else if (
      entry.decision === "accept" &&
      completion.completion === "incomplete" &&
      overrideReason === undefined
    )
      error = `cannot accept incomplete run '${resolution.row.id}'; pass override to record an explicit override`;
    if (error !== undefined) {
      errors.push(`line ${entry.line}: ${error}`);
      continue;
    }
    const note = entry.note ?? "";
    const previous = latest.get(resolution.row.id);
    const status =
      previous?.decision === entry.decision && previous.note === note
        ? "unchanged"
        : "applied";
    if (
      pending.some(
        (item) =>
          item.id === resolution.row.id &&
          (item.decision !== entry.decision || item.note !== note),
      )
    ) {
      errors.push(
        `line ${entry.line}: conflicting judgments for run '${resolution.row.id}'`,
      );
      continue;
    }
    pending.push({
      id: resolution.row.id,
      decision: entry.decision,
      note,
      ...(overrideReason === undefined ? {} : { overrideReason }),
      status,
    });
    latest.set(resolution.row.id, { decision: entry.decision, note, at: "" });
  }
  if (errors.length > 0) return fatal(errors.join("\n"), 2);
  const lock = await (runtime.lock ?? acquireWorkspaceLockUntilAvailable)(
    join(root, "current-runs.json"),
    root,
    runtime.lockWaitMs ?? PUBLICATION_LOCK_WAIT_MS,
  );
  if (!lock.ok) return fatal(publicationLockFailure(root, lock.error), 2);
  await (async () => {
    await using resource = { [Symbol.asyncDispose]: () => lock.release() };
    void resource;
    for (const entry of pending)
      if (entry.status === "applied")
        append(
          {
            kind: "judged",
            id: entry.id,
            at: now(),
            decision: entry.decision,
            note: entry.note,
            ...(entry.overrideReason === undefined
              ? {}
              : { override_reason: entry.overrideReason }),
          },
          root,
          false,
        );
    await (runtime.publish ?? publishCurrentRuns)(root, lock);
  })();
  if (runtime.publish === undefined) await publishWorkspacePublications(root);
  for (const [index, entry] of pending.entries())
    (runtime.writeStdout ?? ((line) => process.stdout.write(line)))(
      `${JSON.stringify({ line: index + 1, id: entry.id, status: entry.status })}\n`,
    );
  await reclaimAfterJudge(root);
  return 0;
}

/** A judged record carries at most this much of each evidence file inline. */
export const JUDGED_EVIDENCE_INLINE_CHARS = 8192;

export async function judgeRun(
  flags: {
    id?: string | undefined;
    decision?: string | undefined;
    note?: string | undefined;
    override?: string | undefined;
    evidence?: string[] | undefined;
  },
  runtime: JudgeRunRuntime = {},
): Promise<number> {
  const id = flags.id;
  const decision = flags.decision;
  if (id === undefined || decision === undefined)
    return fatal("judge requires RUN_ID and accept|reject", 2);
  if (decision !== "accept" && decision !== "reject")
    return fatal("judge decision must be accept or reject", 2);
  const root = runtime.root ?? stateDir();
  const resolution = resolveRunId(await recordedRuns(root), id);
  if (resolution.kind === "error") return fatal(resolution.error, 2);
  const overrideReason = flags.override?.trim();
  if (flags.override !== undefined && overrideReason === "")
    return fatal("judge override reason must not be empty", 2);
  const completion = completionFor(resolution.row);
  if (decision === "accept" && completion.completion === null)
    return fatal(
      `cannot accept run '${resolution.row.id}' before it ends; completion class is not available`,
      2,
    );
  if (
    decision === "accept" &&
    completion.completion === "incomplete" &&
    overrideReason === undefined
  )
    return fatal(
      `cannot accept incomplete run '${resolution.row.id}'; completion=${completion.completion}; facts=${JSON.stringify(completion.facts)}; pass --override '<reason>' to record an explicit override`,
      2,
    );
  const evidence = [];
  for (const path of flags.evidence ?? []) {
    const bytes = await readFile(path).catch(() =>
      fatal(`cannot read evidence: ${path}`, 2),
    );
    const decoded = await Promise.try(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ).catch(() => fatal(`evidence must be UTF-8: ${path}`, 2));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (decoded.length <= JUDGED_EVIDENCE_INLINE_CHARS) {
      evidence.push({ path, sha256, content: decoded });
      continue;
    }
    // The record keeps a bounded prefix; the full text lives in a file the record names.
    const contentPath = join(
      root,
      "runs",
      resolution.row.id,
      `judged-evidence-${sha256}.txt`,
    );
    mkdirSync(dirname(contentPath), { recursive: true });
    writeFileSync(contentPath, bytes);
    evidence.push({
      path,
      sha256,
      content: decoded.slice(0, JUDGED_EVIDENCE_INLINE_CHARS),
      content_path: contentPath,
      content_truncated: true,
    });
  }
  const at = now();
  const judgment = {
    kind: "judged" as const,
    id: resolution.row.id,
    at,
    decision,
    note: flags.note ?? "",
    ...(overrideReason === undefined
      ? {}
      : { override_reason: overrideReason }),
    ...(evidence.length === 0 ? {} : { evidence }),
  };
  const lock = await acquireWorkspaceLockUntilAvailable(
    join(root, "current-runs.json"),
    root,
    runtime.lockWaitMs ?? PUBLICATION_LOCK_WAIT_MS,
    runtime.lockWaitClock,
  );
  if (!lock.ok) {
    const message = publicationLockFailure(root, lock.error);
    if (runtime.onLockFailure !== undefined)
      return runtime.onLockFailure(message, 2);
    return fatal(message);
  }
  await (async () => {
    await using lockResource = {
      [Symbol.asyncDispose]: () => lock.release(),
    };
    void lockResource;
    // Persist by run id even if the end record is still arriving from its owner.
    // foldInto keeps this judgment when the later `ended` event is replayed.
    append(judgment, root, false);
    await publishCurrentRuns(root, lock);
  })();
  const writeStdout =
    runtime.writeStdout ?? ((line: string) => process.stdout.write(line));
  writeStdout(
    `${JSON.stringify({ id: judgment.id, verdict: judgment.decision, ...(judgment.note === "" ? {} : { note: judgment.note }), ...(judgment.override_reason === undefined ? {} : { override_reason: judgment.override_reason }), at: judgment.at })}\n`,
  );
  await publishWorkspacePublications(root);
  await reclaimAfterJudge(root);
  return 0;
}

export async function stats(_flags: Flags): Promise<number> {
  const legacyLand = await legacyLandStatus();
  if (legacyLand.status === "refused") {
    process.stdout.write(`${JSON.stringify({ legacy_land: legacyLand })}\n`);
    return 2;
  }
  const all = events();
  const runs = await foldedRuns();
  const report = {
    legacy_land: legacyLand,
    runs: runs.length,
    running: runs.filter((entry) => entry.state === "running").length,
    ended: runs.filter((entry) => entry.state === "ended").length,
    lost: runs.filter((entry) => entry.outcome === "lost").length,
    by_outcome: Object.fromEntries(
      Outcome.options.map((outcome) => [
        outcome,
        runs.filter((entry) => entry.outcome === outcome).length,
      ]),
    ),
    judgments: all.filter((event) => event.kind === "judged").length,
    by_row: Object.fromEntries(
      [...new Set(runs.map((entry) => entry.row))].map((row) => [
        row,
        runs.filter((entry) => entry.row === row).length,
      ]),
    ),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}
