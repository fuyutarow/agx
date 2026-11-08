import { expect, test } from "bun:test";
import { EndNoticeResult } from "../../src/next/run-state.ts";
import { jsonOf } from "../../../shared/src/zod.ts";

test("unknown notice results survive schema validation", () => {
  const result = {
    status: "unknown" as const,
    exit: 1,
    receipt: "receipt unavailable",
  };
  const parsed = jsonOf(EndNoticeResult).safeParse(JSON.stringify(result));
  expect(parsed.success && parsed.data).toEqual(result);
});
