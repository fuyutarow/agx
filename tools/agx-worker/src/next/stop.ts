import { listingProgress } from "./listing-progress.ts";
import { userInfo } from "node:os";
import { fromThrowable } from "neverthrow";
import { leaseFor } from "./lease.ts";
import type { ListedRun } from "./run-state.ts";
import { resolveRunId } from "./run-id.ts";
import {
  acquireWorkspaceLock,
  append,
  events,
  foldedRuns,
  now,
} from "./store.ts";

const refuse = (message: string, exit = 2) => {
  process.stderr.write(`agx worker stop: ${message}\n`);
  return exit;
};

/** Only a recorded live lease authorizes an effect on a process or unit. */
export async function stopRun(selector: string): Promise<number> {
  const resolved = resolveRunId(await foldedRuns(), selector);
  if (resolved.kind === "error") return refuse(resolved.error);
  const run = (await listingProgress([resolved.row]))[0];
  if (run === undefined) return refuse(`unknown run '${resolved.row.id}'`);
  const lock = await acquireWorkspaceLock(`agx-stop:${run.id}`);
  if (!lock.ok) return refuse(`stop already in progress for ${run.id}`);
  await using _cleanup = { [Symbol.asyncDispose]: lock.release };
  return await stopOwnedRun(run);
}

async function stopOwnedRun(run: ListedRun): Promise<number> {
  const recordedEnd = events().findLast(
    (event) => event.id === run.id && event.kind === "ended",
  );
  if (recordedEnd?.kind === "ended")
    return reportAlreadyEnded(run.id, recordedEnd.outcome, recordedEnd.at);
  if (run.state !== "running") {
    if (run.ended_at !== null)
      return reportAlreadyEnded(run.id, run.outcome, run.ended_at);
    return refuse(
      `run ${run.id} has inferred outcome ${run.outcome} without a recorded end time; no signal sent`,
      1,
    );
  }
  const lease = run.lease;
  if (lease === undefined || lease.pid <= 1 || lease.start === null)
    return refuse(
      `run ${run.id} has no verifiable process lease; no signal sent`,
    );
  const current = await leaseFor(lease.pid, lease.unit);
  if (current.start !== lease.start)
    return refuse(`run ${run.id} owner is gone or replaced; no signal sent`);
  const systemctl = Bun.which("systemctl");
  if (lease.unit !== null) {
    if (systemctl === null)
      return refuse("systemctl unavailable; no signal sent");
    const probe = Bun.spawn(
      [
        systemctl,
        "--user",
        "show",
        lease.unit,
        "--property=MainPID",
        "--value",
      ],
      {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 2000,
      },
    );
    const [exit, pid] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
    ]);
    // agx's launcher may be MainPID while the leased worker is its child.
    // Unit membership, together with the verified process start, proves ownership.
    let member = exit === 0 && pid.trim() === String(lease.pid);
    if (!member && exit === 0 && process.platform === "linux") {
      const group = Bun.spawn(
        [
          systemctl,
          "--user",
          "show",
          lease.unit,
          "--property=ControlGroup",
          "--value",
        ],
        { stdout: "pipe", stderr: "ignore", timeout: 2000 },
      );
      const [groupExit, groupText, cgroup] = await Promise.all([
        group.exited,
        new Response(group.stdout).text(),
        Bun.file(`/proc/${lease.pid}/cgroup`)
          .text()
          .catch(() => ""),
      ]);
      const path = groupText.trim();
      member =
        groupExit === 0 &&
        path.startsWith("/") &&
        path !== "/" &&
        cgroup.split("\n").some((line) => {
          const [hierarchy, controllers, ...parts] = line.split(":");
          const owned = parts.join(":");
          return (
            (hierarchy === "0" ||
              controllers?.split(",").includes("name=systemd") === true) &&
            (owned === path || owned.startsWith(`${path}/`))
          );
        });
    }
    if (!member)
      return refuse(
        `unit ${lease.unit} no longer owns run ${run.id}; no signal sent`,
      );
  }
  const actor =
    process.env.AGX_DISPATCHER_SESSION ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CODEX_SESSION_ID ??
    `${userInfo().username}:pid:${process.pid}`;
  append({
    kind: "stop-requested",
    id: run.id,
    at: now(),
    stopped_by: actor,
    vendor_session: run.vendor_session,
  });
  process.stderr.write(`agx worker stop: stopping ${run.id}\n`);
  let systemctlFailure: string | undefined;
  if (lease.unit !== null && systemctl !== null) {
    const result = await stopSystemdUnit(
      run,
      actor,
      lease,
      lease.unit,
      systemctl,
    );
    systemctlFailure = result.failure;
    if (result.terminal !== undefined) return result.terminal;
  } else {
    // Revalidate immediately before the signal; never fall back to an unverified PID.
    if ((await leaseFor(lease.pid, null)).start !== lease.start)
      return refuse(`run ${run.id} owner changed; no signal sent`);
    const sent = fromThrowable(() => process.kill(lease.pid, "SIGTERM"))();
    if (sent.isErr())
      return refuse(`cannot signal run ${run.id}: ${String(sent.error)}`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const currentEnd = events().findLast(
      (event) => event.id === run.id && event.kind === "ended",
    );
    if (currentEnd?.kind === "ended")
      return reportEndState(run, actor, currentEnd);
    const observed = await leaseFor(lease.pid, lease.unit);
    if (observed.start === lease.start) {
      await Bun.sleep(50);
      continue;
    }
    return reportEndState(run, actor, recordStopped(run, actor));
  }
  const finalEnd = events().findLast(
    (event) => event.id === run.id && event.kind === "ended",
  );
  if (finalEnd?.kind === "ended") return reportEndState(run, actor, finalEnd);
  if (systemctlFailure !== undefined)
    return refuse(
      `cannot stop ${lease.unit}: ${systemctlFailure}; inspect with agx worker ls ${run.id}`,
      1,
    );
  return refuse(
    `run ${run.id} did not stop within 5s; inspect with agx worker ls ${run.id}`,
  );
}

