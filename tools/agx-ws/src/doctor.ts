import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  agxRecords,
  classify,
  lineageOf,
  realOr,
  registeredRepoPaths,
  resolveRepo,
  trunkCommit,
  within,
  workspaces,
  type Classification,
  type RunRecord,
  type Workspace,
} from "./workspace.ts";
import { readConfig } from "./config.ts";
import { fromThrowable } from "../../shared/src/zod.ts";
import {
  attempt,
  errorMessage,
  type Attempt,
} from "../../shared/src/attempt.ts";

const bad = (message: string): Attempt<never> => ({
  ok: false,
  error: message,
});
const good = <T>(value: T): Attempt<T> => ({ ok: true, value });
const msg = (failed: { error: unknown }): string => errorMessage(failed.error);

async function doctorRepoPaths(): Promise<Attempt<string[]>> {
  const workspaceHome = process.env.AGX_REPOS_ROOT;
  if (workspaceHome === undefined) return registeredRepoPaths();
  const entries = await readdir(workspaceHome, { withFileTypes: true }).catch(
    () => [],
  );
  return good(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceHome, entry.name)),
  );
}

export type DoctorWorkspaceRow = {
  repo: string;
  dir: string;
  name: string;
  kind: "ws" | "outside";
  recorded: boolean;
  classification: Classification;
  ageMs: number | undefined;
};

async function appendWorkspaceRows(
  repo: Parameters<typeof workspaces>[0],
  candidates: Workspace[],
  config: Parameters<typeof classify>[1],
  records: RunRecord[],
  trunk: Parameters<typeof classify>[4],
  findingsOnly: boolean,
  rows: DoctorWorkspaceRow[],
): Promise<void> {
  const inRepo = candidates.filter((ws) =>
    within(realOr(ws.dir), realOr(repo.wsRoot)),
  );
  for (const ws of inRepo) {
    const info = await attempt(() => stat(ws.dir));
    const ageMs = info.ok
      ? Temporal.Now.instant().epochMilliseconds - info.value.mtimeMs
      : undefined;
    const recorded = lineageOf(records, realOr(ws.dir)).length > 0;
    const classification = await classify(
      repo,
      config,
      ws,
      records,
      trunk,
      true,
      findingsOnly &&
        recorded &&
        ageMs !== undefined &&
        ageMs <= 72 * 60 * 60 * 1000,
    );
    rows.push({
      repo: repo.backing,
      dir: ws.dir,
      name: ws.name,
      kind: "ws",
      recorded,
      classification,
      ageMs,
    });
  }
}

/** Read-only inventory built from the same workspaces and classifier as `agx ws gc --dry-run`. */
export async function doctorInventory(
  _root?: string,
  findingsOnly = false,
): Promise<Attempt<DoctorWorkspaceRow[]>> {
  const paths = await doctorRepoPaths();
  if (!paths.ok) return paths;
  const seen = new Set<string>();
  const rows: DoctorWorkspaceRow[] = [];
  let records: Attempt<RunRecord[]> | undefined;
  for (const path of paths.value) {
    const expanded = path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
    if (!(await Bun.file(join(expanded, ".git")).exists())) continue;
    const resolved = resolveRepo(expanded);
    if (!resolved.ok) return bad(`${path}: ${msg(resolved)}`);
    const repo = resolved.value;
    if (seen.has(repo.backing)) continue;
    seen.add(repo.backing);
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    const trunk = await trunkCommit(repo, cfg.value);
    if (!trunk.ok) return trunk;
    const candidates = await workspaces(repo);
    if (!candidates.ok) return candidates;
    // agx worker ls is a global run inventory, independent of repository cwd.
    records ??= await agxRecords(repo.backing);
    if (!records.ok) return records;
    await appendWorkspaceRows(
      repo,
      candidates.value,
      cfg.value,
      records.value,
      trunk.value,
      findingsOnly,
      rows,
    );
  }
  return good(rows);
}

