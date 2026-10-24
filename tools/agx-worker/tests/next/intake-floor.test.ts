import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareTicketRepo } from "../ticket-repo.ts";
import { jsonOf, z } from "../../../shared/src/zod.ts";

const Check = jsonOf(
  z.object({ ok: z.boolean(), violations: z.array(z.string()) }),
);
const Refusal = jsonOf(
  z.object({ kind: z.literal("refusal"), ticket_sha256: z.string() }),
);
function expectViolations(out: string, rule: string) {
  if (out === "") return;
  const parsed = Check.safeParse(out);
  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data.violations.join(" ")).toContain(
    `remand ${rule}`,
  );
}

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("intake refuses every launch entry before routing, logs hashes, and admits read-only review", async () => {
  const root = await mkdtemp(join(tmpdir(), "agx-intake-floor-"));
  roots.push(root);
  await prepareTicketRepo(root);
  const path = join(root, "intake.md");
  const state = join(root, "state");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mise"),
    '#!/usr/bin/env bun\nprocess.stdout.write("{}\\n");\n',
    { mode: 0o755 },
  );
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests++;
      return Response.json({ answers: {} });
    },
  });
  servers.push(server);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    AGX_NEXT_STATE_DIR: undefined,
    AGX_STATE_DIR: state,
    XDG_CONFIG_HOME: join(root, "config"),
    AGX_CONFIG: resolve("tools/agx-worker/src/roster/policy.example.toml"),
    AGX_WORKER_BIN: "/must-never-start",
    JEV_URL: `http://127.0.0.1:${server.port}/choice`,
    TYPESAFE_API_KEY: "fixture-only",
  };
  const invoke = async (args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, resolve("tools/agx-worker/src/next/cli.ts"), ...args],
      {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      },
    );
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, out, err };
  };
  const review =
    '[proposition]\nid = "INTAKE"\nclaim = "reviewed"\nrefuted_by = "human review finds the diff violates the declared outcome"\n';
  for (const [scope, criterion, rule] of [
    ["", review, "writes"],
    ["writes = []\n", "", "acceptance"],
  ]) {
    const source = Buffer.concat([
      Buffer.from(
        `+++\nschema = 2\nname = "intake"\noutcome = "Review the diff"\n${scope}${criterion}+++\n`,
      ),
      Buffer.from([255]),
    ]);
    await writeFile(path, source);
    for (const args of [
      ["check", path, "--json"],
      ["run", path],
      ["check", path, "--continue", "missing"],
      ["run", path, "--continue", "missing"],
      ["dispatch", path],
      ["dispatch", path, "--continue", "missing"],
      ["roster", path],
    ]) {
      const result = await invoke(args);
      expect(result.exit, result.err).toBe(2);
      expect(result.err).toContain(`remand ${rule}: "`);
      expect(result.err).toContain("Fix:");
      expect(
        result.err
          .trim()
          .split("\n")
          .every((line) => /^agx: remand [a-z]+: ".*Fix: /u.test(line)),
      ).toBe(true);
      expectViolations(result.out, rule ?? "");
      const records = (await readFile(join(state, "records.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => Refusal.safeParse(line));
      expect(records.every((record) => record.success)).toBe(true);
      const last = records.at(-1);
      expect(last?.success === true ? last.data.ticket_sha256 : undefined).toBe(
        createHash("sha256").update(source).digest("hex"),
      );
    }
  }
  await writeFile(
    path,
    `+++\nschema = 2\nname = "intake"\noutcome = "Review the diff"\nwrites = []\n${review}+++\n`,
  );
  const accepted = await invoke(["check", path, "--json"]);
  expect(accepted.exit, accepted.err).toBe(0);
  const parsedAccepted = Check.safeParse(accepted.out);
  expect(parsedAccepted.success && parsedAccepted.data).toEqual({
    ok: true,
    violations: [],
  });
  expect(requests).toBe(0);
}, 60_000);
