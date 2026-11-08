import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { stateDir } from "./state-dir.ts";

export function gcOrderPath(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hash = createHash("sha256").update(resolve(repo)).digest("hex");
  return join(stateDir(env), "ws-gc-classified", `${hash}.json`);
}

export async function readGcOrder(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, number>> {
  const text = await readFile(gcOrderPath(repo, env), "utf8").catch(() => "");
  const parsed = jsonOf(
    z.record(z.string(), z.number().nonnegative()),
  ).safeParse(text);
  return parsed.success ? parsed.data : {};
}

export async function writeGcOrder(
  repo: string,
  env: NodeJS.ProcessEnv,
  times: Record<string, number>,
): Promise<void> {
  const path = gcOrderPath(repo, env);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await Promise.try(async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(times));
    await rename(temporary, path);
  }).catch(async () => {
    await rm(temporary, { force: true }).catch(() => {});
  });
}

export function orderGcCandidates<T extends { dir: string }>(
  candidates: T[],
  times: Record<string, number>,
): T[] {
  return candidates.toSorted((a, b) => {
    const difference = (times[a.dir] ?? -1) - (times[b.dir] ?? -1);
    return difference === 0 ? a.dir.localeCompare(b.dir) : difference;
  });
}

async function inspectStoreEntry(
  path: string,
  pending: string[],
): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (info?.isFile() === true) return info.size;
  if (info?.isDirectory() !== true) return 0;
  const dir = await opendir(path).catch(() => null);
  if (dir !== null)
    for await (const entry of dir) pending.push(join(path, entry.name));
  return 0;
}

/** Count logical file sizes only until the threshold is crossed; never follow symlinks. */
export async function opStoreSize(
  repo: string,
  threshold = 1024 ** 3,
): Promise<number> {
  const pending = [join(repo, ".jj", "repo", "op_store")];
  let size = 0;
  while (pending.length > 0 && size <= threshold) {
    const path = pending.pop();
    if (path === undefined) break;
    size += await inspectStoreEntry(path, pending).catch(() => 0);
  }
  return size;
}