const doctorClean = (value: string) => value.replaceAll(/[\t\r\n]/gu, " ");

export async function doctorSummaries() {
  const paths = await registeredRepoPaths();
  if (!paths.ok) return paths;
  const records = await agxRecords(process.cwd());
  if (!records.ok) return records;
  const summaries = [];
  for (const path of paths.value) {
    const resolved = resolveRepo(path);
    if (!resolved.ok) return resolved;
    const repo = resolved.value;
    const cfg = await readConfig(repo);
    if (!cfg.ok) return cfg;
    const candidates = await workspaces(repo);
    if (!candidates.ok) return candidates;
    const runs = records.value.filter(
      (run) =>
        run.state === "ended" &&
        run.returned !== undefined &&
        (run.judgment === null || run.judgment === undefined) &&
        (within(run.workspace, repo.backing) ||
          within(run.cwd, repo.backing) ||
          within(run.workspace, repo.wsRoot) ||
          within(run.cwd, repo.wsRoot) ||
          candidates.value.some(
            (ws) =>
              within(run.workspace, realOr(ws.dir)) ||
              within(run.cwd, realOr(ws.dir)),
          )),
    );
    const dates = runs.flatMap((run) => {
      const parsed = fromThrowable(
        () => Temporal.Instant.from(run.ended_at ?? "").epochMilliseconds,
      )();
      return parsed.isOk() ? [parsed.value] : [];
    });
    const age =
      dates.length === 0 || dates.length !== runs.length
        ? null
        : Math.max(
            0,
            (Temporal.Now.instant().epochMilliseconds - Math.min(...dates)) /
              3_600_000,
          );
    summaries.push({
      type: "workspace_summary" as const,
      repo: repo.backing,
      workspace_count: candidates.value.length,
      unjudged_returned_runs: runs.length,
      oldest_unjudged_age_hours: age,
      unjudged_warn_hours: cfg.value.unjudgedWarnHours ?? 24,
    });
  }
  return good(summaries);
}

/** Map gc classifier outcomes to doctor findings; kept rows remain deliberately silent. */
export async function doctor(): Promise<Attempt<string[]>> {
  const inventory = await doctorInventory(undefined, true);
  if (!inventory.ok) return inventory;
  return good(doctorFindings(inventory.value));
}

/** Findings count workspaces that the unattended `agx ws gc --apply --all` cannot collect. */
export function doctorFindings(rows: DoctorWorkspaceRow[]): string[] {
  const findings: string[] = [];
  for (const row of rows) {
    const c = row.classification;
    if (
      c.verdict === "kept" ||
      c.verdict === "keep" ||
      c.verdict === "land-temp"
    )
      continue;
    if (c.collect && c.verdict !== "abandoned" && row.recorded) continue;
    const emit = (finding: string, fix: string) => {
      findings.push(
        ["agx-ws", row.repo, row.name, finding, fix]
          .map((value) => doctorClean(value))
          .join("\t"),
      );
    };
    if (c.verdict === "stale") {
      const slug = row.name.startsWith("ws_") ? row.name.slice(3) : row.name;
      emit("stale", `agx ws refresh ${slug} --repo ${row.repo}`);
      continue;
    }
    if (c.verdict === "abandoned") {
      emit("abandoned", `agx ws gc --apply --abandoned --repo ${row.repo}`);
    } else if (c.verdict === "empty") {
      emit(
        "empty",
        `agx ws gc --apply --include-unrecorded --repo ${row.repo}`,
      );
    } else if (c.verdict === "landed") {
      emit(
        "collectable",
        `agx ws gc --apply --include-unrecorded --repo ${row.repo}`,
      );
    }
    if (
      c.verdict === "unlanded" &&
      row.ageMs !== undefined &&
      row.ageMs > 72 * 60 * 60 * 1000
    )
      emit("unlanded-72h", `cd ${row.dir} && mise run land`);
  }
  return findings;
}
