import { writeSync } from "node:fs";

/** Fatal messages written straight to the stderr fd, kept so a pre-launch guard can name the cause. */
export const fatalMessages: string[] = [];

export const exitWithError = (message: string, code: number): never => {
  fatalMessages.push(message);
  writeSync(process.stderr.fd, message);
  process.exit(code);
};
