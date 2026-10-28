import { newRoutingAudit, recordRoutingPick } from "./routing-events.ts";
import { fromThrowable } from "neverthrow";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { InspectionUnavailable } from "../../../shared/src/agx-config.ts";
import { selfCommand } from "../self-command.ts";
import { legacyLandStatus } from "../state.ts";
import { verifyLine } from "../ticket.ts";
import { parseReport, parseReturn, withReportInstruction } from "../report.ts";
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
  importLegacyRecords,
  now,
  overlapWarnings,
  publishCurrentRuns,
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
import { createRunTemp } from "../temp.ts";
import { exitWithError } from "./exit.ts";
import {
  Outcome,
  changedPaths,
  deriveOutcome,
  workspaceSnapshot,
} from "./outcome.ts";
import {
  verificationEnvironment,
  verifyKind,
  type VerifyKind,
} from "./verify.ts";
import { scheduleEndNotice } from "./end-notice.ts";

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
const dispatcherAddressFor = (
  session: string | null,
  env: NodeJS.ProcessEnv,
): string | null => {
  if (session === null || session.trim() === "") return null;
  if (/^(codex|claude):.+$/u.test(session)) return session;
  const declaredVendor =
    env.AGX_DISPATCHER_VENDOR === "codex" ||
    env.AGX_DISPATCHER_VENDOR === "claude"
      ? env.AGX_DISPATCHER_VENDOR
      : undefined;
  const matchingVendors = [
    ...(env.CLAUDE_CODE_SESSION_ID === session ? ["claude"] : []),
    ...(env.CODEX_SESSION_ID === session ? ["codex"] : []),
  ];
  const vendor =
    declaredVendor ??
    (matchingVendors.length === 1 ? matchingVendors[0] : undefined);
  return vendor === undefined ? null : `${vendor}:${session}`;
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
const renderPromise = (
  ticket: NextTicket,
  cwd: string,
  sandbox: string,
  prose: string,
  runDir: string,
  continuation?: {
    judgment: Readonly<{ decision: string; note: string }> | null;
    ticketDiff: string;
  },
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
      `AGX_RUN_DIR=${runDir}. Write worker results, logs and measurements there; keep only source changes in the workspace.`,
      "Promise:",
      `outcome: ${ticket.outcome}`,
      `writes: ${JSON.stringify(ticket.writes.map((glob) => resolve(cwd, glob)))}`,
      ...(ticket.verify.length === 0 ? [] : [verifyLine(ticket.verify)]),
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
      "For agx msg sender attribution, --from overrides AGX_MSG_FROM. agx-worker declares AGX_MSG_FROM only when it knows this vendor process's full session UUID before spawn. Without either declaration, agx msg resolves this AGX_RUN_ID from its recorded vendor session and route; missing run sessions fall through to the proven caller identity or unknown. As a narrow exception to the inherited-session rule, agx msg accepts CODEX_THREAD_ID only from the nearest vendor process's own environment when that process is Codex; a nearer Claude process or unreadable/missing Codex ID does not prove a Codex sender. Never guess from unproven inherited native session variables, dispatcher identity, inventory, cwd or the latest session. If no source proves the caller, leave sender unknown with the checked and missing sources in the relay line. The envelope's from: line is the declared reply address; Claude's visible from-name identifies the relay transport.",
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

const runVerify = async (
  commands: string[],
  cwd: string,
  runDir: string,
  env: NodeJS.ProcessEnv,
  always: string[],
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
    const source = index < always.length ? "[verify].always" : undefined;
    const logPath = join(
      runDir,
      `verify-${String(index + 1).padStart(2, "0")}.log`,
    );
    const child = Bun.spawn(
      ["sh", "-c", 'exec 2>&1; sh -c "$1"', "agx-verify", cmd],
      {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env,
      },
    );
    // Merge stderr into stdout before running the command so one pipe preserves
    // the order in which the verification command writes both streams.
    const output =
      child.stdout === null
        ? Promise.resolve("")
        : new Response(child.stdout).text();
    const exit = await child.exited;
    writeFileSync(logPath, await output);
    const kind = verifyKind(exit, child.signalCode);
    process.stderr.write(
      `VERIFY exit=${exit} ${cmd} kind=${kind}${source === undefined ? "" : ` source=${source}`}\n`,
    );
    results.push({
      cmd,
      exit,
      log_path: logPath,
      kind,
      ...(source === undefined ? {} : { source }),
    });
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
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, violations: [] })}\n`);
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

export async function run(flags: Flags): Promise<number> {
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
  } = inspected;
  if (ticket === undefined || bytes === null || ctx === undefined)
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
  if (selectedRoute.kind === "refused")
    return fatal(selectedRoute.message, selectedRoute.exitCode);
  const row = selectedRoute.row;
  let activeRow = row;
  const attemptedRows = [row.id];
  const id = binding?.id ?? randomUUID();
  // The run owns its temp space: removed on any exit path (process.exit included); a SIGKILL
  // leaves it for the next run's sweep.
  const made = createRunTemp(id);
  if (made.isErr()) {
    console.error(made.error);
    process.exit(1);
  }
  const temp = made.value;
  Object.assign(process.env, temp.env);
  process.on("exit", temp.remove);
  const runDir = resolve(stateDir(), "runs", id);
  let activeProgressPath = join(runDir, "worker-progress.jsonl");
  let started = false;
  let ended = false;
  let dispatcherAddress: string | null = null;
  let stopTask: Promise<never> | undefined;
  let killWorker: (() => void) | undefined;
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
    if (started && !ended) {
      ended = true;
      const endedAt = now();
      stopTask = (async () => {
        const endNotice = scheduleEndNotice({
          id,
          ticket: ticketName,
          dispatcher,
          address: dispatcherAddress,
          startedAt,
          endedAt,
          outcome: "stopped",
          resultPath: null,
          verifyExits: [],
        });
        append({
          kind: "ended",
          id,
          at: endedAt,
          exit: code,
          outcome: "stopped",
          end_notice: endNotice,
          signal,
          stopped_by: request?.stopped_by ?? `signal:${signal}`,
          report_path: null,
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
          verify: [],
        });
        await flushRunPublications();
        process.exit(code);
      })();
      return;
    }
    if (started && ended) return;
    stopTask = (async () => {
      await flushRunPublications();
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
  const codexSession = process.env.CODEX_SESSION_ID;
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
  dispatcherAddress = dispatcherAddressFor(dispatcher, process.env);
  if (dispatcher === null)
    process.stderr.write(
      "WARN dispatcher session is unavailable; pass --session ID or preserve CLAUDE_CODE_SESSION_ID/CODEX_SESSION_ID (systemd-run: use -E NAME).\n",
    );
  const workspace = resolve(pinned?.workspace ?? cwd);
  writeFileSync(
    workerBrief,
    withReportInstruction(
      renderPromise(ticket, cwd, sandbox, prose, runDir, continuation),
    ),
  );
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
    dispatcher_address: dispatcherAddress,
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

  const ownCommand = selfCommand();
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
        ? JSON.stringify({
            permissions: { additionalDirectories: [runDir] },
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              allowUnsandboxedCommands: false,
              failIfUnavailable: true,
              filesystem: { allowWrite: [runDir] },
            },
          })
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
      ...(sandbox === "workspace-write" ? ["--allowed-tools", "Bash"] : []),
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
  const baseEnv = verificationEnvironment(cwd, process.env, temp.env);
  if (baseEnv instanceof InspectionUnavailable)
    return fatal(baseEnv.message, 75);
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
      ? selfCommand()
      : [workerCommand ?? workerPath];
  const execution = {
    executable_path: ownExecutable,
    executable_argv: ownCommand,
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
      vendor_session: z.string().optional(),
      session: z.string().optional(),
      session_id: z.string().optional(),
      outcome: z.string().optional(),
      cause: z.string().optional(),
      timed_out: z.boolean().optional(),
      exit_code: z.number().optional(),
    }),
  );
  let workerReceipt: z.output<typeof workerReceiptSchema> = {};
  let receiptLine = "";
  let output = "";
  let exit = 0;
  let timedOut = false;
  let capacityExhausted = false;
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
  let attemptNumber = 0;
  while (true) {
    attemptNumber += 1;
    activeProgressPath = join(
      runDir,
      attemptNumber === 1
        ? "worker-progress.jsonl"
        : `worker-progress-${String(attemptNumber).padStart(2, "0")}.jsonl`,
    );
    progressOffset = 0;
    const child = Bun.spawn(
      process.env.AGX_WORKER_BIN === undefined
        ? [...defaultCommand, ...workerArgs().slice(1)]
        : [
            process.execPath,
            "--eval",
            "delete process.env.BUN_BE_BUN; await import(process.argv[1]);",
            "--",
            resolve(cwd, workerPath),
            ...workerArgs().slice(1),
          ],
      {
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
      },
    );
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
      { path: resolve(path), launch: true, sha256: ticket_sha256 },
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
    currentResumeSession =
      previousRow.route === activeRow.route ? previousSession : undefined;
    if (currentResumeSession === undefined) latestVendorSession = null;
  }
  clearInterval(progressWatcher);
  // A capacity receipt is terminal only after the active run exhausted its eligible rows.
  const capacity = capacityExhausted && endedOnCapacity;
  const skipVerification = endedOnCapacity;
  const verify = skipVerification
    ? []
    : await runVerify(ticket.verify, cwd, runDir, runEnv, ctx.verifyAlways);
  const after = workspaceSnapshot(cwd);
  const changedPathsMeasured =
    before.isOk() && after.isOk()
      ? changedPaths(before.value, after.value)
      : undefined;
  const changed = changedPathsMeasured?.length;
  const parsedReport = parseReport(
    workerReceipt.structured_output ?? workerReceipt.report,
    workerReceipt.last_message ?? receiptLine,
  );
  for (const warning of parsedReport.ok ? (parsedReport.warnings ?? []) : [])
    process.stderr.write(`WARN ${warning}\n`);
  const outcome = deriveOutcome({
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
      (workerReceipt.exit_code !== undefined && workerReceipt.exit_code !== 0),
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
      for_coordinator: ["Every eligible roster row answered capacity."],
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
  if (ctx.verifyAlways.length > 0)
    report = {
      ...(typeof report === "object" && report !== null ? report : {}),
      verify,
    };
  report = {
    ...(typeof report === "object" && report !== null ? report : {}),
    ...(attemptedRows.length > 1 ? { rows: attemptedRows } : {}),
    execution,
    sandbox,
    sandbox_source,
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
  const endNotice = scheduleEndNotice({
    id,
    ticket: ticketName,
    dispatcher,
    address: dispatcherAddress,
    startedAt,
    endedAt,
    outcome,
    resultPath: reportPath,
    verifyExits: verify.map((result) => result.exit),
    env: runEnv,
  });
  append({
    kind: "ended",
    id,
    at: endedAt,
    exit,
    outcome,
    end_notice: endNotice,
    report_path: reportPath,
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
    verify,
    returned: /```agx-return\s*\n/u.test(
      workerReceipt.last_message ?? receiptLine,
    ),
    changed_files: changed,
  });
  await flushRunPublications();
  temp.remove();
  await workspaceLock.release();
  process.stdout.write(
    `${JSON.stringify({ id, ticket: ticketName, workspace, row: activeRow.id, ...(pinned == null ? {} : { continued_from_row: pinned.previousRow }), route: activeRow.route, model: activeRow.model, effort: activeRow.effort, ...(attemptedRows.length > 1 ? { rows: attemptedRows } : {}), sandbox, sandbox_source, sandbox_effective, sandbox_effective_source, exit, outcome, report_path: reportPath, state_file: recordPath(), host: hostname(), unit, execution })}\n`,
  );
  return exit;
}

