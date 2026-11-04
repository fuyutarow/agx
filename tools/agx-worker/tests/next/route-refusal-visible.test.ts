import { prepareTicketRepo } from "../ticket-repo.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { createTempTracker } from "../temp.ts";
import { append, foldedRuns, now } from "../../src/next/store.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const tempDirs = createTempTracker();
const registerTempDir = tempDirs.register;
afterAll(tempDirs.assertRemoved);

const servers: ReturnType<typeof Bun.spawn>[] = [];
const roots: string[] = [];
const priorStateDir = process.env.AGX_STATE_DIR;
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  if (priorStateDir === undefined) delete process.env.AGX_STATE_DIR;
  else process.env.AGX_STATE_DIR = priorStateDir;
});
const scratch = async (prefix: string): Promise<string> => {
  const root = registerTempDir(
    mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-${prefix}`)),
  );
  roots.push(root);
  await prepareTicketRepo(root);
  return root;
};

describe("agx-worker run", () => {
  test.each([true, false])(
    "route refusal is visible (reason supplied: %s)",
    async (named) => {
      const root = await scratch("missing-input-");
      const state = join(root, "state");
      const ticket = join(root, "ticket.md");
      const reason = "verify requires $AGX_RUN_DIR/parity.tsv";
      const binding = {
        id: "00000000-0000-4000-8000-000000000001",
        ticket: "missing-input",
        workspace: root,
        unit: "agt_missing-input",
      };
      append(
        {
          kind: "dispatching",
          id: binding.id,
          at: now(),
          ticket: binding.ticket,
          writes: [],
          cwd: root,
          workspace: root,
          worker_name: binding.unit,
          unit: binding.unit,
          dispatcher_session: null,
          vendor_session: null,
          pid: process.pid,
          ticket_path: ticket,
        },
        state,
      );
      writeFileSync(
        ticket,
        `+++\nschema = 2\nname = "missing-input"\nwrites = []\noutcome = "fixture refusal"\nverify = ["test -s $AGX_RUN_DIR/parity.tsv"]\n[proposition]\nid = "MISSING-INPUT"\nclaim = "missing input is named"\nrefuted_by = "refusal omits its reason"\n+++\n`,
      );
      const jevFile = join(root, "fake-jev.ts");
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const jevPort = probe.port;
      await probe.stop(true);
      writeFileSync(
        jevFile,
        `Bun.serve({ hostname: "127.0.0.1", port: ${jevPort}, fetch: () => Response.json({ answers: { worker: { choice: "missing_input", ...${JSON.stringify(named ? { reason_code: reason } : {})}, detail: "Jev detail" } } }) });\n`,
      );
      const jev = Bun.spawn([process.execPath, jevFile], {
        stdout: "ignore",
        stderr: "ignore",
      });
      servers.push(jev);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (
          (await fetch(`http://127.0.0.1:${jevPort}/health`).catch(
            () => null,
          )) !== null
        )
          break;
        await Bun.sleep(25);
      }
      const commandBin = join(root, "bin");
      mkdirSync(commandBin);
      const mise = join(commandBin, "mise");
      writeFileSync(mise, '#!/usr/bin/env bun\nconsole.log("{}");\n');
      chmodSync(mise, 0o755);
      const env = {
        ...subprocessEnvironment(),
        PATH: `${commandBin}:${process.env.PATH}`,
        AGX_STATE_DIR: state,
        XDG_STATE_HOME: join(root, "agx-tmp"),
        JEV_URL: `http://127.0.0.1:${jevPort}/choice`,
        TYPESAFE_API_KEY: "test-key",
        AGX_CONFIG: new URL(
          "../../src/roster/policy.example.toml",
          import.meta.url,
        ).pathname,
        XDG_CONFIG_HOME: join(root, "config"),
      };
      const result = Bun.spawnSync(
        [
          process.execPath,
          "tools/agx-worker/src/next/cli.ts",
          "run",
          ticket,
          "--cd",
          root,
          "--dispatch-binding",
          JSON.stringify(binding),
        ],
        { cwd: process.cwd(), env, timeout: 10_000 },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(2);
      expect(result.stderr.toString()).toContain(
        named ? reason : "without a reason_code",
      );
      expect(result.stdout.toString()).toContain("route-refused");
      const report = JSON.parse(
        readFileSync(join(state, "runs", binding.id, "report.json"), "utf8"),
      );
      expect(report.outcome).toBe("route-refused");
      expect(report.summary).toContain("Jev detail");
      const waited = Bun.spawnSync(
        [
          process.execPath,
          "tools/agx-worker/src/next/cli.ts",
          "ls",
          "--wait",
          binding.id,
        ],
        { cwd: process.cwd(), env, timeout: 10000 },
      );
      expect(waited.exitCode).toBe(0);
      expect(waited.stdout.toString()).toContain("Jev detail");
      const checked = Bun.spawnSync(
        [
          process.execPath,
          "tools/agx-worker/src/next/cli.ts",
          "check",
          ticket,
          "--cd",
          root,
        ],
        { cwd: process.cwd(), env, timeout: 10000 },
      );
      expect(checked.exitCode).toBe(2);
      expect(checked.stderr.toString()).toContain(
        named ? reason : "without a reason_code",
      );
      const parsedRecords = jsonOf(
        z.array(z.record(z.string(), z.unknown())),
      ).safeParse(
        `[${readFileSync(join(state, "records.jsonl"), "utf8")
          .trim()
          .split("\n")
          .join(",")}]`,
      );
      expect(parsedRecords.success).toBe(true);
      if (!parsedRecords.success) return;
      const records = parsedRecords.data;
      expect(
        records.some(
          (record) =>
            record.kind === "refusal" &&
            JSON.stringify(record).includes(
              named ? reason : "without a reason_code",
            ),
        ),
      ).toBe(true);
      expect(
        (await foldedRuns(state)).find((run) => run.id === binding.id),
      ).toMatchObject({
        state: "ended",
        outcome: "refused",
        row: "dispatching",
      });
      expect(
        records.some(
          (record) =>
            record.kind === "ended" &&
            record.id === binding.id &&
            record.outcome === "refused",
        ),
      ).toBe(true);
      expect(records.some((record) => record.kind === "started")).toBe(false);
    },
  );
});
