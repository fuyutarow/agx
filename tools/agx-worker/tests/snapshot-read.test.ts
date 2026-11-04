import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  append,
  flushRunPublications,
  publishCurrentRuns,
  recordPath,
} from "../src/next/store.ts";

const cli = join(import.meta.dir, "../src/next/cli.ts");
const roots: string[] = [];
afterEach(async () => {
  await flushRunPublications();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "agx-snapshot-read-"));
  roots.push(root);
  return root;
};
const foldFile = (root: string) => join(root, "records.snapshot.json");

/** Two records per run; names are fixed width so a byte can be rewritten in place. */
const addRun = (root: string, name: string, minute: number) => {
  const id = `run-${name}`;
  append(
    {
      kind: "started",
      id,
      at: `2026-10-15T00:${String(minute).padStart(2, "0")}:00Z`,
      ticket: `ticket-${name}`,
      writes: [],
      cwd: "/tmp",
      workspace: "/tmp",
      row: "terra-medium",
      dispatcher_session: null,
      vendor_session: null,
      pid: 2147483647,
    },
    root,
    false,
  );
  append(
    {
      kind: "ended",
      id,
      at: `2026-10-15T00:${String(minute).padStart(2, "0")}:30Z`,
      exit: 0,
      report_path: null,
      vendor_session: null,
      verify: [],
    },
    root,
    false,
  );
};
const published = async (names: string[]) => {
  const root = fresh();
  names.forEach((name, index) => addRun(root, name, index));
  await publishCurrentRuns(root);
  expect(statSync(foldFile(root)).isFile()).toBe(true);
  return root;
};
const lsJson = (root: string) => {
  const result = Bun.spawnSync([process.execPath, cli, "ls", "--json"], {
    env: { ...process.env, AGX_STATE_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString("utf8");
};
/** The reference answer: the same log with no published fold, so every record is folded. */
const fullFold = (root: string) => {
  const reference = fresh();
  copyFileSync(recordPath(root), recordPath(reference));
  return lsJson(reference);
};
/** Rewrite `from` to `to` (same byte length) at its first occurrence in the log. */
const rewriteInPlace = (root: string, from: string, to: string) => {
  expect(to.length).toBe(from.length);
  const path = recordPath(root);
  const text = readFileSync(path, "utf8");
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
};
const tree = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const info = statSync(path);
      return `${path} ${info.size} ${info.mtimeMs}`;
    })
    .toSorted();

test("a snapshot matching the log gives the full-fold output without folding the log", async () => {
  const root = await published(["aaaa", "bbbb", "cccc"]);
  expect(lsJson(root)).toBe(fullFold(root));
  // Rewriting an early record leaves the prefix identity (inode, length, last line) intact; a
  // reader that folded the log would show the rewrite, one that used the snapshot does not.
  rewriteInPlace(root, "ticket-aaaa", "ticket-ZZZZ");
  expect(lsJson(root)).toContain("ticket-aaaa");
  expect(lsJson(root)).not.toContain("ticket-ZZZZ");
  expect(fullFold(root)).toContain("ticket-ZZZZ");
});

test("records appended after the snapshot are folded on top of it", async () => {
  const root = await published(["aaaa", "bbbb"]);
  addRun(root, "cccc", 10);
  addRun(root, "dddd", 11);
  const output = lsJson(root);
  expect(output).toBe(fullFold(root));
  expect(output).toContain("run-cccc");
  expect(output).toContain("run-dddd");
  // The folded prefix still comes from the snapshot, not from the log.
  rewriteInPlace(root, "ticket-aaaa", "ticket-ZZZZ");
  expect(lsJson(root)).toContain("ticket-aaaa");
});

test("a snapshot whose identity does not match the log is ignored", async () => {
  // Last record changed: the hash of the folded prefix's last line no longer matches.
  const edited = await published(["aaaa", "bbbb"]);
  rewriteInPlace(edited, "ticket-aaaa", "ticket-ZZZZ");
  rewriteInPlace(edited, "2026-10-15T00:01:30Z", "2026-10-15T00:01:31Z");
  expect(lsJson(edited)).toBe(fullFold(edited));
  expect(lsJson(edited)).toContain("ticket-ZZZZ");

  // Another file under the same name: the inode differs even though every byte is the same.
  const replaced = await published(["aaaa", "bbbb"]);
  rewriteInPlace(replaced, "ticket-aaaa", "ticket-ZZZZ");
  const swap = recordPath(replaced) + ".swap";
  copyFileSync(recordPath(replaced), swap);
  renameSync(swap, recordPath(replaced));
  expect(lsJson(replaced)).toContain("ticket-ZZZZ");

  // Truncated log: shorter than the folded prefix.
  const truncated = await published(["aaaa", "bbbb"]);
  const lines = readFileSync(recordPath(truncated), "utf8").split("\n");
  writeFileSync(recordPath(truncated), lines.slice(0, 2).join("\n") + "\n");
  const answer = lsJson(truncated);
  expect(answer).toBe(fullFold(truncated));
  expect(answer).not.toContain("run-bbbb");

  // Written by another release, or damaged: not trusted.
  const foreign = await published(["aaaa", "bbbb"]);
  rewriteInPlace(foreign, "ticket-aaaa", "ticket-ZZZZ");
  const file = JSON.parse(readFileSync(foldFile(foreign), "utf8"));
  writeFileSync(
    foldFile(foreign),
    JSON.stringify({ ...file, writer: "0.0.0-other" }),
  );
  expect(lsJson(foreign)).toContain("ticket-ZZZZ");
  writeFileSync(foldFile(foreign), "{not json");
  expect(lsJson(foreign)).toContain("ticket-ZZZZ");
});

test("ls writes no file, with or without a usable snapshot", async () => {
  const root = await published(["aaaa", "bbbb"]);
  addRun(root, "cccc", 10);
  const before = tree(root);
  lsJson(root);
  expect(tree(root)).toEqual(before);

  const bare = fresh();
  addRun(bare, "aaaa", 0);
  const bareBefore = tree(bare);
  lsJson(bare);
  expect(tree(bare)).toEqual(bareBefore);
});
