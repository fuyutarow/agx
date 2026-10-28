import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgxConfigError,
  listAgxRepos,
  normalizeTomlIntegers,
  resolveAgxConfig,
} from "../src/agx-config.ts";

const roots: string[] = [];
const originalXdg = process.env.XDG_CONFIG_HOME;
afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(policy?: string) {
  const parent = await mkdtemp(join(tmpdir(), "agx-config-"));
  roots.push(parent);
  process.env.XDG_CONFIG_HOME = join(parent, "config");
  const localDirectory = join(process.env.XDG_CONFIG_HOME, "agx/repos");
  await mkdir(localDirectory, { recursive: true });
  const local = join(localDirectory, "repo.toml");
  const root = join(parent, "repo");
  await mkdir(root);
  const jj = async (args: string[]) => {
    const child = Bun.spawn(["jj", ...args], {
      cwd: root,
      env: {
        ...process.env,
        JJ_CONFIG: "",
        JJ_USER: "Fixture",
        JJ_EMAIL: "fixture@example.invalid",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, err).toBe(0);
    return out.trim();
  };
  await jj(["git", "init", "."]);
  await jj([
    "config",
    "set",
    "--repo",
    'revset-aliases."trunk()"',
    "bookmarks(main)",
  ]);
  if (policy !== undefined) await writeFile(join(root, "agx.toml"), policy);
  await writeFile(join(root, "base"), "base\n");
  await jj(["commit", "-m", "Base policy"]);
  await jj(["bookmark", "create", "main", "-r", "@-"]);
  const writeLocal = (text: string) =>
    writeFile(local, `root = ${JSON.stringify(root)}\n${text}`);
  return { parent, root, jj, local, localDirectory, writeLocal };
}

async function gitFixture(policy?: string) {
  const parent = await mkdtemp(join(tmpdir(), "agx-config-git-"));
  roots.push(parent);
  process.env.XDG_CONFIG_HOME = join(parent, "config");
  const root = join(parent, "repo");
  await mkdir(root);
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, err).toBe(0);
    return out.trim();
  };
  await git(["init", "-q"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "base"), "base\n");
  if (policy !== undefined) await writeFile(join(root, "agx.toml"), policy);
  await git(["add", "base", ...(policy === undefined ? [] : ["agx.toml"])]);
  await git(["commit", "-m", "Base policy"]);
  return { parent, root };
}

