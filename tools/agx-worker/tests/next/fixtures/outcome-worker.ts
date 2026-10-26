import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.AGX_OUTCOME_FIXTURE;
const report = {
  summary: `fixture ${mode}`,
  // Deliberately lie: workspace evidence, rather than this list, controls the outcome.
  changes:
    mode === "no-change" ? [{ path: "work.txt", what: "claimed change" }] : [],
  checks: [],
  open: [],
  for_coordinator: [],
};
if (mode !== "no-change") writeFileSync("work.txt", `changed by ${mode}\n`);
if (mode === "killed-bound") await Bun.sleep(120_000);
let receipt: unknown = report;
if (mode === "string-wrapped")
  receipt = { exit_code: 0, result: JSON.stringify(report) };
if (mode === "malformed") receipt = { summary: "missing required fields" };
if (mode === "timeout") {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"], {
    timeout: 20,
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  receipt = { timed_out: child.signalCode === "SIGTERM", exit_code: 0, report };
}
if (mode === "capacity") receipt = { outcome: "capacity", report };
if (mode === "refused") receipt = { outcome: "refused", report };
if (mode === "structured") receipt = { structured_output: report };
if (mode === "last-message") receipt = { last_message: JSON.stringify(report) };
if (mode === "string-report") receipt = { report: JSON.stringify(report) };
if (mode === "trailing-text")
  receipt = { last_message: `${JSON.stringify(report)}\nextra text` };
const writeRunResult = (contents: string): boolean => {
  const runDir = process.env.AGX_RUN_DIR;
  if (runDir === undefined) {
    process.stderr.write("AGX_RUN_DIR is missing\n");
    process.exitCode = 1;
    return false;
  }
  writeFileSync(join(runDir, "fixture.result.md"), contents);
  return true;
};
if (mode === "real-returned") {
  const resultFile = readFileSync(
    join(import.meta.dir, "outcome-malformed-result.md"),
    "utf8",
  );
  const lastMessage = readFileSync(
    join(import.meta.dir, "outcome-malformed-final-message.txt"),
    "utf8",
  );
  if (writeRunResult(resultFile)) receipt = { last_message: lastMessage };
}
if (mode === "unreadable-report") {
  const returnRecord = {
    findings: [],
    evidence: [],
    impact_on_brief: "the report could not be read",
    proposed_next: "inspect the final message",
    artifacts: ["fixture.result.md"],
  };
  const lastMessage = `unreadable report\n\n\`\`\`agx-return\n${JSON.stringify(returnRecord)}\n\`\`\``;
  if (writeRunResult(lastMessage)) receipt = { last_message: lastMessage };
}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
