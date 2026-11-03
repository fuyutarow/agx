import { describe, expect, test } from "bun:test";
import { parseReport, receiptReportInput } from "../src/report.ts";

const report = {
  summary: "done",
  changes: [],
  checks: [],
  for_coordinator: [],
  open: [],
};

function parse(receipt: Parameters<typeof receiptReportInput>[0]) {
  const line = JSON.stringify(receipt);
  const input = receiptReportInput(receipt, line);
  return parseReport(input.structured, input.message);
}

describe("claude receipt report parsing", () => {
  test("a valid report in result is the report", () => {
    const parsed = parse({ result: JSON.stringify(report) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report.summary).toBe("done");
  });

  test("structured_output wins over result", () => {
    const parsed = parse({
      structured_output: { ...report, summary: "structured" },
      result: JSON.stringify(report),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report.summary).toBe("structured");
  });

  test("a prose result is malformed", () => {
    expect(parse({ result: "all done, nothing to report" }).ok).toBe(false);
  });

  test("codex receipt path is unchanged", () => {
    const parsed = parse({ last_message: JSON.stringify(report) });
    expect(parsed.ok).toBe(true);
    const input = receiptReportInput(
      { last_message: "codex", result: "claude" },
      "line",
    );
    expect(input.message).toBe("codex");
    expect(receiptReportInput({}, "line").message).toBe("line");
  });
});
