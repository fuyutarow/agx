import { cli } from "cleye";
import { publishCI } from "./release.ts";

function rejectPrototypeFlag(type: unknown, flag: unknown) {
  if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
}

const args = cli({
  name: "release:ci",
  parameters: ["<tag>"],
  strictFlags: true,
  ignoreArgv: rejectPrototypeFlag,
});
async function main() {
  if (args._.length !== 1) {
    process.stderr.write("FATAL: Expected exactly one release tag\n");
    process.exitCode = 2;
    return;
  }
  const result = await publishCI(args._.tag);
  if (result.isErr()) {
    process.stderr.write(`FATAL: ${result.error}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`PUBLISHED\n${result.value.commands.join("\n")}\n`);
}
await main().catch((error: unknown) => {
  process.stderr.write(
    `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
