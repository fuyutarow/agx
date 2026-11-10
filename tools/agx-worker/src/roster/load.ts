import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "../../../shared/src/zod.ts";
import { attempt, errorMessage } from "../../../shared/src/attempt.ts";
import { resolveAgxConfigWithProvenance } from "../../../shared/src/agx-config.ts";

import { generationExclusivityError } from "./generation.ts";
import shippedCatalog from "./catalog.toml" with { type: "toml" };
import {
  POLICY_DEFAULTS,
  POLICY_KEYS,
  type PolicyKeySource,
} from "./policy-defaults.ts";

const RouteSchema = z.enum(["codex", "claude"]);
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

const JevEndpointPolicySchema = z.discriminatedUnion("api", [
  z.strictObject({
    api: z.literal("typesafe"),
    url: z.url(),
    model: z.string().min(1),
  }),
  z.strictObject({ api: z.literal("reseller"), url: z.url() }),
]);

const JevFileSchema = z.strictObject({
  api: z.enum(["typesafe", "reseller"]).optional(),
  url: z.url().optional(),
  model: z.string().min(1).optional(),
});

const ExhaustionSchema = z.strictObject({
  codex: z.enum(["continue", "stop"]).optional(),
  claude: z.enum(["continue", "stop"]).optional(),
});

const ClaudeRunSchema = z.strictObject({
  max_budget_usd: z.number().gt(0),
  max_turns: z.number().int().positive(),
  reason: z.string().min(20),
});

/** The policy file: every key and table is optional except `schema`; omitted keys take shipped defaults. */
const PolicySchema = z.strictObject({
  schema: z.literal(1),
  route: z
    .strictObject({
      allow: z.array(RouteSchema).min(1).optional(),
      on_window_exhausted: ExhaustionSchema.optional(),
      // Retired 2026-11-03: a default row would be silently substituted when Jev cannot route.
      default: z
        .never({
          error:
            "route.default was removed: agx never substitutes a row when Jev cannot route; delete the key",
        })
        .optional(),
      exclude: z.array(z.string()).optional(),
      max_task_chars: z.number().int().positive().optional(),
      timeout_ms: z.number().int().positive().optional(),
      // Retired 2026-11-10: routing never enforced it, so a file naming it is rejected.
      no_egress: z
        .never({
          error:
            "route.no_egress was removed: routing never enforced it; delete the key",
        })
        .optional(),
      pick_temperature: z.number().min(0).max(5).optional(),
      jev: JevFileSchema.optional(),
    })
    .optional(),
  claude_run: ClaudeRunSchema.partial().optional(),
});

