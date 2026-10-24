import { Database } from "bun:sqlite";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt } from "../../shared/src/attempt.ts";
import {
  DoctorAggregate as BaseDoctorAggregate,
  doctorAggregatePath,
  doctorTools,
} from "../../shared/src/doctor-aggregate.ts";
import { stateDir } from "../../shared/src/state-dir.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";

export const pollAfterMs = 60_000;
// Preserve additive collection diagnostics through snapshot and queue parsing.
export const DoctorAggregate = BaseDoctorAggregate.extend({
  members: z
    .array(
      BaseDoctorAggregate.shape.members.element.extend({
        timed_out: z.boolean().optional(),
        deadline_ms: z.number().int().positive().optional(),
        signal: z.string().nullable().optional(),
      }),
    )
    .length(3),
});
export type DoctorAggregate = z.output<typeof DoctorAggregate>;
export const DoctorResponse = DoctorAggregate.extend({
  stale: z.boolean(),
  error: z.string().nullable(),
  last_good_at: z.number().nullable(),
});
export type DoctorResponse = z.output<typeof DoctorResponse>;
const now = () => Temporal.Now.instant().epochMilliseconds;
const queuePath = (env: NodeJS.ProcessEnv = process.env) =>
  join(stateDir(env), "doctor-refresh.sqlite");
const errorCode = (error: unknown) =>
  z.object({ code: z.string() }).safeParse(error);

async function snapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorAggregate | null | undefined> {
  const text = await attempt(() => Bun.file(doctorAggregatePath(env)).text());
  if (!text.ok) {
    const parsed = errorCode(text.error);
    if (parsed.success && parsed.data.code === "ENOENT") return undefined;
    return null;
  }
  const parsed = jsonOf(DoctorAggregate).safeParse(text.value);
  return parsed.success ? parsed.data : null;
}

function failure(
  good: DoctorAggregate | null | undefined,
  error: string,
  partial?: DoctorAggregate,
): DoctorResponse {
  const previous = good?.complete === true ? good : undefined;
  return {
    ...(previous ??
      partial ?? {
        schema: 1,
        findings: [],
        kinds: {},
        total: 0,
        lost: 0,
        captured_at: now(),
        members: doctorTools.map((tool) => ({
          tool,
          exit: null,
          complete: false,
        })),
      }),
    complete: false,
    ...(partial === undefined ? {} : { members: partial.members }),
    stale: true,
    error,
    last_good_at: previous?.captured_at ?? null,
  };
}

