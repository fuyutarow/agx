// Test-only mise protocol; never writes configuration or invokes mise.
import { appendFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (process.env.RELEASE_TEST_MISE_LOG !== undefined)
  await appendFile(
    process.env.RELEASE_TEST_MISE_LOG,
    JSON.stringify({ args, cwd: process.cwd() }) + "\n",
  );
if (args[0] === "install") {
  if (process.env.RELEASE_TEST_PIPE_CHILD_PID !== undefined) {
    const child = Bun.spawn(
      [process.execPath, "-e", "await Bun.sleep(300000)"],
      { stdout: "inherit", stderr: "inherit" },
    );
    await Bun.write(process.env.RELEASE_TEST_PIPE_CHILD_PID, String(child.pid));
    child.unref();
  }
  process.stderr.write("downloading fixture suite\n");
  await Bun.sleep(Number(process.env.RELEASE_TEST_INSTALL_DELAY_MS ?? 0));
  if (process.env.RELEASE_TEST_INSTALL_FAIL === "1") {
    process.stderr.write("fixture install failed\n");
    process.exitCode = 1;
  }
} else if (args[0] === "exec" && args[1] === "-C" && args.at(-1) === "-V") {
  process.stdout.write(
    args[2] === process.env.RELEASE_TEST_STALE_DIR
      ? "agx 2.3.3\n"
      : "agx 2.3.4\n",
  );
} else {
  process.stderr.write("Fake mise refused unknown command\n");
  process.exitCode = 98;
}
