#!/usr/bin/env bun
import { spawn } from "bun";
const mode = process.env.PROBE_MODE;
if (process.env.PROBE_CAPTURE !== undefined)
  await Bun.write(
    process.env.PROBE_CAPTURE,
    JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }),
  );
const emit = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "hang") {
  await Bun.sleep(60_000);
  process.exit(0);
}
if (mode === "exit") {
  process.stderr.write("vendor unavailable\n");
  process.exit(7);
}
if (mode === "bad") {
  process.stdout.write("not json\n");
  process.exit(0);
}
if (mode === "flood") {
  process.stdout.write("x".repeat(2 * 1024 * 1024));
  await Bun.sleep(60_000);
}
if (mode === "descendant") {
  const child = spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (process.env.PROBE_PID !== undefined)
    await Bun.write(process.env.PROBE_PID, String(child.pid));
  await Bun.sleep(60_000);
}
emit({ type: "thread.started", thread_id: "fake-probe" });
if (mode !== "missing-command")
  emit({
    type: "item.completed",
    item: {
      type: "command_execution",
      status: "completed",
      exit_code: 0,
      aggregated_output: "AGX_PROBE_OK\n",
    },
  });
emit({
  type: "item.completed",
  item: { type: "agent_message", text: "AGX_PROBE_OK" },
});
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
if (mode === "late-hang") await Bun.sleep(60_000);