const AutoSchema = z.strictObject({
  routes: z.array(RouteSchema).min(1),
  on_window_exhausted: z
    .strictObject({
      codex: z.enum(["continue", "stop"]).optional(),
      claude: z.enum(["continue", "stop"]).optional(),
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
        readonly keys: Readonly<Record<string, PolicyKeySource>>;
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

const MissingFileSchema = z.object({ code: z.literal("ENOENT") });
const isMissingFile = (error: unknown): boolean =>
  MissingFileSchema.safeParse(error).success;

/** A different api brings its own endpoint: shipped url and model belong to the typesafe shape. */
function jevCandidate(fileJev: z.output<typeof JevFileSchema> | undefined) {
  if (fileJev === undefined) return JevEndpointDefaults;
  if (fileJev.api !== undefined && fileJev.api !== JevEndpointDefaults.api)
    return fileJev;
  return { ...JevEndpointDefaults, ...fileJev };
}

async function parseToml(path: string): Promise<unknown> {
  return Bun.TOML.parse(await readFile(path, "utf8"));
}

type FilePolicy = z.output<typeof PolicySchema>;

const JevEndpointDefaults = POLICY_DEFAULTS.route.jev;

type ResolvedPolicy = Readonly<{
  schema: 1;
  route: Readonly<{
    allow: z.output<typeof RouteSchema>[] | undefined;
    on_window_exhausted: z.output<typeof ExhaustionSchema>;
    exclude: string[];
    max_task_chars: number;
    timeout_ms: number;
    pick_temperature: number;
    jev: z.output<typeof JevEndpointPolicySchema>;
  }>;
  claude_run: z.output<typeof ClaudeRunSchema>;
}>;

/** Overlays the file's keys on the shipped defaults and records each key's origin. */
function resolvePolicy(
  file: FilePolicy,
):
  | { ok: true; policy: ResolvedPolicy; keys: Record<string, PolicyKeySource> }
  | { ok: false; error: string } {
  const route = file.route ?? {};
  const run = file.claude_run ?? {};
  const fileJev = route.jev;
  const exhausted = route.on_window_exhausted ?? {};
  const jev = JevEndpointPolicySchema.safeParse(jevCandidate(fileJev));
  if (!jev.success)
    return { ok: false, error: `route.jev: ${jev.error.message}` };
  const defaults = POLICY_DEFAULTS;
  const policy: ResolvedPolicy = {
    schema: 1,
    route: {
      allow: route.allow,
      // Merged per vendor: a table naming one vendor keeps the shipped default for the other.
      on_window_exhausted: {
        codex: exhausted.codex ?? defaults.route.on_window_exhausted.codex,
        claude: exhausted.claude ?? defaults.route.on_window_exhausted.claude,
      },
      exclude: route.exclude ?? [...defaults.route.exclude],
      max_task_chars: route.max_task_chars ?? defaults.route.max_task_chars,
      timeout_ms: route.timeout_ms ?? defaults.route.timeout_ms,
      pick_temperature:
        route.pick_temperature ?? defaults.route.pick_temperature,
      jev: jev.data,
    },
    claude_run: {
      max_budget_usd: run.max_budget_usd ?? defaults.claude_run.max_budget_usd,
      max_turns: run.max_turns ?? defaults.claude_run.max_turns,
      reason: run.reason ?? defaults.claude_run.reason,
    },
  };
  const present: Readonly<Record<(typeof POLICY_KEYS)[number], boolean>> = {
    "route.allow": route.allow !== undefined,
    "route.on_window_exhausted.codex": exhausted.codex !== undefined,
    "route.on_window_exhausted.claude": exhausted.claude !== undefined,
    "route.exclude": route.exclude !== undefined,
    "route.max_task_chars": route.max_task_chars !== undefined,
    "route.timeout_ms": route.timeout_ms !== undefined,
    "route.pick_temperature": route.pick_temperature !== undefined,
    "route.jev": fileJev !== undefined,
    "claude_run.max_budget_usd": run.max_budget_usd !== undefined,
    "claude_run.max_turns": run.max_turns !== undefined,
    "claude_run.reason": run.reason !== undefined,
  };
  const keys: Record<string, PolicyKeySource> = {};
  for (const key of POLICY_KEYS) keys[key] = present[key] ? "file" : "default";
  return { ok: true, policy, keys };
}

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
    // Only an absent file at the default location falls back to shipped defaults.
    const useDefaults =
      !policyRaw.ok && !location.explicit && isMissingFile(policyRaw.error);
    if (!policyRaw.ok && !useDefaults)
      return {
        ok: false,
        error: `cannot read policy ${JSON.stringify(policyPath)}; see the distributed policy.example.toml: ${errorMessage(policyRaw.error).replaceAll(/[\r\n]+/gu, " ")}`,
      };
    const catalogResult = CatalogSchema.safeParse(catalogRaw);
    if (!catalogResult.success)
      return { ok: false, error: catalogResult.error.message };
    const policyResult = PolicySchema.safeParse(
      policyRaw.ok ? policyRaw.value : { schema: 1 },
    );
    if (!policyResult.success)
      return { ok: false, error: policyResult.error.message };
    const resolved = resolvePolicy(policyResult.data);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const repoResult = await resolveAgxConfigWithProvenance(
      options.repoRoot ?? process.cwd(),
    );
    if (!repoResult.ok)
      return { ok: false, error: errorMessage(repoResult.error) };
    const repoRoute = repoResult.value.repoRoute;

    const catalog = catalogResult.data;
    const policy = resolved.policy;
    // A repository [route] replaces only the keys it declares; the rest stay user-global.
    const allow = repoRoute?.allow ??
      policy.route.allow ?? [...POLICY_DEFAULTS.route.allow];
    const ids = new Set(catalog.choice.map((row) => row.id));
    const unknownExcluded = policy.route.exclude.find((id) => !ids.has(id));
    if (unknownExcluded !== undefined) {
      return {
        ok: false,
        error: `exclude must name catalog rows: ${unknownExcluded}`,
      };
    }

    const choice = catalog.choice.filter(
      (row) => !policy.route.exclude.includes(row.id),
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
        jev: { ...policy.route.jev, ...catalog.jev },
      },
      claude_run: policy.claude_run,
      sources: catalog.sources,
      choice,
    };
    const rosterResult = RosterSchema.safeParse(value);
    if (!rosterResult.success)
      return { ok: false, error: rosterResult.error.message };
    const generationError = generationExclusivityError(rosterResult.data);
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
        source: useDefaults ? "defaults" : `file:${policyPath}`,
        keys: resolved.keys,
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
