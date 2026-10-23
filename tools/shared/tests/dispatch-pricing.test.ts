import { expect, test } from "bun:test";
import { dispatchRowPrice, formatCostUsd } from "../src/dispatch-pricing.ts";

test("embedded prices equal the shipped roster and explicit missing paths do not fall back", () => {
  const previous = process.env.DISPATCH_ROSTER_PATH;
  delete process.env.DISPATCH_ROSTER_PATH;
  using _restore = {
    [Symbol.dispose]: () => {
      if (previous === undefined) delete process.env.DISPATCH_ROSTER_PATH;
      else process.env.DISPATCH_ROSTER_PATH = previous;
    },
  };
  const embedded = dispatchRowPrice("luna-high");
  expect(embedded?.route).toBe("codex");
  expect(embedded).toEqual(
    dispatchRowPrice(
      "luna-high",
      new URL("../../../agents/models/dispatch-roster.toml", import.meta.url)
        .pathname,
    ),
  );
  expect(
    dispatchRowPrice("luna-high", "/nonexistent/dispatch-roster.toml"),
  ).toBeUndefined();
});

test("formats statusline costs to cents without hiding sub-cent spend", () => {
  expect(formatCostUsd(0)).toBe("$0");
  expect(formatCostUsd(0.0004)).toBe("<$0.01");
  expect(formatCostUsd(0.004)).toBe("<$0.01");
  expect(formatCostUsd(0.0099)).toBe("<$0.01");
  expect(formatCostUsd(0.01)).toBe("$0.01");
  expect(formatCostUsd(0.0149)).toBe("$0.01");
  expect(formatCostUsd(1.234)).toBe("$1.23");
  expect(formatCostUsd(undefined)).toBe("");
});
