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
  if (
    run.state !== "running" ||
    events().some((e) => e.id === run.id && e.kind === "ended")
  )
    return refuse(
      `run ${run.id} already ended (${run.outcome ?? "ended"}); not running`,
      1,
    );
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
  if (lease.unit !== null && systemctl !== null) {
    const child = Bun.spawn([systemctl, "--user", "stop", lease.unit], {
      stdout: "ignore",
      stderr: "pipe",
      timeout: 10000,
    });
    const [exit, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0)
      return refuse(
        `cannot stop ${lease.unit}: ${error.trim()}; inspect with agx worker ls ${run.id}`,
      );
  } else {
    // Revalidate immediately before the signal; never fall back to an unverified PID.
    if ((await leaseFor(lease.pid, null)).start !== lease.start)
      return refuse(`run ${run.id} owner changed; no signal sent`);
    const sent = fromThrowable(() => process.kill(lease.pid, "SIGTERM"))();
    if (sent.isErr())
      return refuse(`cannot signal run ${run.id}: ${String(sent.error)}`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await leaseFor(lease.pid, lease.unit);
    if (observed.start === lease.start) {
      await Bun.sleep(50);
      continue;
    }
    const finished = recordStopped(run, actor);
    if (finished !== undefined) return finished;
    const ended = events().findLast(
      (event) => event.id === run.id && event.kind === "ended",
    );
    const session =
      ended?.kind === "ended" ? ended.vendor_session : run.vendor_session;
    process.stdout.write(
      session === null
        ? `stopped ${run.id} by ${actor}; not continuable because no vendor session had started\n`
        : `stopped ${run.id} by ${actor}; continuable with vendor session ${session}\n`,
    );
    return 0;
  }
  return refuse(
    `run ${run.id} did not stop within 5s; inspect with agx worker ls ${run.id}`,
  );
}

function recordStopped(run: ListedRun, actor: string): number | undefined {
  const end = events().findLast((e) => e.id === run.id && e.kind === "ended");
  if (end === undefined)
    append({
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
    });
  else if (end.kind === "ended" && end.outcome !== "stopped")
    return refuse(
      `run ${run.id} completed concurrently (${end.outcome ?? "ended"}); inspect its result`,
    );

  return undefined;
}