/** Read-only owner projection. Neither the queue nor the snapshot is a public file API. */
export async function readDoctorResponse(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorResponse | null | undefined> {
  const good = await snapshot(env);
  if (good === null) return null;
  const queued = await readResponse(env);
  if (queued !== undefined) return queued;
  if (good === undefined) return undefined;
  return {
    ...good,
    stale: !good.complete,
    error: good.complete ? null : "previous collection incomplete",
    last_good_at: good.complete ? good.captured_at : null,
  };
}

async function readResponse(
  env: NodeJS.ProcessEnv,
): Promise<DoctorResponse | null | undefined> {
  if (!(await Bun.file(queuePath(env)).exists())) return undefined;
  const result = await attempt(() => {
    using db = new Database(queuePath(env), { readonly: true });
    return db
      .query<{ response: string | null }, []>(
        "SELECT response FROM refresh WHERE id = 1",
      )
      .get()?.response;
  });
  if (!result.ok) return null;
  if (result.value === null || result.value === undefined) return undefined;
  const parsed = jsonOf(DoctorResponse).safeParse(result.value);
  return parsed.success ? parsed.data : null;
}

type Queue = {
  active: string | null;
  pending: number;
  completed: number;
  response: string | null;
};
type Collection = (timeout: number) => Promise<DoctorAggregate>;

async function publish(response: DoctorResponse) {
  const path = doctorAggregatePath();
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const result = await attempt(async () => {
    await writeFile(temp, `${JSON.stringify(response)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, path);
  });
  await rm(temp, { force: true }).catch(() => {});
  return result;
}

async function collectAndPublish(
  collect: Collection,
  timeoutMs: number,
  deadline: number,
) {
  const good = await snapshot();
  if (performance.now() >= deadline)
    return failure(good, "refresh deadline exceeded");
  const collected = await attempt(() =>
    collect(
      Math.max(
        1,
        Math.min(timeoutMs, Math.floor(deadline - performance.now())),
      ),
    ),
  );
  if (!collected.ok)
    return failure(good, `refresh failed: ${String(collected.error)}`);
  const aggregate = collected.value;
  if (performance.now() >= deadline)
    return failure(good, "refresh deadline exceeded", aggregate);
  if (!aggregate.complete)
    return failure(good, "member collection incomplete", aggregate);
  const response = {
    ...aggregate,
    stale: false,
    error: null,
    last_good_at: aggregate.captured_at,
  };
  const published = await publish(response);
  return published.ok
    ? response
    : failure(
        good,
        `snapshot publication failed: ${String(published.error)}`,
        aggregate,
      );
}

function admission(db: Database, token: string, target?: number) {
  return db
    .transaction(() => {
      const row = db
        .query<Queue, []>("SELECT * FROM refresh WHERE id = 1")
        .get();
      if (row === null) return null;
      if (target !== undefined && row.completed >= target)
        return { owner: false, target, response: row.response };
      if (row.active === null) {
        db.query("UPDATE refresh SET active = ?, pending = 0 WHERE id = 1").run(
          token,
        );
        return { owner: true, target: row.completed + 1, response: null };
      }
      db.run("UPDATE refresh SET pending = 1 WHERE id = 1");
      return {
        owner: false,
        target: target ?? row.completed + 2,
        response: null,
      };
    })
    .immediate();
}

async function runQueue(
  db: Database,
  collect: Collection,
  timeoutMs: number,
  deadline: number,
) {
  const token = `${process.pid}:${crypto.randomUUID()}`;
  let next = admission(db, token);
  const target = next?.target;
  if (target === undefined)
    return failure(await snapshot(), "refresh queue unavailable");
  while (next !== null && (next.owner || performance.now() < deadline)) {
    if (next.owner) {
      const response = await collectAndPublish(collect, timeoutMs, deadline);
      db.query(
        "UPDATE refresh SET response = ?, completed = completed + 1, active = NULL WHERE id = 1 AND active = ?",
      ).run(JSON.stringify(response), token);
      return response;
    }
    if (next.response !== null) {
      const parsed = jsonOf(DoctorResponse).safeParse(next.response);
      return parsed.success
        ? parsed.data
        : failure(await snapshot(), "invalid refresh response");
    }
    await Bun.sleep(Math.min(20, Math.max(1, deadline - performance.now())));
    if (performance.now() < deadline) next = admission(db, token, target);
  }
  // A caller's wait timeout never cancels the shared owner or replaces its result.
  return failure(await snapshot(), "refresh deadline exceeded while waiting");
}

/** SQLite serializes admission only; no database lock is held while children run. */
export async function refreshDoctor(
  collect: Collection,
  timeoutMs: number,
  deadlineMs: number,
): Promise<DoctorResponse> {
  const deadline = performance.now() + deadlineMs;
  const result = await attempt(async () => {
    await mkdir(dirname(queuePath()), { recursive: true });
    // append creates a private file if absent, without truncating another caller's database.
    await writeFile(queuePath(), "", { flag: "a", mode: 0o600 });
    using db = new Database(queuePath(), { create: true, strict: true });
    db.run(`PRAGMA busy_timeout = ${Math.max(1, Math.min(100, deadlineMs))}`);
    db.run(`CREATE TABLE IF NOT EXISTS refresh (
      id INTEGER PRIMARY KEY CHECK (id = 1), active TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, response TEXT
    )`);
    db.run("INSERT OR IGNORE INTO refresh (id) VALUES (1)");
    return await runQueue(db, collect, timeoutMs, deadline);
  });
  return result.ok
    ? result.value
    : failure(
        await snapshot(),
        `refresh coordination failed: ${String(result.error)}`,
      );
}
