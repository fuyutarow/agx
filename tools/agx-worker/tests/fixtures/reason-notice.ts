import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A fake `reason-network` with the two commands the run-end notice uses: `who --json` and `send <address> <message>`.
// `mcp` is recorded and refused: the notice must never start an MCP process.
// `send` runs with an allowlisted environment (PATH, HOME, REASON_NETWORK_HOME), so it reads its settings from
// `$REASON_NETWORK_HOME/fake.json` ({ log, mode, delayMs }); `who` keeps the FAKE_* variables.
const command = process.argv[2];
const home = process.env.REASON_NETWORK_HOME;
const settingsFile = home === undefined ? undefined : join(home, "fake.json");
const settings: { log?: string; mode?: string; delayMs?: string } =
  settingsFile !== undefined && existsSync(settingsFile)
    ? JSON.parse(readFileSync(settingsFile, "utf8"))
    : {};
const log = process.env.FAKE_LOG ?? settings.log ?? "";
const mode = process.env.FAKE_MODE ?? settings.mode ?? "ok";
const delayMs = process.env.FAKE_DELAY_MS ?? settings.delayMs;
const record = (data: object) =>
  appendFileSync(log, `${JSON.stringify(data)}\n`);

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
    envNames: Object.keys(process.env).sort(),
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
  if (delayMs !== undefined) await Bun.sleep(Number(delayMs));
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
