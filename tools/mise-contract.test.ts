import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTools, commandFindings } from "./mise-contract.ts";

const scratch = await mkdtemp(join(tmpdir(), "command-contract-"));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("redirections are data while commands and substitutions remain audited", () => {
  const allowed = new Set(["sleep"]);
  for (const source of [
    'exec 2>&1; sh -c "$1"',
    'exec 9< "$1"; : > "$2"; sleep 10',
    "2>/dev/null sleep 1",
    "sleep 1>>output 2>&1",
  ])
    expect(commandFindings(source, allowed)).toEqual([]);
  for (const source of [
    "2>/dev/null unknown-tool",
    "sleep 1; unknown-tool 2>&1",
    "sleep 1 >$(unknown-tool)",
    'sh -c "unknown-tool 2>&1"',
  ])
    expect(commandFindings(source, allowed)).toContain(
      "undeclared command unknown-tool",
    );
});

test("host declarations and existing local binaries grant only named authority", async () => {
  await Bun.write(
    join(scratch, "mise.toml"),
    `
[tools]
bun = "1.4.3"
[vars]
"host_command:host-tool" = "Optional host integration"
`,
  );
  await Bun.write(
    join(scratch, "package.json"),
    JSON.stringify({
      bin: { "local-tool": "entry.ts", "missing-tool": "missing.ts" },
    }),
  );
  await Bun.write(
    join(scratch, "entry.ts"),
    `
Bun.spawn(["host-tool"]);
Bun.spawn(["local-tool"]);
Bun.spawn(["unknown-tool"]);
`,
  );
  expect(await checkTools(scratch)).toEqual([
    "invalid local binary missing-tool: missing.ts",
    "entry.ts: undeclared command unknown-tool",
  ]);
  await Bun.write(
    join(scratch, "mise.toml"),
    `
[tools]
bun = "1.4.3"
[vars]
"host_command:host-tool" = ""
`,
  );
  expect(await checkTools(scratch)).toContain(
    "invalid host command declaration host_command:host-tool",
  );
});
