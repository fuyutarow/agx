import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  InspectionUnavailable,
  resolveAgxConfigWithProvenance,
  type ConfigLayer,
  type RepositoryValueKey,
  type ResolvedAgxConfigWithProvenance,
} from "../../../shared/src/agx-config.ts";
import { attempt, errorMessage } from "../../../shared/src/attempt.ts";
import { loadRoster, type RosterLoad } from "../roster/index.ts";
import { POLICY_KEYS } from "../roster/policy-defaults.ts";
import { workerEnvironment } from "../workers/environment.ts";
import {
  claudeCredentialDetails,
  creditsMarkerStatus,
} from "../workers/claude-credential.ts";

type Entry = { value: unknown; source: string };
type KeepEntry = { value: string; source: string; layers: ConfigLayer[] };
type Loaded = Extract<RosterLoad, { ok: true }>;

const oneLine = (text: string): string => text.replaceAll(/[\r\n]+/gu, " ");

/** `default`, `L1 <trunk agx.toml>` or `L2 <machine-local file>`. */
function layerSource(
  layer: ConfigLayer,
  config: ResolvedAgxConfigWithProvenance,
): string {
  if (layer === "L1") return `L1 ${config.l1Path ?? "agx.toml"}`;
  if (layer === "L2") return `L2 ${config.l2Path ?? "repos/*.toml"}`;
  return "default";
}

function repositorySection(config: ResolvedAgxConfigWithProvenance) {
  const entry = (key: RepositoryValueKey, value: unknown): Entry => ({
    value,
    source: layerSource(config.valueLayers[key], config),
  });
  const values: Record<string, Entry> = {
    tickets: entry("tickets", config.tickets),
    "ws.ready": entry("ws.ready", config.ready),
    "ws.trunk": entry("ws.trunk", config.trunk),
    "ws.regenerable": entry("ws.regenerable", config.regenerable),
    "ws.unjudged_warn_hours": entry(
      "ws.unjudged_warn_hours",
      config.unjudgedWarnHours,
    ),
    "verify.always": entry("verify.always", config.verifyAlways),
    "check.commands": entry("check.commands", config.checkCommands),
    "check.timeout_ms": entry(
      "check.timeout_ms",
      config.checkTimeoutMs ?? null,
    ),
    // null: no repository override, so the user policy (L3) decides the routes.
    "route.allow": entry("route.allow", config.repoRoute?.allow ?? null),
  };
  const keep: KeepEntry[] = config.keepEntries.map((item) => ({
    value: item.value,
    layers: item.layers,
    source: item.layers.map((layer) => layerSource(layer, config)).join(" + "),
  }));
  return {
    root: config.root,
    policy_source: config.policySource,
    policy_revision: config.policyRevision ?? null,
    working_copy_policy_differs: config.workingCopyPolicyDiffers ?? null,
    l1_path: config.l1Path ?? null,
    l2_path: config.l2Path ?? null,
    values,
    "ws.keep": { entries: keep },
  };
}

const keySource = (loaded: Loaded, key: string): string => {
  const origin = loaded.policy.keys[key];
  if (origin === "file")
    return loaded.policy.source.startsWith("file:")
      ? `L3 ${loaded.policy.source.slice(5)}`
      : "L3";
  return "default";
};

/** The user policy exactly as `roster --json` computes it, each key paired with its origin. */
function routingSection(
  loaded: Loaded,
  config: ResolvedAgxConfigWithProvenance,
) {
  const { auto, claude_run } = loaded.value;
  const allowSource =
    config.valueLayers["route.allow"] === "L1"
      ? layerSource("L1", config)
      : keySource(loaded, "route.allow");
  const valueOf: Record<(typeof POLICY_KEYS)[number], unknown> = {
    "route.allow": auto.routes,
    "route.on_window_exhausted.codex": auto.on_window_exhausted?.codex,
    "route.on_window_exhausted.claude": auto.on_window_exhausted?.claude,
    "route.exclude": loaded.provenance.excluded,
    "route.max_task_chars": auto.max_task_chars,
    "route.timeout_ms": auto.timeout_ms,
    "route.pick_temperature": auto.pick_temperature,
    "route.jev": auto.jev,
    "claude_run.max_budget_usd": claude_run.max_budget_usd,
    "claude_run.max_turns": claude_run.max_turns,
    "claude_run.reason": claude_run.reason,
  };
  const values: Record<string, Entry> = {};
  for (const key of POLICY_KEYS)
    values[key] = {
      value: valueOf[key],
      source: key === "route.allow" ? allowSource : keySource(loaded, key),
    };
  return {
    policy: loaded.policy,
    auto,
    claude_run,
    values,
  };
}

