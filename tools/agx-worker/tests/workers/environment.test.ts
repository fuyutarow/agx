import { expect, test } from "bun:test";
import { workerEnvironment } from "../../src/workers/environment.ts";

test("inherited Claude credentials remain available to the wrapper", () => {
  const env = workerEnvironment({
    ANTHROPIC_API_KEY: "key",
    ANTHROPIC_AUTH_TOKEN: "token",
  });
  expect(env.ANTHROPIC_API_KEY).toBe("key");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("token");
});
