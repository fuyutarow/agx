import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/xmsg.ts");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test.each([undefined, `codex:${id}`])(
  "missing --from refuses before discovery or transport (environment %s)",
  async (declaration) => {
    const root = await mkdtemp(join(tmpdir(), "sender-required-"));
    roots.push(root);
    const marker = join(root, "called");
    for (const executable of ["codex", "claude"]) {
      const path = join(root, executable);
      await Bun.write(path, `#!/bin/sh\nprintf called >> "$MARKER"\n`);
      await chmod(path, 0o755);
    }
    const proc = Bun.spawn(
      [process.execPath, cli, "send", "--to", "peer", "--message", "hello"],
      {
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: root,
          PATH: root,
          MARKER: marker,
          AGX_MSG_FROM: declaration,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stderr] = await Promise.all([
      proc.exited,
      proc.stderr.text(),
      proc.stdout.text(),
    ]);
    expect(exit).toBe(2);
    expect(stderr).toContain("usage:");
    expect(await Bun.file(marker).exists()).toBe(false);
  },
);

test.each([`codex:${id}`, `agx-manager:${id}`])(
  "explicit sender %s reaches transport",
  async (sender) => {
    const root = await mkdtemp(join(tmpdir(), "sender-required-"));
    roots.push(root);
    const marker = join(root, "called");
    const path = join(root, "codex");
    await Bun.write(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "$MARKER"\n`);
    await chmod(path, 0o755);
    const proc = Bun.spawn(
      [
        process.execPath,
        cli,
        "send",
        "--exact",
        "--to",
        "codex:peer",
        "--from",
        sender,
        "--message",
        "hello",
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: root,
          PATH: root,
          MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit] = await Promise.all([
      proc.exited,
      proc.stderr.text(),
      proc.stdout.text(),
    ]);
    expect(exit).toBe(0);
    expect(await Bun.file(marker).text()).toContain(`from: ${sender}\n\nhello`);
  },
);
