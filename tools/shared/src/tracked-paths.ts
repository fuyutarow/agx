/** Enumerate tracked paths through the caller's bounded, read-only VCS runner. */
export function trackedPaths(
  run: (argv: string[]) => { exitCode: number | null; output: string },
): { exitCode: number | null; output: string } {
  const git = run(["git", "rev-parse", "--show-toplevel"]);
  if (git.exitCode === null || git.exitCode === 75) return git;
  if (git.exitCode === 0) return run(["git", "ls-files", "-z"]);
  return run([
    "jj",
    "--ignore-working-copy",
    "--at-operation=@",
    "file",
    "list",
    "-T",
    'path ++ "\\0"',
  ]);
}
