import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

test("public ls hides malformed imports, counts them and normalizes moved reports within one second", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-ls-scale-"));
  const state = join(root, "agx");
  using _cleanup = {
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  {
    mkdirSync(join(state, "runs", "run-0"), { recursive: true });
    const report = join(state, "runs", "run-0", "report.json");
    writeFileSync(report, "{}");
    const events: unknown[] = [];
    for (let i = 0; i < 5000; i++) {
      const imported = i < 3;
      events.push(
        {
          kind: "started",
          id: `run-${i}`,
          at: "2026-10-20T10:00:00Z",
          ticket: i === 1 ? "legacy" : `ticket-${i}`,
          row: i === 1 ? 42 : "unknown",
          cwd: root,
          workspace: root,
          writes: [],
          pid: 0,
          dispatcher_session: null,
          vendor_session: null,
          ...(imported
            ? { legacy: { run_id: `old-${i}`, source: "legacy-v1" } }
            : {}),
        },
        {
          kind: "ended",
          id: `run-${i}`,
          at: "2026-10-20T10:02:00Z",
          exit: 0,
          report_path:
            i === 0
              ? join(root, "agx-next", "runs", "run-0", "report.json")
              : join(root, "agx-next", "missing.json"),
          vendor_session: null,
          verify: [],
        },
      );
    }
    writeFileSync(
      join(state, "records.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const timings: number[] = [];
    const invoke = (...flags: string[]) => {
      const result = Bun.spawnSync(
        [process.execPath, "tools/agx-worker/src/next/cli.ts", "ls", ...flags],
        {
          env: {
            ...subprocessEnvironment(),
            AGX_STATE_DIR: state,
            XDG_STATE_HOME: root,
          },
          timeout: 5000,
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      // CPU time, not wall time: the listing's own work is what the contract bounds, and wall
      // time also counts waiting for a core while other test files run (measured 2026-11-20:
      // 240-530 ms wall alone, 1070 ms in the parallel suite; 370-560 ms CPU either way).
      // Bun 1.4.3 returns microseconds as a bigint where its types say number; accept both.
      timings.push(Number(BigInt(result.resourceUsage.cpuTime.total)) / 1000);
      return result;
    };
    const plain = invoke();
    expect(plain.stderr.toString()).not.toContain("--include-legacy");
    expect(plain.stdout.toString()).not.toContain("tkt_legacy ");
    const row = z.object({
      id: z.string(),
      report_path: z.string().nullable(),
    });
    const output = jsonOf(z.array(row)).safeParse(
      invoke("--json").stdout.toString(),
    );
    expect(output.success).toBe(true);
    if (!output.success) return;
    expect(output.data).toHaveLength(4999);
    // Decodable legacy runs with historical placeholder metadata stay visible.
    expect(output.data.some((entry) => entry.id === "run-2")).toBe(true);
    expect(output.data.find((entry) => entry.id === "run-0")?.report_path).toBe(
      report,
    );
    expect(output.data.find((entry) => entry.id === "run-2")?.report_path).toBe(
      join(root, "agx-next", "missing.json"),
    );
    const summary = jsonOf(
      z.object({ summary: z.object({ hidden_legacy: z.number() }) }),
    ).safeParse(invoke("--json", "--summary").stdout.toString());
    expect(summary.success).toBe(true);
    if (summary.success) expect(summary.data.summary.hidden_legacy).toBe(1);
    expect(invoke("run-0", "--json").stdout.toString()).toContain(report);
    expect(
      invoke("--ticket", "ticket-0", "--latest", "--json").stdout.toString(),
    ).toContain(report);
    console.info("ls fixture CPU milliseconds:", timings);
    // The latency contract covers default plain and JSON listing. The remaining
    // calls above exercise selection and visibility rather than add timing samples.
    expect(Math.max(...timings.slice(0, 2))).toBeLessThan(1000);
  }
});
