import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { subprocessEnvironment } from "../../../shared/src/subprocess-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([
  ["no declaration", undefined, undefined, 0, ""],
  ["passing", 'test "$AGX_TICKET_PATH" = "$PWD/ticket.md"', 10000, 0, ""],
  [
    "failing",
    'printf "fixture stdout\\n"; printf "fixture stderr\\n" >&2; exit 7',
    10000,
    2,
    "fixture stdout",
  ],
  ["missing timeout", "exit 0", undefined, 2, "check.timeout_ms"],
  [
    "timeout",
    'printf "before timeout\\n"; sleep 10',
    100,
    2,
    "timed out after 100ms",
  ],
] as const)(
  "repository check: %s",
  async (_name, command, timeout, expected, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "agx-repo-check-"));
    roots.push(root);
    const invoke = async (argv: string[], cwd = root) => {
      const child = Bun.spawn(argv, {
        cwd,
        env: {
          ...subprocessEnvironment(),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "xdg"),
          AGX_STATE_DIR: join(root, "state"),
          AGX_NEXT_STATE_DIR: undefined,
          PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
          AGX_CONFIG: resolve(
            "tools/agx-worker/src/roster/policy.example.toml",
          ),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      });
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exit, out, err };
    };
    for (const args of [
      ["jj", "git", "init", "."],
      ["jj", "config", "set", "--repo", 'revset-aliases."trunk()"', "@-"],
    ]) {
      const result = await invoke(args);
      expect(result.exit, result.err).toBe(0);
    }
    let config = "";
    if (command !== undefined) {
      config = `\n[check]\ncommands = [${JSON.stringify(command)}]\n`;
      if (timeout !== undefined) config += `timeout_ms = ${timeout}\n`;
    }
    await writeFile(
      join(root, "agx.toml"),
      `schema = 1\ntickets = "."\n${config}`,
    );
    const committed = await invoke(["jj", "new"]);
    expect(committed.exit, committed.err).toBe(0);
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin", "agx-ws"),
      `#!/bin/sh
ln -s ${JSON.stringify(root)} ${JSON.stringify(join(root, "ws_ticket"))}
printf '{"workspace":"%s"}\n' ${JSON.stringify(join(root, "ws_ticket"))}
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "bin", "agx-worker"),
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("tools/agx-worker/src/next/cli.ts"))} "$@"
`,
      { mode: 0o755 },
    );
    await writeFile(join(root, "bin", "systemctl"), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });
    await writeFile(join(root, "bin", "mise"), '#!/bin/sh\nprintf "{}\\n"\n', {
      mode: 0o755,
    });
    await writeFile(
      join(root, "ticket.md"),
      '+++\nschema = 2\nname = "ticket"\noutcome = "fixture"\nwrites = []\nverify = ["true"]\n[proposition]\nid = "CHECK"\nclaim = "checks run"\nrefuted_by = "launch skips check"\n+++\n',
    );
    const args = [
      process.execPath,
      resolve("tools/agx-worker/src/next/cli.ts"),
    ];
    const check = await invoke([
      ...args,
      "check",
      join(root, "ticket.md"),
      "--cd",
      root,
      "--json",
      "--skip-routing",
    ]);
    expect(check.exit, `${check.out} ${check.err}`).toBe(expected);
    expect(check.err).toContain(diagnostic);
    if (command !== undefined && expected !== 0) {
      if (timeout !== undefined)
        expect(check.err).toContain(JSON.stringify(command));
      const dispatch = await invoke([
        ...args,
        "dispatch",
        join(root, "ticket.md"),
        "--json",
      ]);
      expect(dispatch.exit, `${dispatch.out} ${dispatch.err}`).toBe(2);
      expect(dispatch.err).toContain(diagnostic);
      if (diagnostic === "fixture stdout")
        expect(dispatch.err).toContain("fixture stderr");
    }
  },
  60000,
);