/** The credential a dispatch would pick; the key itself is resolved into a throwaway copy and dropped. */
function credentialSection() {
  const details = claudeCredentialDetails(workerEnvironment(process.env));
  const marker = creditsMarkerStatus();
  return {
    credential: details.credential,
    credential_source: details.credential_source ?? null,
    credits_unavailable_marker: {
      path: marker.path,
      present: marker.present,
      fresh: marker.fresh,
      expires_at: marker.expiresAt ?? null,
    },
  };
}

const markerText = (marker: {
  present: boolean;
  fresh: boolean;
  expires_at: string | null;
}): string => {
  if (marker.fresh) return `fresh until ${marker.expires_at}`;
  return marker.present ? "stale" : "absent";
};

const show = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");

const LONG_VALUE = 60;

/** Align key, value and `[source]`; a long value does not widen the value column. */
function rows(entries: Array<[string, string, string]>): string[] {
  const keyWidth = Math.max(0, ...entries.map(([key]) => key.length));
  const valueWidth = Math.max(
    0,
    ...entries.map(([, value]) => value.length).filter((n) => n <= LONG_VALUE),
  );
  return entries.map(([key, value, source]) => {
    const line = `  ${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}`;
    return source === "" ? line.trimEnd() : `${line}  [${source}]`;
  });
}

type View = {
  repository: ReturnType<typeof repositorySection>;
  routing: ReturnType<typeof routingSection>;
  credential: ReturnType<typeof credentialSection>;
};

function human(view: View): string {
  const repository: Array<[string, string, string]> = Object.entries(
    view.repository.values,
  ).map(([key, item]) => [key, show(item.value), item.source]);
  const keep: Array<[string, string, string]> = view.repository[
    "ws.keep"
  ].entries.map((item) => ["ws.keep", item.value, item.source]);
  if (keep.length === 0) keep.push(["ws.keep", "[]", "default"]);
  const routing: Array<[string, string, string]> = Object.entries(
    view.routing.values,
  ).map(([key, item]) => [
    key,
    item.value === undefined ? "-" : show(item.value),
    item.source,
  ]);
  const marker = view.credential.credits_unavailable_marker;
  const credential: Array<[string, string, string]> = [
    ["credential", view.credential.credential, ""],
    ["credential_source", view.credential.credential_source ?? "-", ""],
    ["credits-unavailable marker", markerText(marker), marker.path],
  ];
  const repo = view.repository;
  return [
    `Repository ${repo.root} (L1 trunk agx.toml, L2 machine-local; ${repo.policy_source})`,
    ...rows([...repository, ...keep]),
    "",
    `Routing (L3 user policy: ${view.routing.policy.source})`,
    ...rows(routing),
    "",
    "Credential (the key is never shown)",
    ...rows(credential),
    "",
  ].join("\n");
}

/** `agx worker config`: read-only; writes no file, starts no worker, calls no Jev. */
export async function configView(options: {
  repo?: string | undefined;
  json: boolean;
}): Promise<number> {
  const target = await attempt(() => realpath(resolve(options.repo ?? ".")));
  if (!target.ok) {
    process.stderr.write(
      `agx worker config: ${oneLine(errorMessage(target.error))}\n`,
    );
    return 2;
  }
  const config = await resolveAgxConfigWithProvenance(target.value);
  if (!config.ok) {
    process.stderr.write(
      `agx worker config: ${oneLine(errorMessage(config.error))}\n`,
    );
    return config.error instanceof InspectionUnavailable ? 75 : 2;
  }
  const loaded = await loadRoster({ repoRoot: target.value });
  if (!loaded.ok) {
    process.stderr.write(`agx worker config: ${oneLine(loaded.error)}\n`);
    return 2;
  }
  const view: View = {
    repository: repositorySection(config.value),
    routing: routingSection(loaded, config.value),
    credential: credentialSection(),
  };
  process.stdout.write(
    options.json ? `${JSON.stringify(view)}\n` : human(view),
  );
  return 0;
}
