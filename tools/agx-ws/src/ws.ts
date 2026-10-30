#!/usr/bin/env bun
import { doctorOutput } from "../../shared/src/doctor-record.ts";
import { cli as cleyeCli, command } from "cleye";
import { standardCli } from "../../shared/src/cli.ts";
import { StepFailure } from "./subprocess.ts";
import { enterStep, runAddCommand } from "./deadline.ts";
import { errorMessage } from "../../shared/src/attempt.ts";
import packageJson from "../package.json" with { type: "json" };
import {
  add,
  adopt,
  doctor as doctorWorkspaces,
  doctorSummaries,
  gc,
  gcAll,
  harvest,
  LegacyWorkspaceConfigError,
  refresh,
  remove,
} from "./workspace.ts";

import { checkState } from "./state-dir.ts";

await checkState();

const cliArgv = () => process.argv.slice(2);
const cli = standardCli(cleyeCli, packageJson, cliArgv);

const failureExitCode = (error: unknown): number => {
  if (error instanceof LegacyWorkspaceConfigError) return 2;
  if (error instanceof StepFailure) return error.code;
  return 1;
};

const rejectPrototypeFlag = (type: string, flag: string): void => {
  if (type === "unknown-flag" && flag === "__proto__") {
    process.stderr.write("ws: unknown option '--__proto__'\n");
    process.exit(2);
  }
};

const fail = (error: unknown): void => {
  process.stderr.write(`ws: ${errorMessage(error)}\n`);
  process.exitCode = failureExitCode(error);
};

const repoFlag = {
  type: String,
  description:
    "any workspace or the main checkout of the repository (default: cwd)",
} as const;

const addCommand = command(
  {
    name: "add",
    parameters: ["<slug>"],
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: {
      description:
        "The only workspace creator: create <repo>.ws/ws_<slug>, trust its mise.toml or .mise.toml, then run readiness commands from agx.toml [ws].ready.",
    },
    flags: {
      rev: {
        type: String,
        description: "parent revision (default: jj's own default)",
      },
      noFetch: {
        type: Boolean,
        description:
          "skip remote fetch and report the selected base as unfetched",
      },
      repo: repoFlag,
      json: {
        type: Boolean,
        description:
          "print a JSON workspace object; readiness output goes to stderr",
      },
      reuse: {
        type: Boolean,
        description:
          "return an already registered workspace without changing it",
      },
    },
  },
  async (argv) =>
    runAddCommand(async () => {
      const done = await add({
        slug: argv._.slug,
        rev: argv.flags.rev,
        noFetch: argv.flags.noFetch === true,
        repo: argv.flags.repo ?? process.cwd(),
        reuse: argv.flags.reuse === true,
        json: argv.flags.json === true,
      });
      if (!done.ok) {
        enterStep("write failure diagnostic");
        await new Promise<void>((resolve) => {
          process.stderr.write(`ws: ${errorMessage(done.error)}\n`, () => {
            resolve();
          });
        });
        process.exitCode = failureExitCode(done.error);
        return;
      }
      enterStep("write workspace result");
      if (argv.flags.json !== true && done.value.base !== undefined) {
        const base = done.value.base;
        process.stderr.write(
          `ws: base change_id=${base.change_id} commit_id=${base.commit_id} ref=${base.ref} fetch=${base.fetch}\n`,
        );
      }
      process.stderr.write(`ws: policy source: ${done.value.policy_source}\n`);
      await new Promise<void>((resolve) => {
        process.stdout.write(
          `${argv.flags.json === true ? JSON.stringify(done.value) : done.value.workspace}\n`,
          () => {
            resolve();
          },
        );
      });
    }),
);

const adoptCommand = command(
  {
    name: "adopt",
    parameters: ["[path]"],
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: {
      description:
        "Re-home a jj workspace into <repo>.ws/ws_<hyphen-slug>, stripping legacy layout prefixes and preserving its change. TSV: old path, target path, verdict and reason. Refuses processes inside and existing targets.",
    },
    flags: {
      repo: repoFlag,
      slug: {
        type: String,
        description:
          "override the old basename; normalized to lowercase hyphen words",
      },
      all: {
        type: Boolean,
        description: "adopt every legacy workspace; requires --repo",
      },
      fixNames: {
        type: Boolean,
        description:
          "re-home ws_<repo>-arm-* workspaces to stripped names; requires --repo",
      },
      dryRun: {
        type: Boolean,
        description: "read-only TSV plan; move nothing",
      },
      includeKept: {
        type: Boolean,
        description: "include [ws].keep entries and print required updates",
      },
    },
  },
  async (argv) => {
    const done = await adopt({
      path: argv._.path,
      repo: argv.flags.repo,
      slug: argv.flags.slug,
      all: argv.flags.all === true,
      fixNames: argv.flags.fixNames === true,
      dryRun: argv.flags.dryRun === true,
      includeKept: argv.flags.includeKept === true,
    });
    if (!done.ok) {
      fail(done.error);
      return;
    }
    for (const line of done.value.lines) process.stdout.write(`${line}\n`);
    if (argv.flags.dryRun !== true && done.value.failed.length > 0)
      fail(`could not adopt: ${done.value.failed.join(", ")}`);
  },
);

