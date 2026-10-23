import { cli } from "cleye";
import { build } from "./release.ts";

const args = cli({
  name: "release:build",
  parameters: ["<pkg>"],
  flags: {
    target: { type: String, description: "Bun compile target (default: host)" },
  },
  strictFlags: true,
  ignoreArgv(type, flag) {
    if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
  },
});

async function main() {
  if (args._.length !== 1) {
    process.stderr.write("FATAL: Expected exactly one package\n");
    process.exitCode = 2;
    return;
  }
  const result = await build(args._.pkg, args.flags.target);
  if (result.isErr()) {
    process.stderr.write(`FATAL: ${result.error}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `${result.value.archive}\nsha256 ${result.value.sha256}\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `FATAL: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
