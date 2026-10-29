import type { ListedRun } from "./run-state.ts";

export const COMPLETION_CLASSES = [
  "done",
  "verified-timeout",
  "incomplete",
] as const;

export type CompletionClass = (typeof COMPLETION_CLASSES)[number];

export type CompletionFacts = Readonly<{
  outcome: ListedRun["outcome"] | null;
  verify: Readonly<{
    ran: boolean;
    exits: readonly number[];
    all_passed: boolean;
  }>;
  workspace_diff_from_start: Readonly<{
    changed_files: number | null;
    nonempty: boolean | null;
  }>;
}>;

export type CompletionResult = Readonly<{
  completion: CompletionClass | null;
  facts: CompletionFacts;
}>;

/** Derive a completion class from the ended record's measured facts. */
export function completionFor(run: ListedRun): CompletionResult {
  const verifyRan = run.verify.length > 0;
  const verifyExits = run.verify.map((check) => check.exit);
  const verifyPassed = verifyRan && verifyExits.every((exit) => exit === 0);
  const changedFiles = run.changed_files ?? null;
  const workspaceDiffNonempty = changedFiles === null ? null : changedFiles > 0;
  const facts = {
    outcome: run.outcome,
    verify: {
      ran: verifyRan,
      exits: verifyExits,
      all_passed: verifyPassed,
    },
    workspace_diff_from_start: {
      changed_files: changedFiles,
      nonempty: workspaceDiffNonempty,
    },
  } satisfies CompletionFacts;

  if (run.state === "running") return { completion: null, facts };
  if (run.outcome === "ok") return { completion: "done", facts };
  if (
    run.outcome === "no-change" &&
    run.writes.length === 0 &&
    verifyPassed &&
    workspaceDiffNonempty === false
  )
    return { completion: "done", facts };
  if (
    run.outcome === "timeout" &&
    verifyPassed &&
    workspaceDiffNonempty === true
  )
    return { completion: "verified-timeout", facts };
  return { completion: "incomplete", facts };
}
