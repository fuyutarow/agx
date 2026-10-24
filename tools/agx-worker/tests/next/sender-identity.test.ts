import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { workerEnvironment } from "../../src/workers/environment.ts";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});
const uuid = "deadbeef-1234-4abc-8def-0123456789ab";
const fixture = resolve(import.meta.dir, "fixtures/sender-vendor.ts");
const captureSchema = z.object({
  args: z.array(z.string()),
  sender: z.string().nullable(),
  runId: z.string(),
});

test("a parent's declaration is cleared even with matching native IDs", () => {
  const environment = workerEnvironment({
    AGX_MSG_FROM: `codex:${uuid}`,
    CODEX_THREAD_ID: uuid,
    CLAUDE_CODE_SESSION_ID: uuid,
    AGX_DISPATCHER_SESSION: uuid,
  });
  expect(environment.AGX_MSG_FROM).toBeUndefined();
  expect(environment.CODEX_THREAD_ID).toBeUndefined();
  expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(environment.AGX_DISPATCHER_SESSION).toBe(uuid);
});

for (const backend of ["claude", "codex"] as const) {
  test.each([undefined, uuid.toUpperCase(), "native-name"])(
    `${backend} spawn declares only its own pre-spawn full session UUID: %s`,
    async (resume) => {
      const root = await mkdtemp(join(tmpdir(), "agx-sender-identity-"));
      roots.push(root);
      const capture = join(root, "capture.json");
      const prompt = join(root, "prompt.md");
      await Bun.write(prompt, "Reply fixture done");
      const wrapper = backend === "claude" ? "run-claude.ts" : "codex.ts";
      const args =
        backend === "claude"
          ? ["--target", root, "--model", "fixture", "--claude-bin", fixture]
          : [
              "--choice",
              "luna-medium",
              "--sandbox",
              "read-only",
              "--cd",
              root,
              "--receipt-dir",
              join(root, "receipts"),
            ];
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../src/workers", wrapper),
          ...args,
          "--prompt-file",
          prompt,
          ...(resume === undefined ? [] : ["--resume", resume]),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            AGX_CONFIG: resolve(
              import.meta.dir,
              "../../src/roster/policy.example.toml",
            ),
            AGX_CODEX_BIN: fixture,
            AGX_CODEX_HOST_FILE: join(root, "missing-host.toml"),
            AGX_SENDER_CAPTURE: capture,
            AGX_RUN_ID: "sender-fixture-run",
            AGX_MSG_FROM: "claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            CODEX_THREAD_ID: uuid,
            CLAUDE_CODE_SESSION_ID: uuid,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      expect(exit, stdout + stderr).toBe(0);
      const parsed = jsonOf(captureSchema).safeParse(
        await Bun.file(capture).text(),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const actual = parsed.data;
      expect(actual.runId).toBe("sender-fixture-run");
      if (resume === undefined && backend === "claude") {
        const session = actual.args[actual.args.indexOf("--session-id") + 1];
        expect(session).toMatch(/^[a-f0-9-]{36}$/u);
        expect(actual.sender).toBe(`claude:${session}`);
      } else if (resume === uuid.toUpperCase()) {
        expect(actual.args).toContain(resume);
        expect(actual.sender).toBe(`${backend}:${uuid}`);
        expect(actual.args).not.toContain("--session-id");
      } else {
        expect(actual.sender).toBeNull();
      }
    },
  );
}
