import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../state.ts";

function addFileCredential(environment: NodeJS.ProcessEnv): void {
  const keyPath = join(
    process.env.HOME ?? homedir(),
    ".config",
    "agx",
    "anthropic-api-key",
  );
  if (!existsSync(keyPath)) return;
  const stat = statSync(keyPath);
  if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) {
    process.stderr.write(
      "agx: anthropic-api-key must be a regular file with mode 0600; ignored\n",
    );
    return;
  }
  const key = readFileSync(keyPath, "utf8").trim();
  if (key === "") return;
  environment.ANTHROPIC_API_KEY = key;
  delete environment.ANTHROPIC_AUTH_TOKEN;
}

/** Apply the worker's credential policy to its child environment. */
export function claudeCredential(
  environment: NodeJS.ProcessEnv,
): "api_key" | "subscription" {
  const marker = join(stateDir(), "claude-credits-unavailable");
  const fresh =
    existsSync(marker) &&
    Temporal.Now.instant().epochMilliseconds - statSync(marker).mtimeMs <
      24 * 60 * 60 * 1000;
  if (fresh) {
    delete environment.ANTHROPIC_API_KEY;
    delete environment.ANTHROPIC_AUTH_TOKEN;
  } else addFileCredential(environment);
  return (environment.ANTHROPIC_API_KEY ?? "") !== "" ||
    (environment.ANTHROPIC_AUTH_TOKEN ?? "") !== ""
    ? "api_key"
    : "subscription";
}
