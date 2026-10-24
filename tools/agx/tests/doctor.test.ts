import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoctorAggregate } from "../../shared/src/doctor-aggregate.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";

const entry = join(import.meta.dir, "../src/agx.ts");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agx-doctor-"));
  const state = join(root, "state");
  await mkdir(state);
  const env = {
    ...process.env,
    AGX_STATE_DIR: state,
    XDG_STATE_HOME: join(root, "xdg"),
    AGX_NEXT_STATE_DIR: undefined,
    PATH: root,
  };
  const member = async (tool: string, body: string) =>
    writeFile(
      join(root, `agx-${tool}`),
      `#!${process.execPath}\nif (process.argv.slice(2).join(" ") !== "doctor --quiet") process.exit(99);\n${body}`,
      { mode: 0o755 },
    );
  for (const tool of ["worker", "ws", "ticket"])
    await member(tool, "process.exitCode = 0;");
  const run = async (args = ["doctor", "--json"]) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const [stdout, stderr, exit] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  return {
    root,
    state,
    member,
    run,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}
function decode(text: string): DoctorAggregate {
  const result = jsonOf(DoctorAggregate).safeParse(text);
  expect(result.success).toBe(true);
  return result.success
    ? result.data
    : {
        schema: 1,
        findings: [],
        kinds: {},
        total: 0,
        lost: 0,
        complete: false,
        captured_at: 0,
        members: [],
      };
}
const finding = {
  tool: "agx-worker",
  object: "fixture/run",
  finding: "lost",
  remedy: "agx worker judge fixture reject",
};
const emit = `process.stdout.write(${JSON.stringify(JSON.stringify(finding) + "\n")});`;

test("public doctor refreshes, publishes exact output, and status reads the owned aggregate", async () => {
  await using f = await fixture();
  const clean = await f.run();
  expect(clean.exit, clean.stderr).toBe(0);
  expect(decode(clean.stdout)).toMatchObject({
    schema: 1,
    findings: [],
    kinds: {},
    total: 0,
    lost: 0,
    complete: true,
  });
  const path = join(f.state, "doctor-aggregate.json");
  const before = await stat(path);
  await f.member("worker", `${emit} process.exitCode = 1;`);
  const result = await f.run();
  expect(result.exit, result.stderr).toBe(1);
  const data = decode(result.stdout);
  expect(data).toMatchObject({
    findings: [finding],
    kinds: { lost: 1 },
    total: 1,
    lost: 1,
    complete: true,
    members: [
      { tool: "agx-worker", exit: 1, complete: true },
      { tool: "agx-ws", exit: 0, complete: true },
      { tool: "agx-ticket", exit: 0, complete: true },
    ],
  });
  expect(await Bun.file(path).text()).toBe(result.stdout);
  expect((await stat(path)).ino).not.toBe(before.ino);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(f.state)).toEqual(["doctor-aggregate.json"]);
  await f.member("status", `process.exit(99);`);
  // Use the real status entrypoint, with the same isolated owner state.
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../agx-status/src/status.ts"),
      "--json",
    ],
    {
      env: {
        ...process.env,
        AGX_STATE_DIR: f.state,
        XDG_STATE_HOME: join(f.root, "xdg"),
        AGX_NEXT_STATE_DIR: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  const [out, err, exit] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  expect(exit, err).toBe(0);
  const status = jsonOf(z.object({ findings: DoctorAggregate })).safeParse(out);
  expect(status.success).toBe(true);
  if (status.success) expect(status.data.findings).toEqual(data);
});

for (const [name, body] of [
  ["exit 2", "process.exitCode = 2;"],
  ["unexplained exit 1", "process.exitCode = 1;"],
  ["invalid JSONL", 'process.stdout.write("not json\\n");'],
  ["invalid record", 'process.stdout.write("{}\\n"); process.exitCode = 1;'],
  [
    "wrong tool",
    emit.replace("agx-worker", "agx-ticket") + "process.exitCode = 1;",
  ],
  ["findings with exit 0", emit],
  ["unexpected exit", "process.exitCode = 7;"],
  ["timeout", "await Bun.sleep(60000);"],
  ["oversized output", 'process.stdout.write("x".repeat(2 * 1024 * 1024));'],
] as const)
  test(`collection failure is incomplete, never a synthetic finding: ${name}`, async () => {
    await using f = await fixture();
    await f.member("worker", body);
    const result = await f.run(["doctor", "--json", "--timeout-ms", "500"]);
    expect(result.exit, result.stderr).toBe(2);
    const data = decode(result.stdout);
    expect(data.complete).toBe(false);
    expect(data.members[0]?.complete).toBe(false);
    expect(data.findings.every((row) => row.finding === "lost")).toBe(true);
    expect(await Bun.file(join(f.state, "doctor-aggregate.json")).text()).toBe(
      result.stdout,
    );
  });

test("valid findings survive invalid JSONL from another member", async () => {
  await using f = await fixture();
  await f.member("worker", `${emit} process.exitCode = 1;`);
  await f.member(
    "ws",
    'process.stdout.write("broken\\n"); process.exitCode = 2;',
  );
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(decode(result.stdout)).toMatchObject({
    complete: false,
    findings: [finding],
    total: 1,
    lost: 1,
  });
});

test("failed publication exits 2 and leaves the old target intact", async () => {
  await using f = await fixture();
  const path = join(f.state, "doctor-aggregate.json");
  await mkdir(path);
  await writeFile(join(path, "sentinel"), "old");
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(decode(result.stdout).complete).toBe(false);
  expect(await Bun.file(join(path, "sentinel")).text()).toBe("old");
  expect(await readdir(f.state)).toEqual(["doctor-aggregate.json"]);
});

test("doctor owns help and rejects invalid deadlines and operands before collection", async () => {
  await using f = await fixture();
  expect((await f.run(["doctor", "--help"])).stdout).toContain("--timeout-ms");
  for (const args of [
    ["--timeout-ms", "0"],
    ["--timeout-ms", "60001"],
    ["--timeout-ms", "NaN"],
    ["extra"],
  ]) {
    const result = await f.run(["doctor", ...args]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
  }
  expect(await readdir(f.state)).toEqual([]);
});

test("missing member is incomplete while other member observations survive", async () => {
  await using f = await fixture();
  await rm(join(f.root, "agx-ws"));
  const result = await f.run();
  expect(result.exit).toBe(2);
  expect(decode(result.stdout).members[1]).toEqual({
    tool: "agx-ws",
    exit: null,
    complete: false,
  });
  expect(decode(result.stdout).findings).toEqual([]);
});

test("status exposes incomplete snapshots and refuses malformed ones over legacy success", async () => {
  await using f = await fixture();
  await f.member("worker", "process.exitCode = 2;");
  expect((await f.run()).exit).toBe(2);
  const status = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../agx-status/src/status.ts"),
        "--json",
      ],
      {
        env: {
          ...process.env,
          AGX_STATE_DIR: f.state,
          XDG_STATE_HOME: join(f.root, "xdg"),
          AGX_NEXT_STATE_DIR: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [out, err, exit] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(exit, err).toBe(0);
    return out;
  };
  expect(await status()).toContain('"complete":false');
  expect(await status()).toContain('"stale":true');
  await writeFile(
    join(f.state, "doctor.json"),
    JSON.stringify({ kinds: {}, lost: 0, capturedAt: 0, complete: true }),
  );
  await writeFile(join(f.state, "doctor-aggregate.json"), "broken");
  const parsed = jsonOf(z.object({ findings: z.null() })).safeParse(
    await status(),
  );
  expect(parsed.success).toBe(true);
});