export { list } from "./list-command.ts";
export { runningSummary } from "./listing.ts";

type JudgeRunRuntime = {
  root?: string;
  lockWaitClock?: WorkspaceLockWaitClock;
  writeStdout?: (line: string) => void;
  onLockFailure?: (message: string, exitCode: number) => number;
};

export async function judgeRun(
  flags: {
    id?: string | undefined;
    decision?: string | undefined;
    note?: string | undefined;
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
  const resolution = resolveRunId(await foldedRuns(root), id);
  if (resolution.kind === "error") return fatal(resolution.error, 2);
  const evidence = [];
  for (const path of flags.evidence ?? []) {
    const bytes = await readFile(path).catch(() =>
      fatal(`cannot read evidence: ${path}`, 2),
    );
    const decoded = await Promise.try(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ).catch(() => fatal(`evidence must be UTF-8: ${path}`, 2));
    evidence.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: decoded,
    });
  }
  const at = now();
  const judgment = {
    kind: "judged",
    id: resolution.row.id,
    at,
    decision,
    note: flags.note ?? "",
    ...(evidence.length === 0 ? {} : { evidence }),
  } as const;
  const lock = await acquireWorkspaceLockUntilAvailable(
    join(root, "current-runs.json"),
    root,
    30_000,
    runtime.lockWaitClock,
  );
  if (!lock.ok) {
    const message = `cannot publish current runs: ${lock.error}`;
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
    `${JSON.stringify({ id: judgment.id, verdict: judgment.decision, ...(judgment.note === "" ? {} : { note: judgment.note }), at: judgment.at })}\n`,
  );
  return 0;
}

export async function stats(flags: Flags): Promise<number> {
  const legacyLand = await legacyLandStatus();
  if (legacyLand.status === "refused") {
    process.stdout.write(`${JSON.stringify({ legacy_land: legacyLand })}\n`);
    return 2;
  }
  const importFlag =
    flags.importLegacy === true || value(flags, "import-legacy") === "true";
  const legacyImport = importFlag ? await importLegacyRecords() : undefined;
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
    ...(legacyImport === undefined ? {} : { legacy_import: legacyImport }),
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
