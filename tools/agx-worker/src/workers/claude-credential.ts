import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveSecret,
  type KeyLookup,
} from "../../../shared/src/typesafe-key.ts";
import { stateDir } from "../state.ts";

function fileCredential(): string | undefined {
  const keyPath = join(
    process.env.HOME ?? homedir(),
    ".config",
    "agx",
    "anthropic-api-key",
  );
  if (!existsSync(keyPath)) return undefined;
  const stat = statSync(keyPath);
  if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) {
    process.stderr.write(
      "agx: anthropic-api-key must be a regular file with mode 0600; ignored\n",
    );
    return undefined;
  }
  const key = readFileSync(keyPath, "utf8").trim();
  if (key === "") return undefined;
  return key;
}

export type CredentialSource = Extract<KeyLookup, { ok: true }>["source"];

/** Apply the worker's credential policy to its child environment. */
export function claudeCredential(
  environment: NodeJS.ProcessEnv,
): "api_key" | "subscription" {
  return claudeCredentialDetails(environment).credential;
}

export function claudeCredentialDetails(environment: NodeJS.ProcessEnv): {
  credential: "api_key" | "subscription";
  credential_source?: CredentialSource;
} {
  const marker = join(stateDir(), "claude-credits-unavailable");
  const fresh =
    existsSync(marker) &&
    Temporal.Now.instant().epochMilliseconds - statSync(marker).mtimeMs <
      24 * 60 * 60 * 1000;
  if (fresh) {
    delete environment.ANTHROPIC_API_KEY;
    delete environment.ANTHROPIC_AUTH_TOKEN;
    return { credential: "subscription" };
  }
  const key = resolveSecret(
    "ANTHROPIC_API_KEY",
    environment,
    fileCredential,
    "credential file absent or invalid",
  );
  if (key.ok) {
    environment.ANTHROPIC_API_KEY = key.key;
    delete environment.ANTHROPIC_AUTH_TOKEN;
    return { credential: "api_key", credential_source: key.source };
  }
  if ((environment.ANTHROPIC_AUTH_TOKEN ?? "") !== "")
    return { credential: "api_key", credential_source: "env" };
  return { credential: "subscription" };
}
