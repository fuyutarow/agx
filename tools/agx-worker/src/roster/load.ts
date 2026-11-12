import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "../../../shared/src/zod.ts";
import { attempt, errorMessage } from "../../../shared/src/attempt.ts";
import { resolveAgxConfigWithProvenance } from "../../../shared/src/agx-config.ts";

import { generationExclusivityError } from "./generation.ts";
import shippedCatalog from "./catalog.toml" with { type: "toml" };

const RouteSchema = z.enum(["codex", "claude-api", "claude-session"], {
  error: 'route "claude" was split: write "claude-api" or "claude-session"',
});
const ChoiceSchema = z.strictObject({
  id: z.string().regex(/^[a-z]+[0-9]*-[a-z]+$/u),
  route: RouteSchema,
  model: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  score_as_of: z.iso.date().optional(),
  aa_index: z.number().optional(),
  aa_cost_to_run_usd: z.number().positive().optional(),
  aa_tokens_to_run_m: z.number().positive().optional(),
  aa_cost_per_task_usd: z.number().positive().optional(),
  aa_time_per_task_s: z.number().positive().optional(),
  tb4: z.number().optional(),
  tb4_source: z.url().optional(),
  scicode: z.number().optional(),
  scicode_source: z.url().optional(),
  coding_agent: z.number().optional(),
  price_in: z.number().optional(),
  price_cached_in: z.number().optional(),
  price_out: z.number().optional(),
});
export type Choice = z.output<typeof ChoiceSchema>;

const JevPricesSchema = z.strictObject({
  price_per_mtok_input: z.number().nonnegative().optional(),
  price_per_mtok_output: z.number().nonnegative().optional(),
});

const CatalogSchema = z
  .strictObject({
    schema: z.literal(1),
    as_of: z.iso.date(),
    as_of_cost: z.iso.date().optional(),
    jev: JevPricesSchema,
    sources: z.record(z.string(), z.url()),
    choice: z.array(ChoiceSchema).min(1),
  })
  .refine(
    (catalog) =>
      new Set(catalog.choice.map((row) => row.id)).size ===
      catalog.choice.length,
    {
      message: "choice ids must be unique",
    },
  );

const JevFileSchema = z.strictObject({
  api: z.enum(["typesafe", "reseller"]),
  url: z.url(),
  model: z.string().min(1),
});

const ExhaustionSchema = z.strictObject({
  codex: z.enum(["continue", "stop"]).optional(),
  "claude-session": z.enum(["continue", "stop"]).optional(),
  "claude-api": z.enum(["continue", "stop"]).optional(),
  claude: z
    .never({
      error: 'route "claude" was split: write "claude-api" or "claude-session"',
    })
    .optional(),
});

const ClaudeRunSchema = z.strictObject({
  max_budget_usd: z.number().gt(0),
  max_turns: z.number().int().positive(),
  reason: z.string().min(20),
});

/** The policy file: every key and table is optional except `schema`; omitted keys take shipped defaults. */
const PolicySchema = z.strictObject({
  schema: z.literal(1),
  route: z.strictObject({
    allow: z.array(RouteSchema).min(1),
    on_window_exhausted: ExhaustionSchema,
    // Retired 2026-11-03: a default row would be silently substituted when Jev cannot route.
    default: z
      .never({
        error:
          "route.default was removed: agx never substitutes a row when Jev cannot route; delete the key",
      })
      .optional(),
    exclude: z.array(z.string()),
    max_task_chars: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
    // Retired 2026-11-10: routing never enforced it, so a file naming it is rejected.
    no_egress: z
      .never({
        error:
          "route.no_egress was removed: routing never enforced it; delete the key",
      })
      .optional(),
    pick_temperature: z.number().min(0).max(5),
    jev: JevFileSchema,
  }),
  claude_run: ClaudeRunSchema,
});