const rmCommand = command(
  {
    name: "rm",
    parameters: ["<slug>"],
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: {
      description:
        "Forget and rip ws_<slug>. A change is landed if reachable from trunk or a remote bookmark, or if its content already landed on trunk; its commit need not be a trunk ancestor.",
    },
    flags: {
      repo: repoFlag,
      discardBroken: {
        type: Boolean,
        description: "save broken workspace working-copy differences to $AGX_STATE_DIR/ws-rm/<slug>-<UTC>-<UUID>.patch (default state dir: ~/.local/state/agx; XDG_STATE_HOME overrides ~/.local/state), then remove it",
      },
    },
  },
  async (argv) => {
    const done = await remove({
      slug: argv._.slug,
      repo: argv.flags.repo ?? process.cwd(),
      discardBroken: argv.flags.discardBroken === true,
    });
    if (!done.ok) {
      fail(done.error);
      return;
    }
    process.stdout.write(`removed\t${done.value}\n`);
  },
);

const refreshCommand = command(
  {
    name: "refresh",
    parameters: ["<slug>"],
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: {
      description:
        "Update ws_<slug> if jj reports it stale; do not run readiness commands or change sparse patterns.",
    },
    flags: { repo: repoFlag },
  },
  async (argv) => {
    const done = await refresh({
      slug: argv._.slug,
      repo: argv.flags.repo ?? process.cwd(),
    });
    if (!done.ok) {
      fail(done.error);
      return;
    }
    process.stdout.write(`refreshed\t${done.value}\n`);
  },
);

const gcCommand = command(
  {
    name: "gc",
    parameters: [],
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: {
      description:
        'Enumerate jj workspaces. Print TSV: path, kind, verdict, change id, age, reason. Exit 1 for failed collection or broken workspaces; refused repositories exit 2. Legacy workspaces are report-only until --legacy. Keep a workspace by setting `keep = ["ws_<name>"]` under `[ws]` in the main checkout root `agx.toml` (example: `keep = ["ws_reference"]`). Machine-local keep entries live under `[ws]` in `$XDG_CONFIG_HOME/agx/repos/<name>.toml`. agx ws add is the only creator.',
    },
    flags: {
      dryRun: { type: Boolean, description: "report only; remove nothing" },
      json: {
        type: Boolean,
        description: "emit rows and authoritative verdict counts",
      },
      legacy: {
        type: Boolean,
        description: "also forget and rip empty or landed legacy workspaces",
      },
      abandoned: {
        type: Boolean,
        description:
          "also collect workspaces whose runs all ended without acceptance over 24h ago; legacy layouts also need --legacy",
      },
      all: {
        type: Boolean,
        description:
          "visit repositories discovered from creation state, all run records and L2 policy",
      },
      includeUnrecorded: {
        type: Boolean,
        description:
          "also collect workspaces with no agx record when they have no diff",
      },
      graceMinutes: {
        type: Number,
        description:
          "protect workspaces younger than this many minutes (default: 30; 0 disables)",
      },
      inventorySeconds: {
        type: Number,
        description:
          "limit untracked-file inventory to this many seconds per workspace (default: 10)",
      },
      inventoryBudgetSeconds: {
        type: Number,
        description:
          "limit total untracked-file inventory time per repository (default: 120 seconds)",
      },
      repo: repoFlag,
    },
  },
  async (argv) => {
    if (argv.flags.all === true && argv.flags.repo !== undefined) {
      fail("--all and --repo cannot be combined");
      return;
    }
    if (
      argv.flags.graceMinutes !== undefined &&
      (!Number.isSafeInteger(argv.flags.graceMinutes) ||
        argv.flags.graceMinutes < 0)
    ) {
      fail("--grace-minutes must be a non-negative integer");
      return;
    }
    if (
      argv.flags.inventorySeconds !== undefined &&
      (!Number.isSafeInteger(argv.flags.inventorySeconds) ||
        argv.flags.inventorySeconds < 1 ||
        argv.flags.inventorySeconds > 2_147_483)
    ) {
      fail("--inventory-seconds must be an integer from 1 to 2147483");
      return;
    }
    if (
      argv.flags.inventoryBudgetSeconds !== undefined &&
      (!Number.isSafeInteger(argv.flags.inventoryBudgetSeconds) ||
        argv.flags.inventoryBudgetSeconds < 1 ||
        argv.flags.inventoryBudgetSeconds > 86400)
    ) {
      fail("--inventory-budget-seconds must be an integer from 1 to 86400");
      return;
    }
    const options = {
      dryRun: argv.flags.dryRun === true,
      includeUnrecorded: argv.flags.includeUnrecorded === true,
      legacy: argv.flags.legacy === true,
      abandoned: argv.flags.abandoned === true,
      graceMinutes: argv.flags.graceMinutes ?? 30,
      inventorySeconds: argv.flags.inventorySeconds ?? 10,
      inventoryBudgetSeconds: argv.flags.inventoryBudgetSeconds ?? 120,
    };
    const done = await (argv.flags.all === true
      ? gcAll(options)
      : gc({ ...options, repo: argv.flags.repo ?? process.cwd() }));
    if (!done.ok) {
      fail(done.error);
      return;
    }
    if (argv.flags.json === true) {
      const rows = done.value.lines.map((line) => line.split("\t"));
      process.stdout.write(
        JSON.stringify({
          rows,
          counts: done.value.counts,
          broken: done.value.broken,
          refused: done.value.refused ?? [],
          complete: done.value.complete,
          repositories: done.value.repositories,
          discovery: done.value.discovery,
        }) + "\n",
      );
    } else {
      if (done.value.discovery !== undefined)
        process.stdout.write(
          `discovery\t${JSON.stringify(done.value.discovery)}\n`,
        );
      for (const repo of (done.value.repositories ?? []).filter(
        (candidate) => candidate.status !== "refused",
      )) {
        const { total, unlanded, collectable, legacy } = repo.counts;
        process.stdout.write(
          `${repo.root}\trepo\t${repo.status}\t${repo.sources.join(",")}\t${JSON.stringify({ total, unlanded, collectable, legacy })}\n`,
        );
      }
      for (const line of done.value.lines) process.stdout.write(`${line}\n`);
    }
    if (done.value.failed.length > 0)
      fail(`could not collect: ${done.value.failed.join(", ")}`);
    if (done.value.broken.length > 0)
      fail(`broken workspaces: ${done.value.broken.join(", ")}`);
    if ((done.value.refused?.length ?? 0) > 0) process.exitCode = 2;
  },
);

