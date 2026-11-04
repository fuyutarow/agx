import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadRoster } from "../../src/roster/load.ts";

const catalogPath = join(import.meta.dir, "../../src/roster/catalog.toml");
const examplePath = join(
  import.meta.dir,
  "../../src/roster/policy.example.toml",
);
const tempDirs: string[] = [];

async function withPolicy(contents: string) {
  const directory = await mkdtemp(join(tmpdir(), "agx-roster-test-"));
  tempDirs.push(directory);
  const policyPath = join(directory, "agx.toml");
  await writeFile(policyPath, contents, "utf8");
  return loadRoster({ catalogPath, policyPath });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("roster loader", () => {
  test("default may be omitted and is omitted from JSON", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace('default = "luna-high"\n', ""),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(JSON.parse(JSON.stringify(result.value))).not.toHaveProperty(
        "default",
      );
  });

  test("configured default remains in JSON", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(example);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(JSON.parse(JSON.stringify(result.value)).default).toBe(
        "luna-high",
      );
  });
  test("exclude removes a catalog row", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace("exclude = []", 'exclude = ["luna-low"]'),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.choice.some((row) => row.id === "luna-low")).toBe(
        false,
      );
  });

  test("unknown policy keys are rejected", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace("[route]\n", "[route]\nunknown = true\n"),
    );
    expect(result.ok).toBe(false);
  });

  test("missing policy schema is rejected", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(example.replace("schema = 1\n", ""));
    expect(result.ok).toBe(false);
  });

  test("unknown default is rejected", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace('default = "luna-high"', 'default = "missing-row"'),
    );
    expect(result.ok).toBe(false);
  });

  test("policy cannot change a catalog price", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace("[route]\n", "[route]\nprice_in = 999\n"),
    );
    expect(result.ok).toBe(false);
  });

  test("user default on a route the user allow excludes is rejected", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace('allow = ["codex"]', 'allow = ["claude"]'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain("non-excluded row on an allowed route");
  });

  test("user default on an allowed claude route is accepted", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example
        .replace('allow = ["codex"]', 'allow = ["claude"]')
        .replace('default = "luna-high"', 'default = "haiku-low"'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.default).toBe("haiku-low");
  });

  test("user default must be non-excluded", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example.replace("exclude = []", 'exclude = ["luna-high"]'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain("non-excluded row on an allowed route");
  });

  test("without a user allow, any route's catalog row may be the default", async () => {
    const example = await readFile(examplePath, "utf8");
    const result = await withPolicy(
      example
        .replace('allow = ["codex"]\n', "")
        .replace('default = "luna-high"', 'default = "haiku-low"'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.default).toBe("haiku-low");
  });
});
