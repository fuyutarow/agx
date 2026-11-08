import { afterEach, beforeEach } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
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

async function guardReasonNetwork(root: string): Promise<void> {
  const bin = join(root, "guard-bin");
  await mkdir(bin, { recursive: true });
  const stub = join(bin, "reason-network");
  await Bun.write(
    stub,
    "#!/bin/sh\nprintf '%s\\n' 'agx tests must not run the real reason-network; put a fake on PATH' >&2\nexit 97\n",
  );
  await chmod(stub, 0o755);
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
}

await guardReasonNetwork(tempRoot);
let previousPath: string | undefined;
beforeEach(async () => {
  previousPath = process.env.PATH;
  await guardReasonNetwork(tmpdir());
});
afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
});

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
