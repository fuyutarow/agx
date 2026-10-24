import { appendFile, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { attempt, type Attempt } from "../../shared/src/attempt.ts";
import { readJsonlLines } from "../../shared/src/jsonl.ts";
import { jsonOf, z } from "../../shared/src/zod.ts";
import { stateDir } from "./state-dir.ts";

const Entry = z.object({
  root: z.string().refine(isAbsolute),
  workspace: z.string().refine(isAbsolute),
});
const indexPath = () => join(stateDir(), "workspace-index.jsonl");

/** Append-only creation history; readers fail closed on damaged entries. */
export async function recordWorkspace(root: string, workspace: string) {
  return attempt(async () => {
    await mkdir(stateDir(), { recursive: true });
    await appendFile(indexPath(), JSON.stringify({ root, workspace }) + "\n", {
      mode: 0o600,
    });
  });
}

export async function indexedWorkspaces(): Promise<
  Attempt<z.output<typeof Entry>[]>
> {
  const entries: z.output<typeof Entry>[] = [];
  const read = await attempt(async () => {
    const lines: string[] = [];
    for await (const line of readJsonlLines(indexPath())) lines.push(line);
    return lines;
  });
  if (!read.ok)
    return z.object({ code: z.literal("ENOENT") }).safeParse(read.error).success
      ? { ok: true, value: [] }
      : read;
  for (const line of read.value) {
    const parsed = jsonOf(Entry).safeParse(line);
    if (!parsed.success) return { ok: false, error: parsed.error };
    entries.push(parsed.data);
  }
  return { ok: true, value: entries };
}
