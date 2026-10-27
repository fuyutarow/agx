const isAgentSessionVariable = (name: string): boolean =>
  name.startsWith("CLAUDE_CODE_") ||
  name === "CLAUDECODE" ||
  name === "CLAUDE_PID" ||
  name.startsWith("CODEX_") ||
  name === "AGX_RUN_ID" ||
  name === "INVOCATION_ID";

export function subprocessEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const name of Object.keys(environment)) {
    if (isAgentSessionVariable(name) && !Object.hasOwn(overrides, name))
      delete environment[name];
  }
  return environment;
}
