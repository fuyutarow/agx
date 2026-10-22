import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "agx-test-"));
process.env.TMPDIR = directory;
process.env.TMP = directory;
process.env.TEMP = directory;
process.once("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});
