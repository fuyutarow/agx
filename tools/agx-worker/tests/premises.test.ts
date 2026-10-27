import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPremises, PREMISE_KINDS, premiseHelp } from "../src/premises.ts";
import { createTempTracker } from "./temp.ts";
import { subprocessEnvironment } from "../../shared/src/subprocess-env.ts";

const tempDirs = createTempTracker();
const registerTempDir = tempDirs.register;

const scratch = registerTempDir(
  mkdtempSync(join(tmpdir(), `agx-test-${process.pid}-premises-`)),
);
const source = join(scratch, "src");
const docs = join(scratch, "docs");
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  tempDirs.assertRemoved();
});
mkdirSync(join(source, "next"), { recursive: true });
mkdirSync(docs);
writeFileSync(
  join(source, "next", "cli.ts"),
  "export function routeWorker() {}\n",
);
writeFileSync(join(docs, "design.md"), "routeWorker is the entry point\n");

const fakeRg = (argv: string[], cwd: string) => {
  const patternAt = argv.indexOf("--glob");
  const glob = patternAt < 0 ? undefined : argv[patternAt + 1];
  const separator = argv.indexOf("--");
  const needle = argv[separator + 1] ?? "";
  const paths = ["src/next/cli.ts", "docs/design.md"].filter(
    (path) => glob === undefined || new Bun.Glob(glob).match(path),
  );
  const matches = paths.filter((path) =>
    readFileSync(join(cwd, path), "utf8").includes(needle),
  );
  return { exitCode: matches.length === 0 ? 1 : 0, output: matches.join("\n") };
};

