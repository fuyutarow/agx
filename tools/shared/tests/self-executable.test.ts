import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfExecutable } from "../src/self-executable.ts";

test("falls back to the runtime when proc is unavailable", () => {
  expect(selfExecutable(() => false)).toBe(process.execPath);
});

test.skipIf(process.platform !== "linux")(
  "re-spawns the running image after its file is removed",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "agx-self-executable-"));
    await using _cleanup = {
      [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
    };
    const source = join(dir, "fixture.ts");
    const built = join(dir, "built");
    const copy = join(dir, "running");
    const helper = join(import.meta.dir, "../src/self-executable.ts");
    await writeFile(
      source,
      `import { selfExecutable } from ${JSON.stringify(helper)};
if (process.argv.includes("child")) {
  process.stdout.write("child ran\\n");
} else {
  process.stdout.write("ready\\n");
  await Bun.stdin.stream().getReader().read();
  const child = Bun.spawn([selfExecutable(), "child"], { stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
`,
    );
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", source, "--outfile", built],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      },
    );
    const [buildCode, buildOut, buildErr] = await Promise.all([
      build.exited,
      build.stdout.text(),
      build.stderr.text(),
    ]);
    expect(buildCode, buildOut + buildErr).toBe(0);
    await copyFile(built, copy);
    const parent = Bun.spawn([copy], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const reader = parent.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    await rm(copy);
    await parent.stdin.write("go\n");
    await parent.stdin.end();
    const output = await new Response(
      new ReadableStream({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      }),
    ).text();
    const [code, stderr] = await Promise.all([
      parent.exited,
      parent.stderr.text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(output).toBe("child ran\n");
  },
  90_000,
);
