import { expect, test } from "bun:test";
import { EndNoticeResult } from "../../src/next/run-state.ts";

test("unknown notice results survive schema validation", () => {
  const result = { status: "unknown" as const, exit: 1, receipt: "receipt unavailable" };
  expect(EndNoticeResult.parse(result)).toEqual(result);
});
