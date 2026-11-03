import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fromThrowable } from "neverthrow";
import { jsonOf } from "../../../shared/src/zod.ts";
import { DispatchBindingSchema } from "../../../shared/src/agx-dispatch-binding.ts";
import { stateDir } from "../state.ts";
import { fatalMessages } from "./exit.ts";
import { append, events, now } from "./store.ts";

const CAUSE_LIMIT = 8192;

/**
 * A dispatched run owns a `dispatching` row from the moment the dispatcher records it. If the
 * unit's process leaves before that run records `started` or `ended`, nothing else closes the row
 * and the lease check later reads it as `lost` / `owner-gone`. This guard closes it as a launch
 * failure carrying the cause and the stderr the process produced.
 *
 * Returns the function that notes a thrown error; call it before rethrowing.
 */
export function guardPreLaunch(rawBinding: string | undefined): {
  noteError: (error: unknown) => void;
} {
  const parsed = jsonOf(DispatchBindingSchema).safeParse(rawBinding ?? "");
  const binding = parsed.success ? parsed.data : undefined;
  if (binding === undefined) return { noteError: () => {} };
  process.on("exit", (code) => {
    const recorded = events().filter((event) => event.id === binding.id);
    if (
      recorded.some(
        (event) => event.kind === "started" || event.kind === "ended",
      )
    )
      return;
    const stderr = fatalMessages.join("").slice(-CAUSE_LIMIT);
    const cause =
      stderr.trim() === ""
        ? `agx worker run exited ${code} before the run started; no stderr was produced`
        : `agx worker run exited ${code} before the run started: ${stderr.trim().split("\n").at(-1) ?? ""}`;
    const dir = resolve(stateDir(), "runs", binding.id);
    fromThrowable(() => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "launch-failure.txt"), `${cause}\n\n${stderr}`);
    })();
    append(
      {
        kind: "ended",
        id: binding.id,
        at: now(),
        exit: code === 0 ? 1 : code,
        outcome: "launch-failed",
        cause,
        launch_stderr: stderr,
        report_path: null,
        vendor_session: null,
        verify: [],
      },
      stateDir(),
      false,
    );
  });
  return {
    noteError: (error) => {
      fatalMessages.push(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    },
  };
}