const home = async (root: string) => {
  const result = await resolveAgxConfig(root);
  expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  return result.ok ? result.value.tickets : undefined;
};
test("defaults without files and schema-only policy", async () => {
  for (const policy of [undefined, "schema = 1\n"]) {
    const f = await fixture(policy);
    expect(await home(f.root)).toBe(join(f.root, ".agents/tickets"));
    const result = await resolveAgxConfig(f.root);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toMatchObject({
        policySource:
          policy === undefined
            ? "built-in defaults (trunk has no agx.toml)"
            : "agx.toml (trunk)",
        ready: [],
        trunk: "trunk()",
        trunkConfigured: false,
        keep: [],
        regenerable: [],
        verifyAlways: [],
      });
  }
});
test("config contract: a schema = 1 agx.toml with [ws] is accepted", async () => {
  const f = await fixture(
    'schema = 1\n\n[ws]\nready = ["mise run check"]\ntrunk = "alpha"\n',
  );
  const result = await resolveAgxConfig(f.root);
  expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      ready: ["mise run check"],
      trunk: "alpha",
      trunkConfigured: true,
    });
});
test("config contract: [ws] accepts ready, trunk, keep and regenerable", async () => {
  const f = await fixture(
    '# repository policy\nschema = 1\n\n# workspace policy\n[ws]\nready = ["mise run check"]\ntrunk = "trunk()"\nkeep = ["ws_safe"]\nregenerable = [".rumdl_cache/"]\n',
  );
  const result = await resolveAgxConfig(f.root);
  expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      ready: ["mise run check"],
      trunk: "trunk()",
      keep: ["ws_safe"],
      regenerable: [".rumdl_cache/"],
    });
});
test("config contract: an unknown [ws] key is named with its path", async () => {
  const f = await fixture("schema = 1\n[ws]\nunknown = true\n");
  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(String(result.error)).toContain("agx.toml at main ");
    expect(String(result.error)).toContain("ws.unknown: unknown key");
    expect(String(result.error)).not.toContain("schema");
  }
});
test("config contract: missing and wrong schema name the expected value", async () => {
  const missingFixture = await fixture('[ws]\nready = ["mise run check"]\n');
  const missing = await resolveAgxConfig(missingFixture.root);
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(String(missing.error)).toContain("agx.toml at main ");
    expect(String(missing.error)).toContain(
      "missing required schema; expected schema = 1",
    );
    expect(String(missing.error)).not.toContain("unsupported schema");
  }

  const wrongFixture = await fixture(
    'schema = 2\n[ws]\nready = ["mise run check"]\n',
  );
  const wrong = await resolveAgxConfig(wrongFixture.root);
  expect(wrong.ok).toBe(false);
  if (!wrong.ok) {
    expect(String(wrong.error)).toContain("agx.toml at main ");
    expect(String(wrong.error)).toContain(
      "unsupported schema 2; expected schema = 1",
    );
    expect(String(wrong.error)).not.toContain("missing required schema");
  }
});
test("config contract: refusal names committed revision when working copy differs", async () => {
  const committed = '[ws]\nready = ["committed policy"]\n';
  const f = await fixture(committed);
  await writeFile(join(f.root, "agx.toml"), `schema = 1\n${committed}`);
  const revision = await f.jj([
    "log",
    "--no-graph",
    "-r",
    "trunk()",
    "-T",
    'bookmarks.join(", ") ++ " " ++ commit_id.short(8)',
  ]);
  expect(revision).toMatch(/^main [a-f0-9]{8}$/u);

  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(String(result.error)).toContain(`agx.toml at ${revision}`);
    expect(String(result.error)).toContain(
      "working copy differs from this revision",
    );
    expect(String(result.error)).toContain("working copy policy is not read");
    expect(String(result.error)).toContain(
      "missing required schema; expected schema = 1",
    );
  }
});
test("config contract: schema = 2 is refused", async () => {
  const f = await fixture('schema = 2\n\n[ws]\nready = ["mise run check"]\n');
  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AgxConfigError);
    expect(String(result.error)).toContain("schema");
  }
});
test("TOML decode normalizes nested safe integer values", () => {
  const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  expect(
    normalizeTomlIntegers({ schema: 1n, nested: [{ edition: 2n }], tooLarge }),
  ).toEqual({ schema: 1, nested: [{ edition: 2 }], tooLarge });
});
test("verify.always replaces by key from L1 to L2, including an empty override", async () => {
  const f = await fixture(
    'schema = 1\n[verify]\nalways = ["first", "second"]\n',
  );
  const commands = async () => {
    const result = await resolveAgxConfig(f.root);
    expect(result.ok).toBe(true);
    return result.ok ? result.value.verifyAlways : undefined;
  };
  expect(await commands()).toEqual(["first", "second"]);
  await f.writeLocal('schema = 1\n[verify]\nalways = ["local"]\n');
  expect(await commands()).toEqual(["local"]);
  await f.writeLocal("schema = 1\n[verify]\n");
  expect(await commands()).toEqual(["first", "second"]);
  await f.writeLocal("schema = 1\n[verify]\nalways = []\n");
  expect(await commands()).toEqual([]);
});
test("L2 can declare verify.always without L1", async () => {
  const f = await fixture();
  await f.writeLocal('schema = 1\n[verify]\nalways = ["local"]\n');
  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.verifyAlways).toEqual(["local"]);
});
test.each([
  'verify = "wrong"',
  "[verify]\nunknown = []",
  '[verify]\nalways = "wrong"',
  "[verify]\nalways = [1]",
  '[verify]\nalways = [""]',
  '[verify]\nalways = ["   "]',
])("rejects invalid verify config at both layers: %s", async (table) => {
  for (const layer of ["L1", "L2"]) {
    const f = await fixture(
      layer === "L1" ? `schema = 1\n${table}\n` : undefined,
    );
    await f.writeLocal(
      `schema = 1\n${layer === "L2" ? table : '[verify]\nalways = ["valid override"]'}\n`,
    );
    const result = await resolveAgxConfig(f.root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AgxConfigError);
      expect(String(result.error)).toContain(
        layer === "L1" ? "agx.toml" : "repo.toml",
      );
    }
  }
});
test("ws contract: agx.toml [ws] is the only policy", async () => {
  const f = await fixture(
    'schema = 1\n[ws]\nready = ["l1 one", "l1 two"]\ntrunk = "alpha"\nkeep = ["l1 keep", "shared"]\nregenerable = ["build/generated"]\n',
  );
  let result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      ready: ["l1 one", "l1 two"],
      trunk: "alpha",
      trunkConfigured: true,
      keep: ["l1 keep", "shared"],
      regenerable: ["build/generated"],
    });

  await f.writeLocal(
    'schema = 1\n[ws]\nready = ["l2"]\nkeep = ["l2 keep", "shared"]\n',
  );
  result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      ready: ["l2"],
      trunk: "alpha",
      keep: ["l1 keep", "shared", "l2 keep"],
      regenerable: ["build/generated"],
    });

  await f.writeLocal('schema = 1\n[ws]\nkeep = ["still kept"]\n');
  result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      ready: ["l1 one", "l1 two"],
      trunk: "alpha",
      keep: ["l1 keep", "shared", "still kept"],
      regenerable: ["build/generated"],
    });
});
test.each(['trunk = "main"', 'regenerable = ["build"]'])(
  "L2 workspace policy is restricted to ready and keep: %s",
  async (setting) => {
    const f = await fixture();
    await f.writeLocal(`schema = 1\n[ws]\n${setting}\n`);
    const result = await resolveAgxConfig(f.root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AgxConfigError);
      expect(String(result.error)).toContain(setting.split(" ")[0] ?? setting);
      expect(String(result.error)).toContain("repo.toml");
    }
  },
);
test("only trunk policy is authoritative, including committed nontrunk edits", async () => {
  const f = await fixture(
    'schema = 1\ntickets = "committed"\n[ws]\nready = ["later"]\n',
  );
  await writeFile(join(f.root, "agx.toml"), 'schema = 1\ntickets = "dirty"\n');
  const heads = await readdir(join(f.root, ".jj/repo/op_heads"));
  const bytes = await readFile(join(f.root, "agx.toml"), "utf8");
  expect(await home(f.root)).toBe(join(f.root, "committed"));
  expect(await readdir(join(f.root, ".jj/repo/op_heads"))).toEqual(heads);
  expect(await readFile(join(f.root, "agx.toml"), "utf8")).toBe(bytes);
  await f.jj(["commit", "-m", "Nontrunk policy"]);
  expect(await home(f.root)).toBe(join(f.root, "committed"));
});
test("config contract: an untracked agx.toml is the policy when trunk has none", async () => {
  const f = await gitFixture();
  await mkdir(join(f.root, ".git/info"), { recursive: true });
  await writeFile(join(f.root, ".git/info/exclude"), "agx.toml\n");
  await writeFile(
    join(f.root, "agx.toml"),
    'schema = 1\n[ws]\nready = ["mise trust", "bun install"]\n',
  );
  const result = await resolveAgxConfig(f.root, { vcs: "git" });
  expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      policySource:
        "agx.toml (untracked, default workspace; trunk has none)",
      ready: ["mise trust", "bun install"],
    });
});
test("config contract: trunk agx.toml wins over an untracked working copy", async () => {
  const f = await fixture(
    'schema = 1\n[ws]\nready = ["trunk setup"]\n',
  );
  const secondary = join(f.parent, "secondary");
  await f.jj(["workspace", "add", "--name", "secondary", "-r", "root()", secondary]);
  await writeFile(
    join(secondary, "agx.toml"),
    'schema = 1\n[ws]\nready = ["local setup"]\n',
  );
  const result = await resolveAgxConfig(secondary);
  expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      policySource: "agx.toml (trunk)",
      ready: ["trunk setup"],
    });
});
test("config contract: an uncommitted edit to a tracked agx.toml is not read", async () => {
  const f = await fixture(
    'schema = 1\n[ws]\nready = ["trunk setup"]\n',
  );
  await writeFile(
    join(f.root, "agx.toml"),
    'schema = 1\n[ws]\nready = ["uncommitted setup"]\n',
  );
  const result = await resolveAgxConfig(f.root);
  expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  if (result.ok)
    expect(result.value).toMatchObject({
      policySource: "agx.toml (trunk)",
      ready: ["trunk setup"],
    });
});
test("XDG L2 replaces per key and is selected by main checkout root", async () => {
  const f = await fixture('schema = 1\ntickets = "policy"\n');
  await writeFile(
    join(f.root, "repo.toml"),
    "invalid repository-local file must be ignored",
  );
  const secondary = join(f.parent, "secondary");
  await f.jj(["workspace", "add", "--name", "secondary", secondary]);
  const local = join(f.parent, "local-tickets");
  await f.writeLocal(`schema = 1\ntickets = ${JSON.stringify(local)}\n`);
  await writeFile(
    join(secondary, "repo.toml"),
    'schema = 1\ntickets = "wrong"\n',
  );
  expect(await home(f.root)).toBe(local);
  expect(await home(secondary)).toBe(local);
  await f.writeLocal("schema = 1\n[ws]\nkeep = []\n");
  expect(await home(secondary)).toBe(join(f.root, "policy"));
  await f.writeLocal('schema = 1\ntickets = "relative-local"\n');
  expect(await home(secondary)).toBe(join(f.root, "relative-local"));
});
test("old workspace bases cannot supply policy or the retired-file refusal", async () => {
  const f = await fixture('schema = 1\ntickets = "trunk-tickets"\n');
  await writeFile(join(f.root, ".agx.toml"), "legacy\n");
  await writeFile(
    join(f.root, "agx.toml"),
    'schema = 1\ntickets = "old-tickets"\n',
  );
  await f.jj(["commit", "-m", "Old workspace policy"]);
  const secondary = join(f.parent, "secondary");
  await f.jj([
    "workspace",
    "add",
    "--name",
    "secondary",
    "-r",
    "@-",
    secondary,
  ]);
  await f.jj(["new", "main"]);
  const heads = await readdir(join(f.root, ".jj/repo/op_heads"));
  expect(await home(secondary)).toBe(join(f.root, "trunk-tickets"));
  const local = join(f.parent, "local-tickets");
  await f.writeLocal(`schema = 1\ntickets = ${JSON.stringify(local)}\n`);
  expect(await home(secondary)).toBe(local);
  expect(await readdir(join(f.root, ".jj/repo/op_heads"))).toEqual(heads);
});