const AutoSchema = z.strictObject({
  routes: z.array(RouteSchema).min(1),
  on_window_exhausted: z
    .strictObject({
      codex: z.enum(["continue", "stop"]).optional(),
      "claude-session": z.enum(["continue", "stop"]).optional(),
      "claude-api": z.enum(["continue", "stop"]).optional(),
      claude: z
        .never({
          error:
            'route "claude" was split: write "claude-api" or "claude-session"',
        })
        .optional(),
    })
    .optional(),
  max_task_chars: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  max_codex_workers: z.number().int().positive().optional(),
  pick_temperature: z.number().min(0).max(5),
  jev: z.discriminatedUnion("api", [
    z.strictObject({
      api: z.literal("typesafe"),
      url: z.url(),
      model: z.string().min(1),
      price_per_mtok_input: z.number().nonnegative().optional(),
      price_per_mtok_output: z.number().nonnegative().optional(),
    }),
    z.strictObject({
      api: z.literal("reseller"),
      url: z.url(),
      price_per_mtok_input: z.number().nonnegative().optional(),
      price_per_mtok_output: z.number().nonnegative().optional(),
    }),
  ]),
});

const RosterSchema = z.strictObject({
  schema: z.literal(1),
  as_of: z.iso.date(),
  as_of_cost: z.iso.date().optional(),
  auto: AutoSchema,
  claude_run: ClaudeRunSchema,
  sources: z.record(z.string(), z.url()),
  choice: z.array(ChoiceSchema).min(1),
});

export type Roster = z.output<typeof RosterSchema>;

export type RosterLoad =
  | {
      readonly ok: true;
      readonly value: Roster;
      readonly catalogRows: readonly Choice[];
      readonly provenance: {
        policy_version: string;
        catalog_version: string;
        before: string[];
        excluded: string[];
      };
      /** Where the policy came from and, per key, whether the file or the shipped default supplied it. */
      readonly policy: {
        readonly source: string;
      };
    }
  | { readonly ok: false; readonly error: string };

export type LoadRosterOptions = Readonly<{
  catalogPath?: string;
  policyPath?: string;
  /** Repository whose agx.toml [route] overrides the user policy; defaults to the working directory. */
  repoRoot?: string;
}>;

type PolicyLocation = Readonly<{ path: string; explicit: boolean }>;

/** An `AGX_CONFIG` or library-selected path is explicit; the XDG path is the default location. */
function policyLocation(selected: string | undefined): PolicyLocation {
  if (selected !== undefined) return { path: selected, explicit: true };
  const explicit = Bun.env.AGX_CONFIG;
  if (explicit !== undefined && explicit.length > 0)
    return { path: explicit, explicit: true };
  const xdg = Bun.env.XDG_CONFIG_HOME;
  const configHome =
    xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return { path: join(configHome, "agx", "agx.toml"), explicit: false };
}

async function parseToml(path: string): Promise<unknown> {
  return Bun.TOML.parse(await readFile(path, "utf8"));
}

const EXAMPLES: Record<string, string> = {
  route: "[route]",
  "route.allow": 'allow = ["codex", "claude-session"]',
  "route.on_window_exhausted":
    'on_window_exhausted = { codex = "continue", "claude-session" = "stop" }',
  "route.exclude": "exclude = []",
  "route.max_task_chars": "max_task_chars = 6000",
  "route.timeout_ms": "timeout_ms = 20000",
  "route.pick_temperature": "pick_temperature = 0",
  "route.jev": "[route.jev]",
  "route.jev.api": 'api = "typesafe"',
  "route.jev.url": 'url = "https://api.typesafe.ai/v1/systemone"',
  "route.jev.model": 'model = "jev-latest"',
  claude_run: "[claude_run]",
  "claude_run.max_budget_usd": "max_budget_usd = 2.0",
  "claude_run.max_turns": "max_turns = 60",
  "claude_run.reason": 'reason = "Explain the budget choice here"',
};

