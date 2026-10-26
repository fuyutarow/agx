import shippedCatalog from "../../agx-worker/src/roster/catalog.toml" with { type: "toml" };
import { z } from "./zod.ts";

export type TokenUsage = Readonly<{
  input_tokens?: number | undefined;
  cached_input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  reasoning_output_tokens?: number | undefined;
}>;

export type TokenPrices = Readonly<{
  price_in?: number | undefined;
  price_cached_in?: number | undefined;
  price_out?: number | undefined;
}>;

export function formatCostUsd(value: number | undefined): string {
  if (value === undefined) return "";
  if (value === 0) return "$0";
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function costUsd(
  prices: TokenPrices,
  usage: TokenUsage,
): number | undefined {
  if (
    prices.price_in === undefined ||
    prices.price_out === undefined ||
    usage.input_tokens === undefined ||
    usage.output_tokens === undefined
  )
    return undefined;
  const cached = usage.cached_input_tokens ?? 0;
  return (
    ((usage.input_tokens - cached) * prices.price_in +
      cached * (prices.price_cached_in ?? prices.price_in) +
      (usage.output_tokens + (usage.reasoning_output_tokens ?? 0)) *
        prices.price_out) /
    1_000_000
  );
}

export type DispatchRowPrice = TokenPrices & Readonly<{ route: string }>;
const CatalogPricesSchema = z.object({
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

/** Read the chosen row's route and token prices from the shipped model catalog. */
export function dispatchRowPrice(choice: string): DispatchRowPrice | undefined {
  const catalog = CatalogPricesSchema.safeParse(shippedCatalog);
  if (!catalog.success) return undefined;
  const row = catalog.data.choice.find((candidate) => candidate.id === choice);
  if (row === undefined) return undefined;
  return {
    route: row.route,
    ...(row.price_in === undefined ? {} : { price_in: row.price_in }),
    ...(row.price_cached_in === undefined
      ? {}
      : { price_cached_in: row.price_cached_in }),
    ...(row.price_out === undefined ? {} : { price_out: row.price_out }),
  };
}