async function stopSystemdUnit(
  run: ListedRun,
  actor: string,
  lease: NonNullable<ListedRun["lease"]>,
  unit: string,
  systemctl: string,
): Promise<{ failure: string | undefined; terminal: number | undefined }> {
  const child = Bun.spawn([systemctl, "--user", "stop", unit], {
    stdout: "ignore",
    stderr: "pipe",
    timeout: 10000,
  });
  const [exit, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exit === 0) return { failure: undefined, terminal: undefined };
  const stderr = error.trim();
  const failure =
    stderr !== "" ? stderr : `systemctl exited with status ${exit}`;
  const ended = events().findLast(
    (event) => event.id === run.id && event.kind === "ended",
  );
  if (ended?.kind === "ended")
    return { failure, terminal: reportEndState(run, actor, ended) };
  const current = await leaseFor(lease.pid, lease.unit);
  if (current.start !== lease.start) return { failure, terminal: undefined };
  return {
    failure,
    terminal: refuse(
      `cannot stop ${unit}: ${failure}; inspect with agx worker ls ${run.id}`,
      1,
    ),
  };
}

function reportAlreadyEnded(
  runId: string,
  outcome: string | null | undefined,
  endedAt: string | null | undefined,
): number {
  process.stderr.write(
    `run ${runId} already ended (outcome=${outcome ?? "unknown"}, ended_at=${endedAt ?? "unknown"}); nothing to stop\n`,
  );
  return 0;
}

function reportStopped(
  runId: string,
  actor: string,
  session: string | null,
): number {
  process.stdout.write(
    session === null
      ? `stopped ${runId} by ${actor}; not continuable because no vendor session had started\n`
      : `stopped ${runId} by ${actor}; continuable with vendor session ${session}\n`,
  );
  return 0;
}

function reportEndState(
  run: ListedRun,
  actor: string,
  ended: {
    outcome?: string | null | undefined;
    at?: string | null | undefined;
    vendor_session?: string | null | undefined;
    stopped_by?: string | undefined;
  },
): number {
  if (ended.outcome === "stopped")
    return reportStopped(
      run.id,
      ended.stopped_by ?? actor,
      ended.vendor_session ?? null,
    );
  return reportAlreadyEnded(
    run.id,
    ended.outcome ?? run.outcome,
    ended.at ?? run.ended_at,
  );
}

function recordStopped(run: ListedRun, actor: string) {
  const end = events().findLast((e) => e.id === run.id && e.kind === "ended");
  if (end?.kind === "ended") return end;
  const stopped = {
    kind: "ended",
    id: run.id,
    at: now(),
    exit: 143,
    outcome: "stopped",
    signal: "SIGTERM",
    stopped_by: actor,
    report_path: null,
    vendor_session: run.vendor_session,
    verify: [],
  } satisfies Parameters<typeof append>[0];
  append(stopped);
  return stopped;
}
