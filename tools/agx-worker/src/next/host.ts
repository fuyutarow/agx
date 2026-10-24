import { cli as cleyeCli } from "cleye";
import { standardCli } from "../../../shared/src/cli.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
  codexHostDeclarationPath,
  declareCodexHost,
  readCodexHostDeclaration,
} from "../workers/codex-host.ts";

/** Public projection of the same declaration reader used by Codex launch. */
export function host(args: string[]): number {
  const cli = standardCli(cleyeCli, packageJson, () => args);
  const parsed = cli(
    {
      name: "agx worker host",
      parameters: ["<action>"],
      strictFlags: true,
      flags: {
        json: { type: Boolean, description: "emit the versioned check result" },
        unsandboxedReason: {
          type: String,
          description: "why this host itself provides isolation (declare only)",
        },
      },
      help: { description: "check --json | declare --unsandboxed-reason TEXT" },
    },
    undefined,
    args,
  );
  const action = parsed._[0];
  if (
    !(
      (action === "check" &&
        parsed.flags.json === true &&
        parsed.flags.unsandboxedReason === undefined) ||
      (action === "declare" &&
        parsed.flags.unsandboxedReason !== undefined &&
        parsed.flags.json !== true)
    )
  ) {
    process.stderr.write(
      "agx worker host: use check --json or declare --unsandboxed-reason TEXT\n",
    );
    return 2;
  }
  const path = codexHostDeclarationPath();
  const result =
    action === "check"
      ? readCodexHostDeclaration(path)
      : declareCodexHost(path, parsed.flags.unsandboxedReason ?? "");
  if (action === "check") {
    process.stdout.write(
      `${JSON.stringify({
        schema: 1,
        path,
        status: result.kind,
        declaration:
          result.kind === "valid"
            ? {
                schema: 1,
                unsandboxed_reason: result.declaration.unsandboxedReason,
              }
            : null,
        reason: result.kind === "invalid" ? result.reason : null,
      })}\n`,
    );
  } else if (result.kind === "valid") {
    process.stdout.write(`${path}\n`);
  } else {
    process.stderr.write(
      `agx worker host declare: ${result.kind === "invalid" ? result.reason : "declaration disappeared after creation"}\n`,
    );
  }
  if (result.kind === "valid") return 0;
  return result.kind === "absent" && action === "check" ? 1 : 2;
}
