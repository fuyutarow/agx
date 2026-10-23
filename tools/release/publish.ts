import { cli } from "cleye";
import { publish } from "./release.ts";

const args = cli({
  name: "release:publish",
  parameters: ["<pkg>"],
  flags: {
    target: { type: String, description: "Bun compile target (default: host)" },
    dryRun: { type: Boolean, description: "Preview only (the default)" },
    yes: {
      type: Boolean,
      description:
        "Create tags and a draft, upload and verify assets, then publish",
    },
  },
  strictFlags: true,
  ignoreArgv(type, flag) {
    if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
  },
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
  const result = await publish(args._.pkg, args.flags.yes, args.flags.target);
  if (result.isErr()) {
    process.stderr.write(`FATAL: ${result.error}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `${result.value.dryRun ? "DRY RUN" : "PUBLISHED"}\n${result.value.assets.map((asset) => `${asset.archive}\nsha256 ${asset.sha256}`).join("\n")}\n${result.value.commands.join("\n")}\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
