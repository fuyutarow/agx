import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ticketContext } from "./ticket-home.ts";
import type { FoldedRun } from "./run-state.ts";

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };
type JjRepo = { root: string; remote: string };
type Publication =
  | { kind: "not-worker-store" }
  | { kind: "no-commits" }
  | { kind: "published"; bookmark: string; commit: string };

const good = <T>(value: T): Attempt<T> => ({ ok: true, value });
const bad = (error: string): Attempt<never> => ({ ok: false, error });

function inside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail === "" || (!tail.startsWith(`..${sep}`) && tail !== "..");
}

function localStore(workspace: string): boolean {
  const marker = join(workspace, ".jj", "repo");
  if (!existsSync(marker)) return false;
  try {
    const info = lstatSync(marker);
    const path = info.isDirectory()
      ? marker
      : resolve(dirname(marker), readFileSync(marker, "utf8").trim());
    return inside(realpathSync(workspace), realpathSync(path));
  } catch {
    return false;
  }
}

function sourceRepo(root: string): JjRepo | undefined {
  let workspace = resolve(root);
  while (!existsSync(join(workspace, ".jj", "repo"))) {
    const parent = dirname(workspace);
    if (parent === workspace) return undefined;
    workspace = parent;
  }
  const marker = join(workspace, ".jj", "repo");
  try {
    const info = lstatSync(marker);
    const repo = realpathSync(
      info.isDirectory()
        ? marker
        : resolve(dirname(marker), readFileSync(marker, "utf8").trim()),
    );
    const backingRoot = dirname(dirname(repo));
    const colocated = join(backingRoot, ".git");
    if (existsSync(colocated))
      return { root: backingRoot, remote: backingRoot };
    const store = join(repo, "store");
    const target = join(store, "git_target");
    if (existsSync(target))
      return {
        root: backingRoot,
        remote: realpathSync(
          resolve(store, readFileSync(target, "utf8").trim()),
        ),
      };
    const git = join(store, "git");
    return existsSync(git) ? { root: backingRoot, remote: git } : undefined;
  } catch {
    return undefined;
  }
}

function jj(args: string[], cwd: string): Attempt<string> {
  const command = ["jj", "--no-pager", "--color=never", ...args];
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 900_000,
    killSignal: "SIGKILL",
  });
  if (result.exitCode !== 0)
    return bad(
      `${command.join(" ")} failed (exit ${result.exitCode ?? "signal"}): ${result.stderr.toString().trim()}`,
    );
  return good(result.stdout.toString());
}

/** Publish one accepted workspace's non-empty commit chain to its source checkout. */
export async function publishAcceptedWorker(
  run: Pick<FoldedRun, "id" | "workspace" | "ticket_path">,
): Promise<Attempt<Publication>> {
  const workspace = resolve(run.workspace);
  if (!localStore(workspace)) return good({ kind: "not-worker-store" });
  if (run.ticket_path === undefined || run.ticket_path === "")
    return bad("isolated worker run has no recorded ticket path");

  const ticket = await ticketContext(dirname(resolve(run.ticket_path)));
  if (!ticket.ok)
    return bad(`cannot resolve worker source repository: ${ticket.error}`);
  const source = sourceRepo(ticket.root);
  if (source === undefined)
    return bad("cannot locate the worker source Git store");

  const remotes = jj(["git", "remote", "list"], workspace);
  if (!remotes.ok) return remotes;
  const rows = remotes.value.trim().split("\n").filter(Boolean);
  if (rows.length !== 1 || !rows[0]?.startsWith("origin "))
    return bad("worker store must have exactly one remote named origin");
  const remotePath = rows[0].slice("origin ".length).trim();
  let actualRemote: string;
  try {
    actualRemote = realpathSync(remotePath);
  } catch {
    return bad(`worker origin is unavailable: ${remotePath}`);
  }
  if (actualRemote !== realpathSync(source.remote))
    return bad(
      `worker origin ${actualRemote} does not match its source store ${source.remote}`,
    );

  const status = jj(["status"], workspace);
  if (!status.ok) return status;
  const commits = jj(
    [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      "heads(ancestors(@) & ~empty() & ~remote_bookmarks())",
      "-T",
      'commit_id ++ "\\n"',
    ],
    workspace,
  );
  if (!commits.ok) return commits;
  const ids = commits.value.trim().split("\n").filter(Boolean);
  if (ids.length === 0) return good({ kind: "no-commits" });
  if (ids.length !== 1)
    return bad(`accepted worker has ${ids.length} divergent commit heads`);
  const commit = ids[0];
  if (commit === undefined) return bad("accepted worker commit is missing");
  const bookmark = `agx-worker-${createHash("sha256").update(run.id).digest("hex")}`;
  const set = jj(["bookmark", "set", bookmark, "-r", commit], workspace);
  if (!set.ok) return set;
  const pushed = jj(
    ["git", "push", "--remote", "origin", "--bookmark", bookmark],
    workspace,
  );
  if (!pushed.ok) return pushed;
  const imported = jj(["--ignore-working-copy", "git", "import"], source.root);
  if (!imported.ok) return imported;
  const visible = jj(
    [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      bookmark,
      "-T",
      "commit_id",
    ],
    source.root,
  );
  if (!visible.ok) return visible;
  if (visible.value.trim() !== commit)
    return bad(
      `shared store imported ${visible.value.trim() || "no commit"}, expected worker commit ${commit}`,
    );
  return good({ kind: "published", bookmark, commit });
}
