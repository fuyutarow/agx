import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const sessionEnvironment = new Set([
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_HOME",
]);

export function clearInheritedAgentEnvironment(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of Object.keys(env))
    if (key.startsWith("AGX_") || sessionEnvironment.has(key)) delete env[key];
}

clearInheritedAgentEnvironment();
delete process.env.MISE_NO_CONFIG;
delete process.env.MISE_PARANOID;
for (const key of [
  "MISE_CONFIG_DIR",
  "MISE_GLOBAL_CONFIG_FILE",
  "MISE_STATE_DIR",
  "MISE_TRUSTED_CONFIG_PATHS",
])
  delete process.env[key];

const systemTempRoot = tmpdir();
const tempFromHome = relative(homedir(), systemTempRoot);
const tempRootIsInHome =
  tempFromHome === "" ||
  (!isAbsolute(tempFromHome) &&
    tempFromHome !== ".." &&
    !tempFromHome.startsWith(`..${sep}`));
// Test scratch under the real home can make mise discover host-global config despite path overrides.
if (process.platform !== "win32" && tempRootIsInHome)
  process.env.TMPDIR = "/tmp";

await import("./shared/src/test-tmp.ts");

const tempRoot = process.env.TMPDIR ?? tmpdir();

// Give agx a temporary default; fixtures can override it in their own child env.
const agxConfigDir = join(tempRoot, "agx-config");
await mkdir(agxConfigDir, { recursive: true });

const paths = {
  AGX_CONFIG: join(agxConfigDir, "agx.toml"),
};
await Bun.write(
  paths.AGX_CONFIG,
  await Bun.file(
    new URL("./agx-worker/src/roster/policy.example.toml", import.meta.url),
  ).text(),
);
Object.assign(process.env, paths);
