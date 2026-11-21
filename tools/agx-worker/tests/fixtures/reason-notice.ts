import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";

// A fake `reason-network` with the two commands the run-end notice uses: `who --json` and `send <address> <message>`.
// `mcp` is recorded and refused: the notice must never start an MCP process.
// `send` runs with an allowlisted environment (PATH, HOME, REASON_NETWORK_HOME), so it reads its settings from
// `$REASON_NETWORK_HOME/fake.json` ({ log, mode, awaitSends }); `who` keeps the FAKE_* variables.
const command = process.argv[2];
const home = process.env.REASON_NETWORK_HOME;
const settingsFile = home === undefined ? undefined : join(home, "fake.json");
const settingsSchema = z.object({
  log: z.string().optional(),
  mode: z.string().optional(),
  awaitSends: z.string().optional(),
});
const settingsResult =
  settingsFile !== undefined && existsSync(settingsFile)
    ? jsonOf(settingsSchema).safeParse(readFileSync(settingsFile, "utf8"))
    : undefined;
const settings = settingsResult?.success === true ? settingsResult.data : {};
const log = process.env.FAKE_LOG ?? settings.log ?? "";
const mode = process.env.FAKE_MODE ?? settings.mode ?? "ok";
// With awaitSends = N, a send answers only once N sends are in flight: overlap by signal, not by a sleep.
const awaitSends = Number(settings.awaitSends ?? "0");
const sendsInFlight = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes('"command":"send"')).length;
const record = (data: object) => {
  appendFileSync(log, `${JSON.stringify(data)}\n`);
};

if (command === "who" && process.argv[3] === "--json") {
  record({
    command,
    agent: process.env.REASON_NETWORK_AGENT,
    session: process.env.REASON_NETWORK_SESSION,
  });
  process.stdout.write(
    JSON.stringify({
      sessions:
        mode === "unregistered"
          ? []
          : [{ address: "alice/dispatcher@host", is_me: true }],
    }),
  );
} else if (command === "send") {
  const args = process.argv.slice(3);
  // The id carries the run's first character so concurrent notices can be told apart in their receipts.
  const runId = /^agx end-notice run (\S+)/u.exec(args[1] ?? "")?.[1] ?? "V";
  record({
    command,
    args,
    hasFrom: args.includes("--from"),
    envNames: Object.keys(process.env).toSorted(),
    cwd: process.cwd(),
  });
  if (["hang", "hold-pipes"].includes(mode)) {
    const helper = Bun.spawn(
      [process.execPath, "-e", "await new Promise(() => {})"],
      {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    helper.unref();
    record({ helper: helper.pid });
  }
  if (mode === "hang") await new Promise(() => {});
  while (sendsInFlight() < awaitSends) await Bun.sleep(5);
  if (mode === "unknown") {
    process.stderr.write("receipt unavailable");
    process.exitCode = 1;
  } else if (mode === "no-id") {
    process.stdout.write("→ alice/dispatcher@host: queued\n");
  } else if (mode === "two-ids") {
    process.stdout.write(
      "message id 01ARZ3NDEKTSV4RRFFQ69G5FAV\nmessage id 01ARZ3NDEKTSV4RRFFQ69G5FAW\n",
    );
  } else {
    record({ delivery: runId });
    process.stdout.write(
      `message id 01ARZ3NDEKTSV4RRFFQ69G5FA${runId.slice(0, 1).toUpperCase()}\n`,
    );
  }
} else {
  record({ command, args: process.argv.slice(3) });
  process.stderr.write(`fake reason-network: unexpected command ${command}\n`);
  process.exitCode = 2;
}
