import { z } from "../../shared/src/zod.ts";

const TestDurationMs = z.coerce.number().int().positive().max(5_000);

function testDuration(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = TestDurationMs.safeParse(raw);
  if (!parsed.success)
    throw new Error(`${name} must be an integer from 1 to 5000`);
  return parsed.data;
}

/** Internal timing seams let integration tests exercise waits without wall-clock delays. */
export const timing = {
  lockWaitMs: testDuration("AGX_WS_TEST_LOCK_WAIT_MS", 900_000),
  lockPollMs: testDuration("AGX_WS_TEST_LOCK_POLL_MS", 100),
  stepTimeoutMs: testDuration("AGX_WS_TEST_STEP_TIMEOUT_MS", 900_000),
  drainGraceMs: testDuration("AGX_WS_TEST_DRAIN_GRACE_MS", 100),
};
