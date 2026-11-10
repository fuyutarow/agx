#!/usr/bin/env bun
import type { Flags } from "./run.ts";
import { stopRun } from "./stop.ts";
import { waitRun } from "./wait.ts";
import { COMMAND_NAMES } from "./commands.ts";
import { cli as cleyeCli, command } from "cleye";
import { getFlag } from "type-flag";
import { standardCli } from "../../../shared/src/cli.ts";
import { exitWithError } from "./exit.ts";
import { flushRunPublications, stateDir } from "./store.ts";
import { jsonOf } from "../../../shared/src/zod.ts";
import { completeEndNotice, EndNoticeRequest } from "./end-notice.ts";
import packageJson from "../../package.json" with { type: "json" };
import { premiseHelp } from "../premises.ts";
import { CAPABILITIES_FORM } from "./ticket.ts";

const cliArgv = () => process.argv.slice(2);
const cli = standardCli(cleyeCli, packageJson, cliArgv);

const rejectPrototypeFlag = (type: string, flag: string): void => {
  if (type === "unknown-flag" && flag === "__proto__") {
    exitWithError(`agx: unknown option '--${flag}'\n`, 2);
  }
};
const ALL_COMMANDS = [...COMMAND_NAMES, "reclaim-runs"] as const;
const COMMAND_DESCRIPTIONS = {
  dispatch: "Select and dispatch a worker for a ticket.",
  run: "Run a worker for a ticket.",
  stop: "Stop a worker run.",
  check: "Check a ticket and its launch preflights.",
  ls: "List worker runs.",
  judge: "Record judgments on worker runs.",
  stats: "Show worker usage and routing statistics.",
  doctor: "Diagnose worker records.",
  roster: "Show worker routing selections or the roster.",
  config:
    "Show the effective configuration a dispatch would use, with each value's source.",
  host: "Check or declare host isolation.",
  probe: "Run a bounded Codex diagnostic.",
  "reclaim-runs": "Reclaim eligible old run files.",
} satisfies Record<(typeof ALL_COMMANDS)[number], string>;
export const COMMANDS = ALL_COMMANDS.map((name) => ({
  name,
  definition: command({
    name,
    help: { description: COMMAND_DESCRIPTIONS[name] },
    strictFlags: true,
    ignoreArgv: rejectPrototypeFlag,
  }),
}));

