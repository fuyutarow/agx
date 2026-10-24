// Test-only mise protocol; never writes configuration or invokes mise.
import { appendFile } from "node:fs/promises";
// argv-forwarding: fake mise protocol.
const args = process.argv.slice(2);
if (process.env.RELEASE_TEST_MISE_LOG !== undefined)
  await appendFile(
    process.env.RELEASE_TEST_MISE_LOG,
    JSON.stringify({ args, cwd: process.cwd() }) + "\n",
  );
if (args[0] === "install") {
  if (process.env.RELEASE_TEST_INSTALL_FAIL === "1") {
    process.stderr.write("fixture install failed\n");
    process.exitCode = 1;
  }
} else if (
  args[0] === "exec" &&
  args[1] === "-C" &&
  args.slice(3).join(" ") === "-- agx -V"
) {
  process.stdout.write(
    args[2] === process.env.RELEASE_TEST_STALE_DIR
      ? "agx 2.3.3\n"
      : "agx 2.3.4\n",
  );
} else {
  process.stderr.write("Fake mise refused unknown command\n");
  process.exitCode = 98;
}
