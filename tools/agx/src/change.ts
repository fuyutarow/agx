import { readFileSync } from "node:fs";
import { cli as cleyeCli, command } from "cleye";
import { standardCli } from "../../shared/src/cli.ts";
import packageJson from "../package.json" with { type: "json" };

export const CHANGE_LAND_ENV = "AGX_CHANGE_LAND";

const rejectPrototypeFlag = (type: string, flag: string): void => {
  if (type === "unknown-flag" && flag === "__proto__") process.exit(2);
};

export function change(argv: string[]): void {
  const cli = standardCli(cleyeCli, packageJson, () => argv);
  const parsed = cli(
    {
      name: "agx change",
      help: {
        description:
          "Coordinate changes and reserve alpha pushes for agx change land.",
      },
      parameters: [],
      strictFlags: true,
      ignoreArgv: rejectPrototypeFlag,
      commands: [
        command({
          name: "hook",
          parameters: ["<event>", "[remote]", "[url]"],
          strictFlags: true,
          ignoreArgv: rejectPrototypeFlag,
          help: {
            description: "Run Git hook checks used by agx change.",
          },
        }),
      ],
    },
    undefined,
    argv,
  );
  if (
    parsed.command !== "hook" ||
    parsed._[0] !== "pre-push" ||
    (parsed._.length !== 1 && parsed._.length !== 3)
  ) {
    process.stderr.write(
      "agx change: expected `agx change hook pre-push [remote url]`\n",
    );
    process.exitCode = 2;
    return;
  }
  prePush();
}

function prePush(): void {
  const input = readFileSync(0, "utf8");
  if (process.env[CHANGE_LAND_ENV] === "1") return;

  for (const line of input.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) continue;
    const localObject = fields[1];
    const remoteRef = fields[2];
    const remoteObject = fields[3];
    if (
      localObject !== undefined &&
      remoteRef === "refs/heads/alpha" &&
      remoteObject !== undefined &&
      localObject !== remoteObject
    ) {
      process.stderr.write(
        "agx change hook pre-push: refusing to move remote trunk bookmark alpha; use agx change land\n",
      );
      process.exitCode = 1;
      return;
    }
  }
}
