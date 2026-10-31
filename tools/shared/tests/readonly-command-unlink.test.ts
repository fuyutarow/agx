import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "linux")(
  "readonly spawn survives deletion of the running executable",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "readonly-unlink-"));
    await using _cleanup = {
      [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    };
    const source = join(root, "fixture.ts");
    const built = join(root, "built");
    const copy = join(root, "running");
    await writeFile(
      source,
      `
import { readonlyCommand } from ${JSON.stringify(resolve(import.meta.dir, "../src/readonly-command.ts"))};
process.stdout.write("ready\\n");
await new Response(Bun.stdin.stream()).text();
const invocation = readonlyCommand(["/bin/echo", "success"], ${JSON.stringify(root)});
const child = Bun.spawn(invocation.cmd, { env: invocation.env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
const [exit, out, err] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
process.stdout.write(out);
process.stderr.write(err);
process.exit(exit);
`,
    );
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", source, "--outfile", built],
      { stdout: "pipe", stderr: "pipe", timeout: 60_000 },
    );
    const [buildExit, buildOut, buildErr] = await Promise.all([
      build.exited,
      build.stdout.text(),
      build.stderr.text(),
    ]);
    expect(buildExit, buildOut + buildErr).toBe(0);
    await copyFile(built, copy);
    const child = Bun.spawn([copy], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    await unlink(copy);
    await child.stdin.end();
    const [exit, rest, err] = await Promise.all([
      child.exited,
      new Response(
        new ReadableStream({
          async pull(controller) {
            const chunk = await reader.read();
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          },
        }),
      ).text(),
      child.stderr.text(),
    ]);
    expect(exit, err).toBe(0);
    expect(rest).toBe("success\n");
  },
  90_000,
);