async function main(): Promise<void> {
  const rawArgs = cliArgv();
  if (rawArgs[0] === "--internal-end-notice") {
    const request = jsonOf(EndNoticeRequest).safeParse(rawArgs[1] ?? "");
    if (!request.success) {
      process.stderr.write("agx worker: invalid internal end notice request\n");
      process.exitCode = 1;
      return;
    }
    await completeEndNotice(request.data);
    // Nothing the sender left behind may keep the notice, or its unit, alive.
    process.exit(0);
  }
  if (rawArgs[0] === "--internal-codex") {
    process.argv.splice(2, 1);
    await import("../workers/codex.ts");
    return;
  }
  if (rawArgs[0] === "--internal-claude") {
    process.argv.splice(2, 1);
    const { runMain } = await import("../workers/run-claude.ts");
    await runMain();
    return;
  }
  const retiredFlag = rawArgs
    .slice(1, rawArgs.includes("--") ? rawArgs.indexOf("--") : undefined)
    .find(
      (arg) =>
        (rawArgs[0] === "ls" && /^--include-legacy(?:[=:.]|$)/u.test(arg)) ||
        (rawArgs[0] === "stats" && /^--import-legacy(?:[=:.]|$)/u.test(arg)),
    );
  if (retiredFlag !== undefined)
    exitWithError(`agx: unknown option '${retiredFlag}'\n`, 2);
  if (rawArgs[0] !== undefined && ALL_COMMANDS.map(String).includes(rawArgs[0]))
    stateDir();
  const root = cli(
    {
      name: "agx-worker",
      help: {
        description: packageJson.description,
      },
      parameters: [],
      strictFlags: true,
      ignoreArgv: rejectPrototypeFlag,
      commands: COMMANDS.map((entry) => entry.definition),
    },
    undefined,
    rawArgs.slice(0, 1),
  );
  await root;

  let exit = 2;
  const commandName = rawArgs[0];
  const commandArgs = rawArgs.slice(1);
  if (commandName === "reclaim-runs") {
    const noPins = commandArgs.includes("--no-pins");
    const parsed = cli(
      {
        name: "agx worker reclaim-runs",
        parameters: [],
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
        help: {
          description:
            "Default: report only; --apply moves eligible files. Shared reclaim grammar: tools/agx-worker/contract.md.\nExamples:\n  agx worker reclaim-runs --older-than 14\n  agx worker reclaim-runs --older-than 14 --apply --pin pins.txt\nUse --no-pins to explicitly apply without pins.",
        },
        flags: {
          olderThan: { type: Number, description: "minimum age in days" },
          apply: {
            type: Boolean,
            description: "move eligible files to the graveyard",
          },
          dryRun: { type: Boolean, description: "report only" },
          json: { type: Boolean, description: "emit rows and counts as JSON" },
          pin: {
            type: [String],
            description:
              "file containing absolute paths to protect (repeatable)",
          },
        },
      },
      undefined,
      commandArgs.filter((arg) => arg !== "--no-pins"),
    );
    if (parsed.flags.apply === true && parsed.flags.dryRun === true) {
      process.stderr.write(
        "agx worker reclaim-runs: --apply and --dry-run cannot be combined\n",
      );
      process.exitCode = 2;
      return;
    }
    const { reclaimRuns } = await import("./reclaim-runs.ts");
    process.exitCode = await reclaimRuns(
      parsed.flags.olderThan ?? Number.NaN,
      parsed.flags.apply === true,
      stateDir(),
      parsed.flags.pin ?? [],
      noPins,
      parsed.flags.json === true,
    );
    if (parsed.flags.json === true && process.exitCode === 1)
      process.stdout.write(
        JSON.stringify({ rows: [], counts: {}, broken: [], complete: false }) +
          "\n",
      );
    return;
  } else if (commandName === "probe") {
    const parsed = cli(
      {
        name: "agx worker probe",
        parameters: [],
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
        help: {
          description:
            "Run a bounded fixed Codex diagnostic without a ticket or run records.",
        },
        flags: {
          vendor: { type: String, description: "codex" },
          sandbox: {
            type: String,
            description: "none | read-only | workspace-write",
          },
          cd: { type: String, description: "existing target directory" },
          timeoutMs: {
            type: Number,
            description: "total execution deadline, 1..300000 ms",
          },
          json: {
            type: Boolean,
            description: "emit the schema 1 probe report",
          },
        },
      },
      undefined,
      commandArgs,
    );
    const { probe } = await import("./probe.ts");
    process.exitCode = await probe(parsed.flags, parsed._.length);
    return;
  } else if (commandName === "stop") {
    const parsed = cli(
      {
        name: "agx worker stop",
        parameters: ["<run>"],
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
        help: {
          description:
            "Stop an agx run by exact ID or unique prefix, recording who stopped it.",
        },
      },
      undefined,
      commandArgs,
    );
    const runId = parsed._.at(0);
    if (parsed._.length !== 1) {
      process.stderr.write("agx worker stop: expected one run ID\n");
      exit = 2;
    } else if (runId === undefined) {
      process.stderr.write("agx worker stop: expected one run ID\n");
      exit = 2;
    } else exit = await stopRun(runId);
  } else if (commandName === "host") {
    const { host } = await import("./host.ts");
    exit = host(commandArgs);
  } else if (commandName === "dispatch") {
    const { dispatchMain } = await import("../dispatch.ts");
    await dispatchMain(commandArgs);
    return;
  } else if (commandName === "run") {
    const parsed = cli(
      {
        name: "agx-worker run",
        help: {
          description:
            "To amend a continuation, edit the ticket file, then `agx worker run TICKET --continue RUN`.",
        },
        parameters: ["<ticket>"],
        flags: {
          cd: {
            type: String,
            description: "working tree for the worker and premises",
          },
          sandbox: {
            type: String,
            description: "none | read-only | workspace-write",
          },
          // Cleye has no hidden flag facility; help exits before these values are read.
          ...Object.defineProperty(
            {
              sandboxSource: {
                type: String,
                description: "internal sandbox provenance supplied by dispatch",
              },
            },
            "sandboxSource",
            {
              enumerable:
                getFlag("--help,-h", [Boolean], [...commandArgs]).at(-1) !==
                true,
            },
          ),
          continue: {
            type: String,
            description: "previous agx worker run id to continue",
          },
          supersedes: {
            type: String,
            description: "previous run replaced by this fresh dispatch",
          },
          session: {
            type: String,
            description: "dispatching Claude Code or Codex session id",
          },
          ...Object.defineProperty(
            {
              dispatchBinding: {
                type: String,
                description: "internal binding supplied by agx worker dispatch",
              },
            },
            "dispatchBinding",
            {
              enumerable:
                getFlag("--help,-h", [Boolean], [...commandArgs]).at(-1) !==
                true,
            },
          ),
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    const flags = {
      ticket: parsed._[0],
      cd: parsed.flags.cd,
      sandbox: parsed.flags.sandbox,
      sandboxSource: parsed.flags.sandboxSource,
      continue: parsed.flags["continue"],
      supersedes: parsed.flags.supersedes,
      session: parsed.flags.session,
      dispatchBinding: parsed.flags.dispatchBinding,
    } satisfies Flags;
    const { run, settleRunPublications } = await import("./run.ts");
    exit = await run(flags);
    // A run process ends with its run: publications still in flight get a short grace, then the
    // process exits (a pending one would hold the event loop, the workspace lock and the unit open).
    await settleRunPublications();
    await new Promise<void>((resolve) => {
      process.stdout.write("", () => {
        resolve();
      });
    });
    process.exit(exit);
  } else if (commandName === "check") {
    const parsed = cli(
      {
        name: "agx-worker check",
        help: {
          description: `${premiseHelp()}
Ticket min_effort = "low" | "medium" | "high" | "xhigh" | "max" sets a routing floor; xhigh/max requires a structured capability justification: ${CAPABILITIES_FORM}.`,
        },
        parameters: ["<ticket>"],
        flags: {
          json: {
            type: Boolean,
            description: "emit intake and preflight violations as JSON",
          },
          cd: {
            type: String,
            description:
              "target tree for all launch preflights (no reservation)",
          },
          sandbox: {
            type: String,
            description: "sandbox to validate against the ticket",
          },
          continue: {
            type: String,
            description: "previous run to validate for continuation",
          },
          supersedes: { type: String, description: "previous run to replace" },
          ...Object.defineProperty(
            {
              skipRouting: {
                type: Boolean,
                description:
                  "internal dispatch preflight; routing occurs in the run",
              },
            },
            "skipRouting",
            {
              enumerable:
                getFlag("--help,-h", [Boolean], [...commandArgs]).at(-1) !==
                true,
            },
          ),
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    const { check } = await import("./run.ts");
    exit = await check({
      ticket: parsed._[0],
      json: parsed.flags.json,
      cd: parsed.flags.cd,
      sandbox: parsed.flags.sandbox,
      continue: parsed.flags.continue,
      supersedes: parsed.flags.supersedes,
      skipRouting: parsed.flags.skipRouting,
    });
  } else if (commandName === "ls") {
    const parsed = cli(
      {
        name: "agx-worker ls",
        parameters: ["[selector]"],
        help: {
          description:
            "List runs newest first (last 30 by default; use --all for everything). SELECTOR is a run id/prefix or ticket name.",
        },
        flags: {
          ticket: {
            type: String,
            description: "exact ticket name for --latest",
          },
          latest: {
            type: Boolean,
            description: "show only the latest run for --ticket",
          },
          json: { type: Boolean, description: "emit the ls JSON contract" },
          summary: {
            type: Boolean,
            description:
              "with --json, include running counts by dispatcher session",
          },
          all: { type: Boolean, description: "show every run" },
          workspace: {
            type: String,
            description: "show runs for this real workspace path",
          },
          running: { type: Boolean, description: "show only live runs" },
          wait: {
            type: Boolean,
            description:
              "wait for the next ticket run to end; run ids return immediately when terminal (read-only)",
          },
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    if (parsed.flags.wait === true && parsed.flags.workspace !== undefined) {
      process.stderr.write("agx: --workspace cannot be combined with --wait\n");
      process.exitCode = 2;
      return;
    }
    const { list } = await import("./list-command.ts");
    exit =
      parsed.flags.wait === true
        ? await waitRun({
            selector: parsed._[0],
            json: parsed.flags.json === true,
          })
        : await list({
            ...parsed.flags,
            selector: parsed._[0],
          } satisfies Flags);
  } else if (commandName === "judge") {
    const parsed = cli(
      {
        name: "agx-worker judge",
        parameters: ["[run]", "[decision]"],
        flags: {
          from: {
            type: String,
            description: "read judgments as JSONL from file",
          },
          note: { type: String, description: "optional judgment note" },
          override: {
            type: String,
            description: "reason to accept an incomplete run",
          },
          evidence: {
            type: [String],
            description: "attach file sha256 and content (repeatable)",
          },
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    const { judgeRun, judgeBatch } = await import("./run.ts");
    const batchConflict =
      parsed._[0] !== undefined ||
      parsed._[1] !== undefined ||
      parsed.flags.note !== undefined ||
      parsed.flags.override !== undefined ||
      (parsed.flags.evidence?.length ?? 0) > 0;
    if (parsed.flags.from !== undefined && batchConflict) {
      process.stderr.write(
        "agx: --from cannot be combined with single-run arguments or flags\n",
      );
      exit = 2;
    } else if (parsed.flags.from !== undefined)
      exit = await judgeBatch(parsed.flags.from);
    else
      exit = await judgeRun({
        id: parsed._[0],
        decision: parsed._[1],
        note: parsed.flags.note,
        override: parsed.flags.override,
        evidence: parsed.flags.evidence,
      });
  } else if (commandName === "stats") {
    const parsed = cli(
      {
        name: "agx-worker stats",
        parameters: [],
        flags: {
          json: { type: Boolean, description: "JSON output (routing)" },
          usage: {
            type: String,
            description: "emit versioned Jev token usage JSON (--usage jev)",
          },
          routing: {
            type: Boolean,
            description: "emit versioned routing statistics JSON",
          },
          window: {
            type: String,
            description:
              "trailing window: positive integer with m, h or d (routing 24h; usage 7d)",
          },
          host: {
            type: String,
            description: "exact routing host name (default local hostname)",
          },
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    if (
      parsed._.length > 0 ||
      (parsed.flags.routing !== true && parsed.flags.json === true) ||
      (parsed.flags.usage !== undefined &&
        (parsed.flags.usage !== "jev" ||
          parsed.flags.routing === true ||
          parsed.flags.host !== undefined)) ||
      (parsed.flags.routing !== true && parsed.flags.host !== undefined) ||
      (parsed.flags.routing !== true &&
        parsed.flags.usage === undefined &&
        parsed.flags.window !== undefined)
    ) {
      process.stderr.write(
        "agx worker stats: --window requires --routing or --usage jev; --host and --json require --routing; usage and routing are exclusive; no positional arguments\n",
      );
      exit = 2;
    } else if (parsed.flags.usage === "jev") {
      const { jevUsageStats } = await import("./jev-usage.ts");
      exit = await jevUsageStats(parsed.flags.window ?? "7d");
    } else if (parsed.flags.routing === true) {
      const { routingStats } = await import("./routing-stats.ts");
      exit = await routingStats(
        parsed.flags.window ?? "24h",
        parsed.flags.host,
      );
    } else {
      const { stats } = await import("./run.ts");
      exit = await stats(parsed.flags satisfies Flags);
    }
  } else if (commandName === "doctor") {
    if (Object.hasOwn(process.env, "AGX_DOCTOR_QUIET")) {
      process.stderr.write(
        "agx-worker doctor: AGX_DOCTOR_QUIET is no longer supported; use --quiet\n",
      );
      process.exitCode = 2;
      return;
    }
    const parsed = cli(
      {
        name: "agx-worker doctor",
        flags: {
          quiet: {
            type: Boolean,
            description: "suppress the findings summary",
          },
        },
        parameters: [],
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
        help: {
          description:
            "Diagnose worker records as JSON Lines (tool, object, finding, remedy).",
        },
      },
      undefined,
      commandArgs,
    );
    const { doctor } = await import("./doctor.ts");
    exit = await doctor(parsed.flags.quiet === true);
  } else if (commandName === "roster") {
    const parsed = cli(
      {
        name: "agx-worker roster",
        help: {
          description:
            "Print one selected worker row for TICKET; --json without a ticket retains the full roster interface.",
        },
        parameters: ["[ticket]"],
        flags: {
          json: { type: Boolean, description: "emit the roster JSON" },
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    const { roster } = await import("./public.ts");
    if (parsed._[0] !== undefined) exit = await roster(parsed._[0]);
    else if (parsed.flags.json === true) exit = await roster();
    else {
      process.stderr.write("agx worker roster: use --json\n");
      exit = 2;
    }
  } else if (commandName === "config") {
    const parsed = cli(
      {
        name: "agx-worker config",
        help: {
          description:
            "Read-only: print every effective value a dispatch from --repo would use (repository L1/L2, user routing policy, Claude credential source) with where each came from. The API key is never shown.",
        },
        parameters: [],
        flags: {
          repo: {
            type: String,
            description: "repository path (default: the working directory)",
          },
          json: { type: Boolean, description: "emit one JSON object" },
        },
        strictFlags: true,
        ignoreArgv: rejectPrototypeFlag,
      },
      undefined,
      commandArgs,
    );
    const { configView } = await import("./config-view.ts");
    exit = await configView({
      repo: parsed.flags.repo,
      json: parsed.flags.json === true,
    });
  }
  await flushRunPublications();
  process.exitCode = exit;
}

if (import.meta.main) await main();
