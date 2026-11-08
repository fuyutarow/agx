import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { err, fromThrowable, Result } from "neverthrow";
import { xdgStateHome } from "../../shared/src/state-dir.ts";
import { recordedFoldedRuns } from "./next/store.ts";
import { RunSchema } from "./next/run-state.ts";

/** The run record is the authority for the lifetime; no process or PID can authorize deletion. */
const endedToken: unique symbol = Symbol("ended run");
export type RunLifetime =
  | { state: "live"; id: string }
  | { state: "ended"; id: string; readonly [endedToken]: true };
export type EndedRun = Extract<RunLifetime, { state: "ended" }>;

export function recordedLifetime(id: string, recordRoot?: string): RunLifetime {
  const recorded = recordedFoldedRuns(recordRoot).find((run) => run.id === id);
  const parsed = RunSchema.safeParse(recorded);
  return parsed.success &&
    parsed.data.state === "ended" &&
    parsed.data.ended_at !== null
    ? { state: "ended", id, [endedToken]: true }
    : { state: "live", id };
}

export function agxTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(xdgStateHome(env), "agx", "runs");
}

const makeDirectoriesWritable = (path: string): void => {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isDirectory()) return;
  chmodSync(path, entry.mode | 0o700);
  for (const child of readdirSync(path))
    makeDirectoriesWritable(join(path, child));
};

export type RunTemp = Readonly<{
  dir: string;
  env: Readonly<Record<"TMPDIR" | "TMP" | "TEMP", string>>;
}>;

/** The value must originate in the parsed record, and is rechecked before the effect. */
export function freeRunTemp(
  run: EndedRun,
  root = agxTempRoot(),
  recordRoot?: string,
): Result<void, string> {
  if (
    run.state !== "ended" ||
    !run[endedToken] ||
    recordedLifetime(run.id, recordRoot).state !== "ended"
  )
    return err(`agx: cannot free a run that is not recorded ended: ${run.id}`);
  if (
    run.id === "" ||
    /[/\\]/u.test(run.id) ||
    run.id === "." ||
    run.id === ".."
  )
    return err("agx: invalid run id");
  const dir = join(root, run.id, "tmp");
  return fromThrowable(
    () => {
      makeDirectoriesWritable(dir);
      rmSync(dir, { recursive: true, force: true });
    },
    (error) => `agx: cannot remove run temp directory ${dir}: ${String(error)}`,
  )();
}

export function createRunTemp(
  id: string,
  root = agxTempRoot(),
): Result<RunTemp, string> {
  if (id === "" || /[/\\]/u.test(id) || id === "." || id === "..")
    return err(`agx: invalid run id for temp directory: ${id}`);
  const real = fromThrowable(() => realpathSync(root))().unwrapOr(
    resolve(root),
  );
  const systemTmp = fromThrowable(() => realpathSync("/tmp"))().unwrapOr(
    "/tmp",
  );
  if (real === systemTmp)
    return err(`agx: refusing to start a worker with temp root ${systemTmp}`);
  return fromThrowable(
    () => {
      const dir = join(root, id, "tmp");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return { dir, env: { TMPDIR: dir, TMP: dir, TEMP: dir } };
    },
    (error) => `agx: cannot create run temp directory: ${String(error)}`,
  )();
}
