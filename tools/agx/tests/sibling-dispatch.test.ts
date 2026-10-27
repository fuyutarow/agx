import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const entry = join(import.meta.dir, "../src/agx.ts");
const tools = ["worker", "ticket", "ws", "status", "msg"];
let root = "";
let binary = "";
let pathBin = "";

async function member(dir: string, tool: string, label: string) {
  await writeFile(
    join(dir, `agx-${tool}`),
    `#!${process.execPath}
if (process.argv[2] === "--help") {
  process.stdout.write("agx-${tool} 0.0.0\\n\\n${label} ${tool} description\\n");
} else {
  process.stdout.write(${JSON.stringify(label)} + " " + process.argv.slice(2).join("|") + "\\n");
  if (process.env.PROBE_STREAMS === "1") {
    process.stdout.write(await Bun.stdin.text());
    process.stderr.write("member stderr\\n");
  }
  process.exitCode = Number(process.env.MEMBER_EXIT ?? 0);
}
`,
    { mode: 0o755 },
  );
}

async function run(args: string[], path = "/usr/bin:/bin", probe = false) {
  const child = Bun.spawn([binary, ...args], {
    env: {
      ...subprocessEnvironment(),
      PATH: path,
      PROBE_STREAMS: probe ? "1" : "0",
      MEMBER_EXIT: probe ? "37" : "0",
    },
    stdin: probe ? new Response("member stdin\n") : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agx-sibling-"));
  const install = join(root, "install");
  pathBin = join(root, "path");
  await mkdir(install);
  await mkdir(pathBin);
  binary = join(install, "agx");
  const child = Bun.spawn(
    [process.execPath, "build", "--compile", entry, "--outfile", binary],
    { stdout: "pipe", stderr: "pipe", timeout: 60000 },
  );
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
  for (const tool of tools) {
    await member(install, tool, "sibling");
    await member(pathBin, tool, "PATH");
  }
}, 60000);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

test("compiled suite dispatches siblings with a system-only PATH and inherits streams and status", async () => {
  expect(await run(["worker", "--version"])).toEqual({
    stdout: "sibling --version\n",
    stderr: "",
    code: 0,
  });
  expect(
    await run(["worker", "a b", "--", "-Z", "雪"], undefined, true),
  ).toEqual({
    stdout: "sibling a b|--|-Z|雪\nmember stdin\n",
    stderr: "member stderr\n",
    code: 37,
  });
});

test("compiled suite prefers siblings over competing PATH members for dispatch and help", async () => {
  expect(await run(["worker", "--version"], pathBin)).toEqual({
    stdout: "sibling --version\n",
    stderr: "",
    code: 0,
  });
  for (const path of ["/usr/bin:/bin", pathBin]) {
    const result = await run(["--help"], path);
    expect(result.code, result.stderr).toBe(0);
    for (const tool of tools)
      expect(result.stdout).toContain(`  ${tool}  sibling ${tool} description`);
  }
});

test("compiled suite falls back to PATH for absent, non-executable, or directory siblings", async () => {
  const worker = join(root, "install/agx-worker");
  await rm(worker);
  expect((await run(["worker", "--version"], pathBin)).stdout).toBe(
    "PATH --version\n",
  );
  await member(join(root, "install"), "worker", "sibling");
  await chmod(worker, 0o644);
  expect((await run(["worker", "--version"], pathBin)).stdout).toBe(
    "PATH --version\n",
  );
  const help = await run(["--help"], pathBin);
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).toContain("  worker  PATH worker description");
  await rm(worker);
  await mkdir(worker);
  expect((await run(["worker", "--version"], pathBin)).stdout).toBe(
    "PATH --version\n",
  );
});
