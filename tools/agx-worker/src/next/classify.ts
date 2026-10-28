import { resolveRunId } from "./run-id.ts";
import { completionFor } from "./completion.ts";
import { foldedRuns, stateDir } from "./store.ts";

export async function classifyRun(
  flags: { id?: string | undefined; json?: boolean | undefined },
  runtime: {
    root?: string;
    writeStdout?: (line: string) => void;
    writeStderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const writeStdout =
    runtime.writeStdout ?? ((line: string) => process.stdout.write(line));
  const writeStderr =
    runtime.writeStderr ?? ((line: string) => process.stderr.write(line));
  const id = flags.id;
  if (id === undefined) {
    writeStderr("agx: classify requires RUN_ID\n");
    return 2;
  }

  const resolution = resolveRunId(
    await foldedRuns(runtime.root ?? stateDir()),
    id,
  );
  if (resolution.kind === "error") {
    writeStderr(`agx: ${resolution.error}\n`);
    return 2;
  }
  const run = resolution.row;
  if (run.state === "running") {
    writeStderr(
      `agx: run '${run.id}' is still running; no completion class yet\n`,
    );
    return 2;
  }

  const result = completionFor(run);
  if (flags.json === true) {
    writeStdout(`${JSON.stringify({ id: run.id, ...result })}\n`);
  } else {
    const facts = result.facts;
    writeStdout(
      `${run.id} completion=${result.completion} outcome=${facts.outcome ?? "unknown"} verify_ran=${facts.verify.ran} verify_all_passed=${facts.verify.all_passed} verify_exits=${facts.verify.exits.length === 0 ? "-" : facts.verify.exits.join(",")} workspace_diff_nonempty=${facts.workspace_diff_from_start.nonempty ?? "unknown"} changed_files=${facts.workspace_diff_from_start.changed_files ?? "unknown"}\n`,
    );
  }
  return 0;
}
