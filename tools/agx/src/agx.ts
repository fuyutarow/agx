#!/usr/bin/env bun
import { printVersion } from "../../shared/src/cli.ts";
import cliPackage from "../package.json" with { type: "json" };
import {
  forwardPath,
  resolveSuiteTool,
} from "../../shared/src/path-dispatch.ts";

import { doctor } from "./doctor.ts";
import { change } from "./change.ts";

const argv = process.argv.slice(2);
const tools = ["worker", "ticket", "ws", "status", "msg", "doctor", "change"];

async function help(): Promise<void> {
  process.stdout.write(
    `agx ${cliPackage.version}\n\nUSAGE: agx <tool> [args...]\n\nTOOLS:\n`,
  );
  for (const tool of tools) {
    if (tool === "doctor") {
      process.stdout.write(
        "  doctor  Refresh and publish aggregate doctor findings\n",
      );
      continue;
    }
    if (tool === "change") {
      process.stdout.write(
        "  change  Coordinate changes and reserve alpha pushes for agx change land\n",
      );
      continue;
    }
    const child = Bun.spawn([await resolveSuiteTool(`agx-${tool}`), "--help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      process.stderr.write(
        err !== "" ? err : `agx: agx-${tool} --help exited ${code}\n`,
      );
      process.exitCode = code;
      return;
    }
    const description = out
      .split(/\r?\n/u)
      .slice(1)
      .find((line) => line.trim() !== "");
    process.stdout.write(`  ${tool}  ${description?.trim() ?? ""}\n`);
  }
  process.stdout.write(
    "\nCOMMAND GUIDE:\n" +
      "  Read agx --help, then agx <tool> --help, then agx <tool> <command> --help.\n" +
      "  Validate/start/run workers: agx worker check|dispatch|run.\n" +
      "  Inspect and judge runs: agx worker ls|judge.\n" +
      "  Issue/list/collect tickets: agx ticket new|ls|gc.\n" +
      "  Create/adopt/refresh/remove/collect workspaces: agx ws add|adopt|refresh|rm|gc.\n" +
      "  Discover/send/check messages: agx msg list|send|status.\n" +
      "  Protect the trunk push path: agx change hook pre-push.\n" +
      "  Refresh/read suite health: agx doctor, agx status.\n" +
      "\nOPTIONS:\n  -h, --help  Show help\n  -V, --version  Show version\n",
  );
}

async function main(): Promise<void> {
  if (printVersion(cliPackage, "agx", argv)) return;
  const [first, ...remaining] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    await help();
    return;
  }
  if (!tools.includes(first)) {
    process.stderr.write(
      `agx: unknown command ${JSON.stringify(first)}; use agx --help to list valid commands\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (first === "doctor") {
    await doctor(remaining);
    return;
  }
  if (first === "change") {
    change(remaining);
    return;
  }
  const target = await resolveSuiteTool(`agx-${first}`);
  const exitCode = await forwardPath(target, remaining);
  process.exitCode = exitCode;
}
await main().catch((error: unknown) => {
  process.stderr.write(`agx: ${String(error)}\n`);
  process.exitCode = 2;
});
