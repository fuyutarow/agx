import { expect, test } from "bun:test";
import shippedCatalog from "../../agx-worker/src/roster/catalog.toml" with { type: "toml" };
import { dispatchRowPrice, formatCostUsd } from "../src/dispatch-pricing.ts";
import { z } from "../src/zod.ts";

const ShippedCatalog = z.object({
  choice: z.array(
    z.object({
      id: z.string(),
      route: z.string(),
      price_in: z.number().optional(),
      price_cached_in: z.number().optional(),
      price_out: z.number().optional(),
    }),
  ),
});

test("dispatch row prices come from the canonical catalog", () => {
  const catalog = ShippedCatalog.safeParse(shippedCatalog);
  expect(catalog.success).toBe(true);
  if (!catalog.success) return;
  for (const row of catalog.data.choice) {
    expect(dispatchRowPrice(row.id)).toEqual({
      route: row.route,
      ...(row.price_in === undefined ? {} : { price_in: row.price_in }),
      ...(row.price_cached_in === undefined
        ? {}
        : { price_cached_in: row.price_cached_in }),
      ...(row.price_out === undefined ? {} : { price_out: row.price_out }),
    });
  }
  expect(dispatchRowPrice("missing-row")).toBeUndefined();
});

test("roster contract: every choice names a model the catalog prices", () => {
  const catalog = ShippedCatalog.safeParse(shippedCatalog);
  expect(catalog.success).toBe(true);
  if (!catalog.success) return;
  for (const row of catalog.data.choice) {
    const price = dispatchRowPrice(row.id);
    expect(price).toBeDefined();
    if (price === undefined) continue;
    expect(price.route).toBe(row.route);
    expect(typeof price.price_in).toBe("number");
    expect(typeof price.price_out).toBe("number");
  }
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
