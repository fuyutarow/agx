import { err } from "neverthrow";
import { cli } from "cleye";
import { machineSwap, packageInfo } from "./release.ts";

const args = cli({
  name: "release:machine",
  parameters: [],
  flags: {
    verifyIn: {
      type: [String],
      description: "Consumer directory (repeatable)",
    },
    waitSeconds: {
      type: Number,
      description: "Asset wait limit (seconds; default 900)",
    },
    pollSeconds: {
      type: Number,
      description: "Poll interval (seconds; default 5)",
    },
    formulaSeconds: {
      type: Number,
      description: "Tap formula wait limit (seconds; default 900)",
    },
  },
  strictFlags: true,
  ignoreArgv(type: unknown, flag: unknown) {
    if (type === "unknown-flag" && flag === "__proto__") process.exit(1);
  },
});

async function main() {
  if (args._.length > 0) return err("Expected flags only");
  const info = await packageInfo("agx");
  if (info.isErr()) return info;
  return machineSwap(info.value.version, args.flags);
}
await main()
  .then((result) => {
    if (result.isErr()) {
      process.stderr.write(`FATAL: ${result.error}\n`);
      process.exitCode = 1;
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
