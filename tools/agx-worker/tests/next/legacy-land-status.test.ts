import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { jsonOf, z } from "../../../shared/src/zod.ts";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(join(root, "state"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-legacy-land-"));
  roots.push(root);
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "bin"));
  symlinkSync(
    resolve("tools/agx-worker/src/next/cli.ts"),
    join(root, "bin/agx-worker"),
  );
  const env = {
    ...subprocessEnvironment(),
    AGX_STATE_DIR: join(root, "state"),
    XDG_STATE_HOME: join(root, "xdg"),
    PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  Reflect.deleteProperty(env, "AGX_NEXT_STATE_DIR");
  return { root, env };
};

// atime is intentionally excluded: reads can update access times, but must not
// change bytes, entries, permissions, modification times, or change times.
const snapshot = (path: string): unknown => {
  const info = lstatSync(path);
  return {
    mode: info.mode,
    mtime: info.mtimeMs,
    ctime: info.ctimeMs,
    content: info.isDirectory()
      ? readdirSync(path)
          .toSorted()
          .map((entry) => [entry, snapshot(join(path, entry))])
      : readFileSync(path).toString("base64"),
  };
};

const reportSchema = jsonOf(
  z.object({
    legacy_land: z.strictObject({
      present: z.boolean().nullable(),
      status: z.enum(["present", "absent", "refused"]),
      reason: z.string().min(1),
    }),
  }),
);

const stats = (env: NodeJS.ProcessEnv) =>
  Bun.spawnSync([process.execPath, "tools/agx/src/agx.ts", "worker", "stats"], {
    env,
    timeout: 15_000,
  });

test("public stats reports empty and populated land entries without writing or importing", () => {
  const { root, env } = fixture();
  const land = join(env.AGX_STATE_DIR, "land");
  mkdirSync(land);
  for (const populated of [false, true]) {
    if (populated)
      writeFileSync(join(land, "journal.jsonl"), "unparsed legacy bytes\n");
    const before = snapshot(root);
    const result = stats(env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const report = reportSchema.safeParse(result.stdout.toString());
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.data.legacy_land).toEqual({
      present: true,
      status: "present",
      reason: "legacy land entry exists; owner migration evidence is required",
    });
    expect(snapshot(root)).toEqual(before);
  }
});

test("public stats reports confirmed absence without creating state", () => {
  const { root, env } = fixture();
  for (const state of [env.AGX_STATE_DIR, join(root, "missing/state")]) {
    const before = snapshot(root);
    const result = stats({ ...env, AGX_STATE_DIR: state });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const report = reportSchema.safeParse(result.stdout.toString());
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.data.legacy_land.present).toBe(false);
    expect(report.data.legacy_land.status).toBe("absent");
    expect(snapshot(root)).toEqual(before);
  }
});

test("public stats refuses unreadable state and preserves it", () => {
  const { root, env } = fixture();
  mkdirSync(join(env.AGX_STATE_DIR, "land"));
  chmodSync(env.AGX_STATE_DIR, 0);
  const before = lstatSync(env.AGX_STATE_DIR);
  const result = stats(env);
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe("");
  const report = reportSchema.safeParse(result.stdout.toString());
  expect(report.success).toBe(true);
  if (!report.success) return;
  expect(report.data.legacy_land).toEqual({
    present: null,
    status: "refused",
    reason: "cannot inspect state directory: EACCES",
  });
  const after = lstatSync(env.AGX_STATE_DIR);
  expect([after.mode, after.mtimeMs, after.ctimeMs]).toEqual([
    before.mode,
    before.mtimeMs,
    before.ctimeMs,
  ]);
  chmodSync(env.AGX_STATE_DIR, 0o700);
  expect(readdirSync(env.AGX_STATE_DIR)).toEqual(["land"]);
  expect(readdirSync(join(root, "state/land"))).toEqual([]);
});

test("public stats refuses dangling and non-directory state paths", () => {
  const { root, env } = fixture();
  const file = join(root, "file");
  const dangling = join(root, "dangling");
  writeFileSync(file, "not state");
  symlinkSync(join(root, "missing"), dangling);
  for (const state of [file, dangling]) {
    const result = stats({ ...env, AGX_STATE_DIR: state });
    expect(result.exitCode).toBe(2);
    const report = reportSchema.safeParse(result.stdout.toString());
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.data.legacy_land.present).toBeNull();
    expect(report.data.legacy_land.status).toBe("refused");
  }
});
