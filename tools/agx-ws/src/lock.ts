// Store mutations share dir-lock with other tools. Foreground ws commands advertise intent
// outside the lock so releasing it cannot let another gc removal jump ahead of a waiter.
import { readdir, rm, stat } from "node:fs/promises";
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { acquire, pidAlive } from "../../shared/src/dir-lock.ts";
import {
  attempt,
  errorMessage,
  type Attempt,
} from "../../shared/src/attempt.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { timing } from "./timing.ts";

const Owner = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  what: z.string(),
  since: z.string(),
});
const describe = (holder: z.output<typeof Owner> | undefined): string =>
  `${holder?.what ?? "unknown holder"} (pid ${holder?.pid ?? "?"}, host ${holder?.host ?? "?"}, since ${holder?.since ?? "?"})`;

async function activeWaiter(path: string): Promise<string | undefined> {
  const text = await attempt(() => Bun.file(path).text());
  const owner = text.ok ? jsonOf(Owner).safeParse(text.value) : undefined;
  if (owner?.success === true)
    return owner.data.host !== hostname() || pidAlive(owner.data.pid)
      ? describe(owner.data)
      : undefined;
  const info = await attempt(() => stat(path));
  if (
    info.ok &&
    Temporal.Now.instant().epochMilliseconds - info.value.mtimeMs < 10_000
  )
    return "a ws command registering its wait";
  return undefined;
}

/** Crashed local waiters expire; foreign or uncertain ownership always yields to the waiter. */
async function waitingCommand(dir: string): Promise<string | undefined> {
  const listed = await attempt(() => readdir(dir));
  if (!listed.ok)
    return z.object({ code: z.literal("ENOENT") }).safeParse(listed.error)
      .success
      ? undefined
      : "a ws waiter whose ownership cannot be read";
  for (const entry of listed.value) {
    const path = join(dir, entry);
    const active = await activeWaiter(path);
    if (active !== undefined) return active;
    await rm(path, { force: true });
  }
  return undefined;
}

export async function withWorkspaceLock<T>(
  lock: string,
  what: string,
  fn: () => Promise<Attempt<T>>,
  skipBusy?: (reason: string) => Attempt<T>,
): Promise<Attempt<T>> {
  const me = {
    pid: process.pid,
    host: hostname(),
    what,
    since: Temporal.Now.instant().toString(),
  };
  const waiters = `${lock}.waiters`;
  const marker = join(waiters, `${process.pid}-${crypto.randomUUID()}.json`);
  const started = performance.now();
  let nextNotice = 5_000;
  let lastHolder: z.output<typeof Owner> | undefined;
  const cleanup = async (): Promise<void> => {
    rmSync(marker, { force: true });
    await attempt(() => { rmdirSync(waiters); });
  };
  const onTerm = (): void => { void cleanup().finally(() => process.exit(143)); };
  const onInt = (): void => { void cleanup().finally(() => process.exit(130)); };
  const finishWaiting = async (): Promise<void> => {
    if (skipBusy !== undefined) return;
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    await cleanup();
  };
  const notice = (holder: z.output<typeof Owner> | undefined): void => {
    const elapsed = performance.now() - started;
    if (skipBusy !== undefined || elapsed < nextNotice) return;
    process.stderr.write(
      `ws: waiting ${Math.floor(elapsed / 1_000)}s for ${describe(holder)} on ${lock}\n`,
    );
    nextNotice = elapsed + 5_000;
  };
  const run = async (): Promise<Attempt<T>> => {
    if (skipBusy === undefined) {
      mkdirSync(waiters, { recursive: true });
      writeFileSync(marker, JSON.stringify(me));
      process.on("SIGTERM", onTerm);
      process.on("SIGINT", onInt);
    }
    for (;;) {
      const waiting =
        skipBusy === undefined ? undefined : await waitingCommand(waiters);
      if (waiting !== undefined && skipBusy !== undefined)
        return skipBusy(`yielding to ${waiting}`);
      const got = await acquire(lock, me, { waitMs: 0 });
      if (typeof got === "function") {
        await finishWaiting();
        // Acquisition itself can cross the reporting threshold after a delayed poll.
        notice(lastHolder);
        const result = await attempt(async () => {
          // Close the race with a foreground command registering during acquisition.
          const ahead =
            skipBusy === undefined ? undefined : await waitingCommand(waiters);
          if (ahead !== undefined && skipBusy !== undefined)
            return skipBusy(`yielding to ${ahead}`);
          return fn();
        });
        got();
        return result.ok
          ? result.value
          : { ok: false, error: errorMessage(result.error) };
      }
      if (skipBusy !== undefined)
        return skipBusy(
          `lock ${lock} held by ${describe(got)}; repository busy`,
        );
      const elapsed = performance.now() - started;
      lastHolder = got;
      notice(got);
      if (elapsed >= timing.lockWaitMs)
        return {
          ok: false,
          error: `lock ${lock} held by ${describe(got)} after ${Math.floor(elapsed / 1_000)}s; not waiting longer`,
        };
      await Bun.sleep(timing.lockPollMs);
    }
  };
  const result = await attempt(run);
  await finishWaiting();
  return result.ok
    ? result.value
    : { ok: false, error: errorMessage(result.error) };
}
