import { cli } from "cleye";
import { publish } from "./release.ts";

function rejectPrototypeFlag(type: unknown, flag: unknown) {
  if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
}

const args = cli({
  name: "release:publish",
  parameters: ["<pkg>"],
  flags: {
    verifyIn: {
      type: [String],
      description:
        "Consumer directory to verify (repeatable; home is always checked)",
    },
    waitSeconds: {
      type: Number,
      description: "Asset wait limit in seconds (default: 900)",
    },
    pollSeconds: {
      type: Number,
      description: "Asset poll interval in seconds (default: 5)",
    },
    installSeconds: {
      type: Number,
      description: "Suite install limit in seconds (default: 900)",
    },
    target: { type: String, description: "Bun compile target (default: host)" },
    dryRun: { type: Boolean, description: "Preview only (the default)" },
    yes: {
      type: Boolean,
      description:
        "Push alpha and both release tags; CI builds and uploads assets",
    },
  },
  strictFlags: true,
  ignoreArgv: rejectPrototypeFlag,
});

async function main() {
  if (
    args._.length !== 1 ||
    (args.flags.yes === true && args.flags.dryRun === true)
  ) {
    process.stderr.write(
      "FATAL: Expected one package; --yes and --dry-run are mutually exclusive\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = await publish(
    args._.pkg,
    args.flags.yes,
    args.flags.target,
    undefined,
    undefined,
    {
      verifyIn: args.flags.verifyIn,
      waitSeconds: args.flags.waitSeconds,
      pollSeconds: args.flags.pollSeconds,
      installSeconds: args.flags.installSeconds,
    },
  );
  if (result.isErr()) {
    process.stderr.write(`FATAL: ${result.error}\n`);
    process.exitCode = /^(asset-wait|install|verify) /u.test(result.error)
      ? 1
      : 2;
    return;
  }
  process.stdout.write(
    `${result.value.dryRun ? "DRY RUN" : "COMPLETE"}\n${result.value.workflowUrl}\n${result.value.commands.join("\n")}\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