const harvestCommand = command(
  {
    name: "harvest",
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: {
      description:
        "Copy ended runs' workspace results into their run directories without changing the workspace.",
    },
    flags: {
      repo: repoFlag,
      all: { type: Boolean, description: "use gc's repository discovery" },
      dryRun: {
        type: Boolean,
        description: "list files and bytes; copy nothing",
      },
      json: {
        type: Boolean,
        description: "emit per-run file plans and totals",
      },
    },
  },
  async (argv) => {
    const done = await harvest({
      repo: argv.flags.repo,
      all: argv.flags.all,
      dryRun: argv.flags.dryRun,
    });
    if (!done.ok) {
      fail(done.error);
      return;
    }
    if (argv.flags.json === true)
      process.stdout.write(JSON.stringify(done.value) + "\n");
    else {
      for (const run of done.value.runs) {
        run.files.forEach((file) => {
          process.stdout.write(
            [run.id, run.workspace, file.path, file.bytes].join("\t") + "\n",
          );
        });
        process.stdout.write(
          [
            run.id,
            "summary",
            run.files.length,
            run.bytes,
            "skipped",
            run.skipped,
          ].join("\t") + "\n",
        );
      }
    }
  },
);

const doctorCommand = command(
  {
    name: "doctor",
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
    help: { description: "Read-only registered workspace inventory." },
    flags: {
      quiet: { type: Boolean, description: "suppress the findings summary" },
    },
  },
  async (argv) => {
    if (Object.hasOwn(process.env, "AGX_DOCTOR_QUIET")) {
      process.stderr.write(
        "agx ws doctor: AGX_DOCTOR_QUIET is no longer supported; use --quiet\n",
      );
      process.exitCode = 2;
      return;
    }
    const done = await doctorWorkspaces();
    if (!done.ok) {
      fail(done.error);
      if (
        argv.flags.quiet !== true &&
        !(done.error instanceof LegacyWorkspaceConfigError)
      )
        process.stderr.write("agx ws doctor: error\n");
      return;
    }
    const summaries = await doctorSummaries();
    if (!summaries.ok) { fail(summaries.error); return; }
    for (const summary of summaries.value) {
      process.stdout.write(JSON.stringify(summary) + "\n");
      if (summary.oldest_unjudged_age_hours !== null && summary.oldest_unjudged_age_hours > summary.unjudged_warn_hours)
        done.value.push(["agx-ws", summary.repo, "runs", "unjudged-age", `judge returned runs older than ${summary.unjudged_warn_hours} hours`].join("\t"));
    }
    const output = doctorOutput(done.value);
    if (!output.ok) {
      fail(output.error);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(output.value);
    if (argv.flags.quiet !== true)
      process.stderr.write(`agx ws doctor: ${done.value.length} finding(s)\n`);
    process.exitCode = done.value.length === 0 ? 0 : 1;
  },
);

void cli({
  name: "agx-ws",
  version: packageJson.version,
  help: { description: "Create, inspect and collect repository workspaces." },
  strictFlags: true,
  ignoreArgv: rejectPrototypeFlag,
  commands: [
    addCommand,
    adoptCommand,
    refreshCommand,
    rmCommand,
    gcCommand,
    harvestCommand,
    doctorCommand,
  ],
});
