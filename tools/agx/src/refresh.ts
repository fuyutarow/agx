import { Database } from "bun:sqlite";
import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
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

/** A stable inode serializes collection across processes; it must never be unlinked. */
export async function refreshDoctor(
  collect: Collection,
  timeoutMs: number,
  deadlineMs: number,
  beforeLock?: () => Promise<void>,
): Promise<DoctorResponse> {
  const deadline = performance.now() + deadlineMs;
  const result = await attempt(async () => {
    // Bun's process.hrtime has a process-local origin; clock_gettime is shared.
    const clock = dlopen(
      process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
      {
        clock_gettime: {
          args: [FFIType.i32, FFIType.ptr],
          returns: FFIType.i32,
        },
      },
    );
    using _clockCleanup = {
      [Symbol.dispose]: () => {
        clock.close();
      },
    };
    const timestamp = () => {
      const value = new BigInt64Array(2);
      if (
        clock.symbols.clock_gettime(
          process.platform === "darwin" ? 6 : 1,
          ptr(value),
        ) !== 0
      )
        return null;
      return (value[0] ?? 0n) * 1_000_000_000n + (value[1] ?? 0n);
    };
    const started = timestamp();
    if (started === null)
      return failure(await snapshot(), "monotonic clock unavailable");
    const boot =
      process.platform === "darwin"
        ? Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"])
            .stdout.toString()
            .trim()
        : (await Bun.file("/proc/sys/kernel/random/boot_id").text()).trim();
    if (boot.length === 0)
      return failure(await snapshot(), "boot identity unavailable");
    await mkdir(dirname(queuePath()), { recursive: true });
    const errnoSymbol =
      process.platform === "darwin" ? "__error" : "__errno_location";
    const library = dlopen(
      process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
      {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoSymbol]: { args: [], returns: FFIType.ptr },
      },
    );
    using _libraryCleanup = {
      [Symbol.dispose]: () => {
        library.close();
      },
    };
    await using lock = await open(`${queuePath()}.lock`, "a", 0o600);
    await beforeLock?.();
    while (library.symbols.flock(lock.fd, 2 | 4) !== 0) {
      const pointer = library.symbols[errnoSymbol]?.();
      const errno =
        pointer === null || pointer === undefined
          ? undefined
          : ffiRead.i32(pointer, 0);
      if (errno !== (process.platform === "darwin" ? 35 : 11))
        return failure(
          await snapshot(),
          `flock failed: errno ${errno ?? "unavailable"}`,
        );
      if (performance.now() >= deadline)
        return failure(
          await snapshot(),
          "refresh deadline exceeded while waiting",
        );
      await Bun.sleep(Math.min(20, Math.max(1, deadline - performance.now())));
    }
    if (performance.now() >= deadline)
      return failure(
        await snapshot(),
        "refresh deadline exceeded while waiting",
      );
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
    const row = db
      .query<{ active: string | null; response: string | null }, []>(
        "SELECT active, response FROM refresh WHERE id = 1",
      )
      .get();
    if (
      row?.active !== null &&
      row?.active !== undefined &&
      row.active.startsWith(`${boot}:`) &&
      /^\d+$/u.test(row.active.slice(boot.length + 1)) &&
      BigInt(row.active.slice(boot.length + 1)) > started &&
      row.response !== null
    ) {
      const parsed = jsonOf(DoctorResponse).safeParse(row.response);
      if (parsed.success) return parsed.data;
    }
    const refreshStarted = timestamp();
    if (refreshStarted === null)
      return failure(await snapshot(), "monotonic clock unavailable");
    const response = await collectAndPublish(collect, timeoutMs, deadline);
    db.query("UPDATE refresh SET active = ?, response = ? WHERE id = 1").run(
      `${boot}:${refreshStarted}`,
      JSON.stringify(response),
    );
    return response;
  });
  return result.ok
    ? result.value
    : failure(
        await snapshot(),
        `refresh coordination failed: ${String(result.error)}`,
      );
}