/** Reads the shipped catalog and one user policy, returning the legacy roster shape. */
export async function loadRoster(
  options: LoadRosterOptions = {},
): Promise<RosterLoad> {
  return Promise.try(async (): Promise<RosterLoad> => {
    const catalogRaw: unknown =
      options.catalogPath === undefined
        ? shippedCatalog
        : await parseToml(options.catalogPath);
    const location = policyLocation(options.policyPath);
    const policyPath = location.path;
    const policyRaw = await attempt(() => parseToml(policyPath));
    if (!policyRaw.ok)
      return {
        ok: false,
        error: `cannot read policy ${JSON.stringify(policyPath)}; see policy.example.toml: ${errorMessage(policyRaw.error).replaceAll(/[\r\n]+/gu, " ")}`,
      };
    const catalogResult = CatalogSchema.safeParse(catalogRaw);
    if (!catalogResult.success)
      return { ok: false, error: catalogResult.error.message };
    const policyResult = PolicySchema.safeParse(policyRaw.value);
    if (!policyResult.success) {
      const issue = policyResult.error.issues[0];
      if (issue?.message.startsWith('route "claude" was split') === true)
        return { ok: false, error: issue.message };
      const key = issue?.path.join(".") ?? "policy";
      const example = EXAMPLES[key];
      return {
        ok: false,
        error:
          example === undefined
            ? policyResult.error.message
            : `policy ${key}: ${issue?.message}; example: ${example}`,
      };
    }
    const policy = policyResult.data;
    for (const route of policy.route.allow) {
      if (policy.route.on_window_exhausted[route] === undefined)
        return {
          ok: false,
          error: `policy route.on_window_exhausted.${route} is required; example: on_window_exhausted = { "${route}" = "stop" }`,
        };
    }
    const repoResult = await resolveAgxConfigWithProvenance(
      options.repoRoot ?? process.cwd(),
    );
    if (!repoResult.ok)
      return { ok: false, error: errorMessage(repoResult.error) };
    const repoRoute = repoResult.value.repoRoute;

    const catalog = catalogResult.data;
    // A repository [route] replaces only the keys it declares; the rest stay user-global.
    const allow = repoRoute?.allow ?? policy.route.allow;
    for (const route of allow) {
      if (policy.route.on_window_exhausted[route] === undefined)
        return {
          ok: false,
          error: `policy route.on_window_exhausted.${route} is required; example: on_window_exhausted = { "${route}" = "stop" }`,
        };
    }
    const ids = new Set(catalog.choice.map((row) => row.id));
    const unknownExcluded = policy.route.exclude.find((id) => !ids.has(id));
    if (unknownExcluded !== undefined) {
      return {
        ok: false,
        error: `exclude must name catalog rows: ${unknownExcluded}`,
      };
    }

    const choice = catalog.choice
      .filter((row) => !policy.route.exclude.includes(row.id))
      .flatMap((row) =>
        row.route === "claude-session"
          ? [row, { ...row, route: "claude-api" as const }]
          : [row],
      );
    const value = {
      schema: catalog.schema,
      as_of: catalog.as_of,
      ...(catalog.as_of_cost === undefined
        ? {}
        : { as_of_cost: catalog.as_of_cost }),
      auto: {
        routes: allow,
        ...(policy.route.on_window_exhausted === undefined
          ? {}
          : { on_window_exhausted: policy.route.on_window_exhausted }),
        max_task_chars: policy.route.max_task_chars,
        timeout_ms: policy.route.timeout_ms,
        pick_temperature: policy.route.pick_temperature,
        jev:
          policy.route.jev.api === "typesafe"
            ? { ...policy.route.jev, ...catalog.jev }
            : {
                api: "reseller" as const,
                url: policy.route.jev.url,
                ...catalog.jev,
              },
      },
      claude_run: policy.claude_run,
      sources: catalog.sources,
      choice,
    };
    const rosterResult = RosterSchema.safeParse(value);
    if (!rosterResult.success)
      return { ok: false, error: rosterResult.error.message };
    const generationError = generationExclusivityError({
      ...rosterResult.data,
      choice: catalog.choice,
    });
    if (generationError !== undefined)
      return { ok: false, error: generationError };
    return {
      ok: true,
      value: rosterResult.data,
      catalogRows: catalog.choice,
      provenance: {
        policy_version: createHash("sha256")
          .update(JSON.stringify({ policy, repoRoute: repoRoute ?? null }))
          .digest("hex"),
        catalog_version: createHash("sha256")
          .update(JSON.stringify(catalog))
          .digest("hex"),
        before: catalog.choice.map((row) => row.id),
        excluded: policy.route.exclude,
      },
      policy: {
        source: `file:${policyPath}`,
      },
    };
  }).then(
    (result) => result,
    (error: unknown): RosterLoad => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