describe("premise checks", () => {
  test("check help documents premises and every parser kind", () => {
    const result = Bun.spawnSync(
      ["bun", "tools/agx-worker/src/next/cli.ts", "check", "--help"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    expect(help).toContain("premises = [...]");
    for (const kind of PREMISE_KINDS) expect(help).toContain(`  ${kind}:`);
    expect(help).toContain(premiseHelp());
  });

  test("ancestor premise passes when the commit is an ancestor or equal", () => {
    const repo = join(scratch, "ancestor-jj");
    mkdirSync(join(repo, ".jj"), { recursive: true });
    const commit = "60cfaa97abcdef01234567890123456789012345";
    const revision = "abcdef0123456789012345678901234567890123";
    const calls: string[][] = [];
    const result = checkPremises(["ancestor:60cfaa97@alpha@origin"], repo, {
      runner: (argv) => {
        calls.push(argv);
        if (argv.includes("-r")) {
          const expression = argv[argv.indexOf("-r") + 1];
          if (expression === "60cfaa97") return { exitCode: 0, output: commit };
          if (expression === "alpha@origin")
            return { exitCode: 0, output: revision };
          if (expression === `ancestors(${revision}) & ${commit}`)
            return { exitCode: 0, output: commit };
        }
        return { exitCode: 1, output: "unexpected revision" };
      },
    });
    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(3);
  });

  test("an unlanded ancestor premise names its commit and current revision", () => {
    const repo = join(scratch, "unlanded-ancestor-jj");
    mkdirSync(join(repo, ".jj"), { recursive: true });
    const commit = "60cfaa97abcdef01234567890123456789012345";
    const revision = "abcdef0123456789012345678901234567890123";
    expect(
      checkPremises(["ancestor:60cfaa97@alpha@origin"], repo, {
        runner: (argv) => {
          if (argv.includes("-r")) {
            const expression = argv[argv.indexOf("-r") + 1];
            if (expression === "60cfaa97")
              return { exitCode: 0, output: commit };
            if (expression === "alpha@origin")
              return { exitCode: 0, output: revision };
            if (expression === `ancestors(${revision}) & ${commit}`)
              return { exitCode: 0, output: "" };
          }
          return { exitCode: 1, output: "unexpected revision" };
        },
      }),
    ).toEqual({
      status: "missing",
      premises: ["ancestor:60cfaa97@alpha@origin"],
      details: [
        `ancestor:60cfaa97@alpha@origin: commit ${commit} is not an ancestor of revision alpha@origin; revision alpha@origin currently points to ${revision}`,
      ],
    });
  });

  test("tracked symbol selection uses imported enumeration and bounded VCS reads", () => {
    const repo = join(scratch, "tracked-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const calls: string[][] = [];
    const result = checkPremises(["symbol:needle"], repo, {
      runner: (argv) => {
        calls.push(argv);
        if (argv.includes("rev-parse")) return { exitCode: 0, output: repo };
        if (argv.includes("ls-files"))
          return { exitCode: 0, output: "src/tracked.ts\0" };
        return { exitCode: 0, output: "src/tracked.ts" };
      },
    });
    expect(result).toEqual({ status: "ok" });
    expect(calls.map((argv) => argv[0])).toEqual(["git", "git", "rg"]);
    expect(calls.at(-1)).toEqual([
      "rg",
      "--fixed-strings",
      "--files-with-matches",
      "--",
      "needle",
      "src/tracked.ts",
    ]);
  });

  test("an empty tracked selection reports missing symbols without searching untracked files", () => {
    const repo = join(scratch, "empty-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const calls: string[][] = [];
    expect(
      checkPremises(["symbol:needle"], repo, {
        runner: (argv) => {
          calls.push(argv);
          return { exitCode: 0, output: "" };
        },
      }),
    ).toEqual({
      status: "missing",
      premises: ["symbol:needle"],
      details: ["symbol:needle: no matching text"],
    });
    expect(calls.map((argv) => argv[0])).toEqual(["git", "git"]);
  });

  test("every bounded jj premise read disables snapshots and operation reconciliation", () => {
    const calls: string[][] = [];
    const runner = (argv: string[]) => {
      calls.push(argv);
      return {
        exitCode: 0,
        output: argv.includes("bookmark") ? "main\n" : "root-or-revision",
      };
    };
    expect(
      checkPremises(["bookmark:main", "rev:@"], scratch, { runner }),
    ).toEqual({ status: "ok" });
    expect(calls).toHaveLength(3);
    for (const argv of calls) {
      expect(argv[0]).toBe("jj");
      expect(argv).toContain("--ignore-working-copy");
      expect(argv).toContain("--at-operation=@");
    }
  });
  test("present file and symbol premises pass", () => {
    expect(
      checkPremises(["file:src/next/cli.ts", "symbol:routeWorker"], scratch, {
        runner: fakeRg,
      }),
    ).toEqual({ status: "ok" });
  });

  test("an absent file premise is reported", () => {
    expect(checkPremises(["file:src/missing.ts"], scratch)).toEqual({
      status: "missing",
      premises: ["file:src/missing.ts"],
      details: [
        "file:src/missing.ts: file does not exist; check=file-exists expected=true observed=false",
      ],
    });
  });

  test("an absent symbol premise is reported", () => {
    expect(
      checkPremises(["symbol:missingFunction"], scratch, { runner: fakeRg }),
    ).toEqual({
      status: "missing",
      premises: ["symbol:missingFunction"],
      details: ["symbol:missingFunction: no matching text"],
    });
  });

  test("a symbol glob restricts the search", () => {
    expect(
      checkPremises(["symbol:routeWorker@src/**"], scratch, {
        runner: fakeRg,
      }),
    ).toEqual({ status: "ok" });
    expect(
      checkPremises(["symbol:routeWorker@tests/**"], scratch, {
        runner: fakeRg,
      }),
    ).toEqual({
      status: "missing",
      premises: ["symbol:routeWorker@tests/**"],
      details: ["symbol:routeWorker@tests/**: no matching text"],
    });
  });

  const withFakeTools = (
    tools: Record<string, string>,
    run: (
      runner: (
        argv: string[],
        cwd: string,
        timeoutMs: number,
      ) => { exitCode: number | null; output: string },
    ) => void,
  ): void => {
    const bin = join(scratch, "fake-bin");
    mkdirSync(bin, { recursive: true });
    for (const [name, script] of Object.entries(tools)) {
      const path = join(bin, name);
      writeFileSync(
        path,
        `#!/bin/sh\n${name === "jj" ? 'if [ "$1" = "--version" ]; then echo "jj 0.46.0"; exit 0; fi\n' : ""}${script}\n`,
      );
      chmodSync(path, 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    using _restorePath = {
      [Symbol.dispose]: () => {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
      },
    };
    run((argv, cwd, timeoutMs) => {
      const command = argv.filter(
        (arg) => arg !== "--ignore-working-copy" && arg !== "--at-operation=@",
      );
      const result = Bun.spawnSync(
        ["sh", "-c", 'exec "$@"', "agx-test", ...command],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...subprocessEnvironment() },
          timeout: Math.max(1, Math.floor(timeoutMs)),
        },
      );
      return {
        exitCode: result.exitCode,
        output: `${result.stdout.toString()}${result.stderr.toString()}`,
      };
    });
  };

  test("bookmark, task, and rev premises pass or refuse using fake PATH tools", () => {
    withFakeTools(
      {
        jj: 'if [ "$1" = root ]; then echo fake-root; exit 0; fi\nif [ "$1" = bookmark ]; then\n  if [ "$4" != "-T" ]; then echo "human bookmark output"; echo "  multiline description"; exit 0; fi\n  echo "main"; echo "release@origin"; echo "wip-u26-headroom: qzmvvrst 0a83339d wip(u26): ..."; echo "  description continuation"; echo "  final description line"; exit 0\nfi\nif [ "$1" = log ] && [ "$3" = @ ]; then echo abc123; exit 0; fi\necho "No revisions match" >&2\nexit 1',
        mise: `echo '[{"name":"land"},{"name":"check"}]'`,
      },
      (runner) => {
        expect(
          checkPremises(["bookmark:main", "bookmark:release@origin"], scratch, {
            runner,
          }),
        ).toEqual({ status: "ok" });
        expect(checkPremises(["task:land"], scratch, { runner })).toEqual({
          status: "ok",
        });
        expect(checkPremises(["rev:@"], scratch, { runner })).toEqual({
          status: "ok",
        });
        expect(
          checkPremises(["bookmark:unknown@origin"], scratch, { runner }),
        ).toEqual({
          status: "missing",
          premises: ["bookmark:unknown@origin"],
          details: [
            "bookmark:unknown@origin: check=bookmark-exists expected=true observed=false exit=0; main\nrelease@origin\nwip-u26-headroom: qzmvvrst 0a83339d wip(u26): ...\ndescription continuation\nfinal description line",
          ],
        });
        expect(checkPremises(["task:missing"], scratch, { runner })).toEqual({
          status: "missing",
          premises: ["task:missing"],
          details: [
            'task:missing: check=task-exists expected=true observed=false exit=0; [{"name":"land"},{"name":"check"}]',
          ],
        });
        expect(checkPremises(["rev:missing()"], scratch, { runner })).toEqual({
          status: "missing",
          premises: ["rev:missing()"],
          details: [
            "rev:missing(): check=rev-exists expected=true observed=false exit=1; No revisions match",
          ],
        });
      },
    );
  });

  test("a timeout skips the check without refusing", () => {
    expect(
      checkPremises(["symbol:routeWorker"], scratch, {
        runner: () => ({ exitCode: null, output: "" }),
      }),
    ).toEqual({ status: "timeout" });
  });
});