test.each(["working", "trunk", "recorded-workspace", "secondary"])(
  "only trunk supplies retired-file refusal: %s",
  async (where) => {
    const f = await fixture();
    let path = join(f.root, ".agx.toml");
    let root = f.root;
    if (where === "secondary") {
      root = join(f.parent, "secondary");
      await f.jj(["workspace", "add", "--name", "secondary", root]);
      path = join(root, ".agx.toml");
    }
    await writeFile(path, "invalid legacy content\n");
    if (where === "trunk" || where === "recorded-workspace") {
      await f.jj(["commit", "-m", "Legacy file"]);
      if (where === "trunk")
        await f.jj(["bookmark", "set", "main", "-r", "@-"]);
      await unlink(path);
    }
    const result = await resolveAgxConfig(root);
    expect(result.ok).toBe(where !== "trunk");
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AgxConfigError);
      expect(String(result.error)).toContain(
        `${f.root}/.agx.toml is retired; rename it: mv .agx.toml agx.toml (machine-local absolute paths go in $XDG_CONFIG_HOME/agx/repos/<name>.toml (default ~/.config/agx/repos/<name>.toml) with root = ${JSON.stringify(f.root)})`,
      );
    }
  },
);
test.each([
  ['tickets = "no-schema"\n', "schema"],
  ["schema = 2\n", "schema"],
  ["schema = 1\nunknown = true\n", "unknown"],
  ['schema = 1\ntickets = "/absolute"\n', "agx/repos/"],
  ['schema = 1\ntickets = "C:\\\\tickets"\n', "agx/repos/"],
  ['schema = 1\ntickets = "~/tickets"\n', "agx/repos/"],
  ['schema = 1\ntickets = ""\n', "tickets"],
  ['schema = 1\nws = "wrong"\n', "ws"],
  ["schema = 1\n[ws]\nunknown = true\n", "unknown"],
  ['schema = 1\n[ws]\nready = [""]\n', "ready"],
  ['schema = 1\n[ws]\nready = ["   "]\n', "ready"],
  ['schema = 1\n[ws]\ntrunk = ""\n', "trunk"],
  ['schema = 1\n[ws]\nregenerable = ["../outside"]\n', "regenerable"],
  ["schema = 1\nschema = 1\n", "TOML"],
])("rejects invalid L1: %s", async (policy, message) => {
  const f = await fixture(policy);
  // L2 must not hide invalid L1.
  await f.writeLocal('schema = 1\ntickets = "override"\n');
  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AgxConfigError);
    expect(String(result.error)).toContain(message);
    expect(String(result.error)).toContain("agx.toml at main ");
    expect(String(result.error)).not.toContain("\n");
  }
});
test.each([
  ['tickets = "local"\n', "repo.toml"],
  ["schema = 1\nunknown = true\n", "repo.toml"],
  ["schema = 1\n[ws]\nunknown = true\n", "unknown"],
  ['schema = 1\n[ws]\nkeep = [""]\n', "keep"],
])("rejects invalid L2: %s", async (local, message) => {
  const f = await fixture();
  await f.writeLocal(local);
  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(String(result.error)).toContain(message);
});

