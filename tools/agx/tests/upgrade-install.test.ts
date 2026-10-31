import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

let root = "";
let binary = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agx-upgrade-install-"));
  const install = join(root, "installs/agx/old/bin");
  await mkdir(install, { recursive: true });
  binary = join(install, "agx-worker");
  const entry = join(root, "probe.ts");
  await writeFile(
    entry,
    `import { selfCommand } from ${JSON.stringify(resolve(import.meta.dir, "../../agx-worker/src/self-command.ts"))};
if (process.argv[2] === "child") {
  process.stdout.write("old install child\\n");
} else {
  process.stdout.write(JSON.stringify(selfCommand()) + "\\n");
  await Bun.stdin.text();
  try {
    const child = Bun.spawn([...selfCommand(), "child"], {
      stdout: "inherit", stderr: "inherit", timeout: 5000,
    });
    process.exitCode = await child.exited;
  } catch {
    process.stderr.write("old executable unavailable\\n");
    process.exitCode = 2;
  }
}
`,
  );
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", entry, "--outfile", binary],
    { stdout: "pipe", stderr: "pipe", timeout: 60000 },
  );
  const [out, err, code] = await Promise.all([
    build.stdout.text(),
    build.stderr.text(),
    build.exited,
  ]);
  expect(code, out + err).toBe(0);
}, 60000);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

async function readWorkerOutput(reader: {
  read: () => Promise<{
    done: boolean;
    value: Uint8Array | undefined;
  }>;
}) {
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return output + decoder.decode();
    if (chunk.value !== undefined)
      output += decoder.decode(chunk.value, { stream: true });
  }
}

async function runInstallCase(prune: boolean) {
  const newBin = join(root, "installs/agx/new/bin");
  await mkdir(newBin, { recursive: true });
  await writeFile(join(newBin, "agx-worker"), "new install must not run\n");
  const env = {
    ...subprocessEnvironment(),
    PATH: `${newBin}:/usr/bin:/bin`,
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg"),
  };
  const worker = Bun.spawn([binary], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  const reader = worker.stdout.getReader();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    reader.releaseLock();
    worker.kill();
    await worker.exited;
  });

  // Readiness proves the old executable is running before simulated pruning.
  const ready = await reader.read();
  expect(new TextDecoder().decode(ready.value)).toBe(
    `${JSON.stringify(["/proc/self/exe"])}\n`,
  );
  if (prune) await rm(join(root, "installs/agx/old"), { recursive: true });
  await worker.stdin.end();
  const [out, err, code] = await Promise.all([
    readWorkerOutput(reader),
    worker.stderr.text(),
    worker.exited,
  ]);
  expect(code).toBe(0);
  expect(out).toBe("old install child\n");
  expect(err).toBe("");
}

test.skipIf(process.platform !== "linux")(
  "upgrade-install: compiled worker re-enters its old image after PATH changes and pruning",
  async () => {
    for (const prune of [false, true]) await runInstallCase(prune);
  },
);
