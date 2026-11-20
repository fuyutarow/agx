import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fnoxRecovery, resolveSecret } from "../src/typesafe-key.ts";

// stderr copied from fnox 1.50.0 for each failure; the fakes replay it so no real store is read.
const NO_CONFIG = `Error:   × No configuration file found in /somewhere/deep/home or
  │ any parent directory
  help: Run 'fnox init' to create a configuration file`;
const NO_SECRET = `Error: fnox::secret::not_found (https://fnox.jdx.dev/guide/what-is-fnox)

  × Secret 'DEMO_KEY' not found in profile 'default'
  │   (not defined in any config file)
  help: No configuration file found. Create one with:
          • fnox init`;
const SECRET = "demo-secret-value-0123456789";

let root = "";
let previousPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agx-typesafe-key-"));
  previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
});
afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
});

/** A fake fnox: `get` fails with `getErr` (or prints the secret), `provider list` prints `providers`. */
function fakeFnox(getErr: string | null, providers: string[] = []): void {
  writeFileSync(join(root, "get.err"), getErr ?? "");
  writeFileSync(
    join(root, "fnox"),
    [
      "#!/bin/sh",
      'if [ "$1" = provider ]; then',
      ...providers.map((name) => `  echo ${name}`),
      "  exit 0",
      "fi",
      getErr === null ? `echo ${SECRET}` : `cat '${root}/get.err' >&2; exit 1`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** The legacy file is never present in these cases. */
function noFile(): undefined {}

const lookup = () => resolveSecret("DEMO_KEY", {}, noFile, "demo file absent");

function refusal(): { reason: string; recover: string } {
  const result = lookup();
  // A resolved key yields a value no refusal assertion accepts; the key itself is not carried.
  if (result.ok)
    return { reason: `resolved from ${result.source}`, recover: "" };
  return {
    reason: result.reason,
    recover: fnoxRecovery("DEMO_KEY", result.fnox),
  };
}

test("no fnox config: the reason says so and the recovery creates the config, then stores the key", () => {
  fakeFnox(NO_CONFIG);
  expect(refusal()).toEqual({
    reason:
      "no DEMO_KEY (env unset; fnox has no config file; demo file absent)",
    recover: "fnox init -g && fnox set -g DEMO_KEY",
  });
});

test("config without the key: the recovery is the set line alone, naming the one provider", () => {
  fakeFnox(NO_SECRET, ["age"]);
  expect(refusal()).toEqual({
    reason:
      "no DEMO_KEY (env unset; fnox config has no DEMO_KEY; demo file absent)",
    recover: "fnox set -g DEMO_KEY --provider age",
  });
});

test("several or no providers are named as a choice instead of guessed", () => {
  fakeFnox(NO_SECRET, ["age", "keychain"]);
  expect(refusal().recover).toBe(
    "fnox set -g DEMO_KEY --provider <age|keychain>",
  );
  fakeFnox(NO_SECRET);
  expect(refusal().recover).toBe(
    "fnox provider add --global <name> <type> && fnox set -g DEMO_KEY --provider <name>",
  );
});

test("any other fnox failure keeps fnox's own first error and points at fnox doctor", () => {
  fakeFnox("Error: fnox::age::decrypt\n\n  × no identity matched\n");
  expect(refusal()).toEqual({
    reason:
      "no DEMO_KEY (env unset; fnox exit 1: no identity matched; demo file absent)",
    recover: "fnox doctor",
  });
});

test("a resolved key is returned and a refusal never contains a stored value", () => {
  fakeFnox(null);
  expect(lookup()).toEqual({ ok: true, key: SECRET, source: "fnox" });
  fakeFnox(NO_SECRET, ["age"]);
  expect(JSON.stringify(refusal())).not.toContain(SECRET);
});

test("fnox absent from PATH is named and the recovery installs it first", () => {
  process.env.PATH = root;
  expect(refusal()).toEqual({
    reason: "no DEMO_KEY (env unset; fnox not installed; demo file absent)",
    recover: "brew install fnox && fnox init -g && fnox set -g DEMO_KEY",
  });
});