test("L2 works without L1, ignores other roots, and rejects duplicate claims", async () => {
  const f = await fixture();
  await writeFile(
    join(f.localDirectory, "other.toml"),
    `schema = 1\nroot = ${JSON.stringify(join(f.parent, "other"))}\ntickets = "/other"\n`,
  );
  expect(await home(f.root)).toBe(join(f.root, ".agents/tickets"));
  await f.writeLocal('schema = 1\ntickets = "selected"\n');
  expect(await home(f.root)).toBe(join(f.root, "selected"));
  await writeFile(
    join(f.localDirectory, "duplicate.toml"),
    await readFile(f.local, "utf8"),
  );
  const result = await resolveAgxConfig(f.root);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(String(result.error)).toContain("two files claim root");
});

test.each(["", 'root = "relative"\n'])(
  "L2 requires absolute root: %s",
  async (root) => {
    const f = await fixture();
    await writeFile(f.local, `schema = 1\n${root}tickets = "selected"\n`);
    const result = await resolveAgxConfig(f.root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("root");
  },
);

test("config read waits beyond the former 5000ms limit for a queued jj read", async () => {
  const f = await fixture('schema = 1\ntickets = "committed"\n');
  const jj = Bun.which("jj");
  expect(jj).not.toBeNull();
  if (jj === null) return;
  const bin = join(f.parent, "bin");
  await mkdir(bin);
  const shim = join(bin, "jj");
  await writeFile(
    shim,
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes("workspace")) await Bun.sleep(5100);
const child = Bun.spawn([${JSON.stringify(jj)}, ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  const selectedHome = await home(f.root).finally(() => {
    process.env.PATH = originalPath;
  });
  expect(selectedHome).toBe(join(f.root, "committed"));
}, 20_000);

test("silent config command failure includes command, cwd and child exit", async () => {
  const f = await fixture();
  const bin = join(f.parent, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "jj"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  const result = await resolveAgxConfig(f.root).finally(() => {
    process.env.PATH = originalPath;
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(String(result.error)).toContain(
      '"workspace","root","--name","default"',
    );
    expect(String(result.error)).toContain(f.root);
    expect(String(result.error)).toContain("exited 9: no stderr");
  }
});

test("config read expiry carries its named operational timeout", async () => {
  const { readCommand, InspectionTimeout } =
    await import("../src/agx-config.ts");
  const f = await fixture();
  const argv = [process.execPath, "-e", "await Bun.sleep(5000)"];
  const result = await readCommand(argv, f.root, 20);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(InspectionTimeout);
    expect(String(result.error)).toContain("CONFIG_READ_TIMEOUT_MS=20ms");
    expect(String(result.error)).toContain(JSON.stringify(argv));
    expect(String(result.error)).toContain(`cwd=${f.root}`);
  }
});

async function listingFixture() {
  const parent = await mkdtemp(join(tmpdir(), "agx-list-"));
  roots.push(parent);
  process.env.XDG_CONFIG_HOME = join(parent, "config");
  const directory = join(process.env.XDG_CONFIG_HOME, "agx/repos");
  return { parent, directory };
}

test("L2 listing is empty without its directory and names sorted files by their stems", async () => {
  const { parent, directory } = await listingFixture();
  expect(await listAgxRepos()).toEqual({ ok: true, value: [] });
  await mkdir(directory, { recursive: true });
  const first = {
    schema: 1,
    root: join(parent, "first"),
    tickets: "custom",
  } satisfies { schema: 1; root: string; tickets: string };
  await writeFile(
    join(directory, "zeta.toml"),
    `schema = 1\nroot = ${JSON.stringify(first.root)}\ntickets = "custom"\n`,
  );
  const second = { schema: 1, root: join(parent, "second") } satisfies {
    schema: 1;
    root: string;
  };
  const target = join(parent, "target.toml");
  await writeFile(
    target,
    `schema = 1\nroot = ${JSON.stringify(second.root)}\n`,
  );
  await symlink(target, join(directory, "alpha.toml"));
  await writeFile(join(directory, "ignored.txt"), "invalid");
  await mkdir(join(directory, "ignored.toml"));
  expect(await listAgxRepos()).toEqual({
    ok: true,
    value: [
      { name: "alpha", root: second.root, config: second },
      { name: "zeta", root: first.root, config: first },
    ],
  });
});

test.each([
  'usehooks = "invalid"',
  "[usehooks]\nunknown = true",
  '[usehooks]\nhooks = ""\nlink_task = "link"\nlink_path = "pkg"\ncommand = ["check"]',
  '[usehooks]\nhooks = "hooks"\nlink_task = ""\nlink_path = "pkg"\ncommand = ["check"]',
  '[usehooks]\nhooks = "hooks"\nlink_task = "link"\nlink_path = ""\ncommand = ["check"]',
  '[usehooks]\nhooks = "hooks"\nlink_task = "link"\nlink_path = "pkg"\ncommand = []',
  '[usehooks]\nhooks = "hooks"\nlink_task = "link"\nlink_path = "pkg"\ncommand = [1]',
  '[usehooks]\nhooks = "hooks"\nlink_task = "link"\nlink_path = "pkg"\ncommand = ["check"]\nextra = true',
])(
  "strict usehooks schema is shared by listing and local selection: %s",
  async (table) => {
    const { parent, directory } = await listingFixture();
    await mkdir(directory, { recursive: true });
    const root = join(parent, "repo");
    await mkdir(root);
    const path = join(directory, "example.toml");
    await writeFile(
      path,
      `schema = 1\nroot = ${JSON.stringify(root)}\n${table}\n`,
    );
    for (const result of [
      await listAgxRepos(),
      await resolveAgxConfig(root, { vcs: "none" }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AgxConfigError);
        expect(String(result.error)).toContain(path);
        expect(String(result.error)).toContain("usehooks");
      }
    }
  },
);

test("listing and local selection preserve valid usehooks and report the same invalid TOML", async () => {
  const { parent, directory } = await listingFixture();
  await mkdir(directory, { recursive: true });
  const root = join(parent, "repo");
  await mkdir(root);
  const path = join(directory, "example.toml");
  await writeFile(
    path,
    `schema = 1\nroot = ${JSON.stringify(root)}\n[usehooks]\nhooks = "hooks"\nlink_task = "link"\nlink_path = "pkg"\ncommand = ["check", "{root}"]\n`,
  );
  const listed = await listAgxRepos();
  expect(listed.ok).toBe(true);
  if (listed.ok)
    expect(listed.value[0]?.config.usehooks).toEqual({
      hooks: "hooks",
      link_task: "link",
      link_path: "pkg",
      command: ["check", "{root}"],
    });
  expect((await resolveAgxConfig(root, { vcs: "none" })).ok).toBe(true);
  await writeFile(path, "schema = [");
  const invalid = await listAgxRepos();
  const selected = await resolveAgxConfig(root, { vcs: "none" });
  expect(invalid.ok).toBe(false);
  expect(selected.ok).toBe(false);
  if (!invalid.ok && !selected.ok) {
    expect(String(invalid.error)).toBe(String(selected.error));
    expect(String(invalid.error)).toContain(`${path}: invalid TOML:`);
  }
});

test("listing rejects duplicate roots and reports directory read failures", async () => {
  const { parent, directory } = await listingFixture();
  await mkdir(directory, { recursive: true });
  const text = `schema = 1\nroot = ${JSON.stringify(join(parent, "repo"))}\n`;
  await writeFile(join(directory, "one.toml"), text);
  await writeFile(join(directory, "two.toml"), text);
  const duplicates = await listAgxRepos();
  expect(duplicates.ok).toBe(false);
  if (!duplicates.ok)
    expect(String(duplicates.error)).toContain("two files claim root");
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  expect((await listAgxRepos()).ok).toBe(false);
});
