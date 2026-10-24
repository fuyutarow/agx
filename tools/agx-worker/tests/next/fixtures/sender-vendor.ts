#!/usr/bin/env bun
export {};
// Fake vendor only: capture the actual spawn boundary, never contact a model.
const args = Bun.argv.slice(2);
const capture = process.env.AGX_SENDER_CAPTURE;
if (capture === undefined) process.exit(2);
await Bun.write(
  capture,
  JSON.stringify({
    args,
    sender: process.env.AGX_MSG_FROM ?? null,
    runId: process.env.AGX_RUN_ID,
  }),
);
if (args[0] === "exec") {
  const last = args[args.indexOf("-o") + 1];
  if (last === undefined) process.exit(2);
  await Bun.write(last, "fixture done");
  process.stdout.write(
    JSON.stringify({
      type: "thread.started",
      thread_id: "deadbeef-1234-4abc-8def-0123456789ab",
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    }) + "\n",
  );
} else {
  const flag = args.includes("--resume") ? "--resume" : "--session-id";
  process.stdout.write(
    JSON.stringify({
      result: "fixture done",
      session_id: args[args.indexOf(flag) + 1],
    }) + "\n",
  );
}
