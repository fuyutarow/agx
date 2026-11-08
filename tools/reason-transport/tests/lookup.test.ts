import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupAddress } from "../src/index.ts";

const binary = new URL("./fake-who.ts", import.meta.url).pathname;
const input = {
  binary,
  vendor: "codex",
  session: "thread-id",
  deadlineMs: 3000,
};

test("maps both vendors and selects the is_me address", async () => {
  expect(await lookupAddress(input)).toEqual({
    kind: "accepted",
    value: "codex/thread-id",
  });
  expect(
    await lookupAddress({ ...input, vendor: "claude", session: "session-id" }),
  ).toEqual({ kind: "accepted", value: "claude-code/session-id" });
});

test("distinguishes absent, ambiguous, failed and timed out lookups", async () => {
  for (const session of ["empty", "no-me"]) {
    const result = await lookupAddress({ ...input, session });
    expect(result.kind).toBe("refused");
    if (result.kind === "refused")
      expect(result.text).toContain("not registered or not live");
  }
  expect((await lookupAddress({ ...input, session: "multiple" })).kind).toBe(
    "unknown",
  );
  for (const session of ["nonzero", "broken"])
    expect((await lookupAddress({ ...input, session })).kind).toBe(
      "unavailable",
    );
  expect(
    (await lookupAddress({ ...input, binary: "/no/such/reason-binary" })).kind,
  ).toBe("unavailable");
  expect(
    (await lookupAddress({ ...input, session: "hang", deadlineMs: 100 })).kind,
  ).toBe("unknown");
});

test("usage errors do not start a process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reason-who-"));
  const marker = join(dir, "started");
  const previous = process.env.WHO_MARKER;
  process.env.WHO_MARKER = marker;
  try {
    for (const options of [
      { ...input, binary: "" },
      { ...input, vendor: "" },
      { ...input, vendor: "other" },
      { ...input, session: "" },
      ...[undefined, 0, -1, Infinity, NaN, 2_147_483_648].map((deadlineMs) => ({
        ...input,
        deadlineMs,
      })),
    ]) {
      // @ts-expect-error exercise missing deadline from untyped callers
      expect((await lookupAddress(options)).kind).toBe("usage");
    }
    expect(
      await readFile(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.WHO_MARKER;
    else process.env.WHO_MARKER = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
