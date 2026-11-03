import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stableCommand, stableSelfCommand } from "../src/self-command.ts";

test("a Cellar agx-worker path maps to the opt link", () => {
  expect(
    stableCommand([
      "/home/linuxbrew/.linuxbrew/Cellar/agx/1.22.62/bin/agx-worker",
    ]),
  ).toEqual(["/home/linuxbrew/.linuxbrew/opt/agx/bin/agx-worker"]);
});

test("non-Cellar commands are unchanged", () => {
  expect(stableCommand(["/usr/local/bin/agx-worker"])).toEqual([
    "/usr/local/bin/agx-worker",
  ]);
  const multi = ["/x/Cellar/agx/1/bin/agx-worker", "a"];
  expect(stableCommand(multi)).toEqual(multi);
});

test("dispatch and run spawn both use stableCommand", () => {
  const dispatch = readFileSync(
    new URL("../src/dispatch.ts", import.meta.url),
    "utf8",
  );
  const run = readFileSync(
    new URL("../src/next/run.ts", import.meta.url),
    "utf8",
  );
  expect(dispatch).toContain("stableCommand(workerCommand)");
  expect(run).toContain("stableSelfCommand()");
  expect(run).toContain("Bun.spawn(spawnCommand,");
  expect(dispatch).not.toContain("/Cellar/");
});

const CELLAR = "/home/linuxbrew/.linuxbrew/Cellar/agx/1.22.69/bin/agx-worker";
const STABLE = "/home/linuxbrew/.linuxbrew/opt/agx/bin/agx-worker";

const cellarRuntime = { execPath: CELLAR, main: "/$bunfs/root/agx-worker" };

test("with a Cellar execPath the self command starts at the opt link", () => {
  expect(stableSelfCommand(cellarRuntime)).toEqual([STABLE]);
  expect(
    stableSelfCommand({ execPath: "/usr/bin/bun", main: "/x/a.ts" })[0],
  ).toBe("/usr/bin/bun");
});

test("the end-notice default and dispatch/run spawns take the stable helper", () => {
  const src = (f: string) =>
    readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  expect(src("next/end-notice.ts")).toContain(
    "workerCommand: string[] = stableSelfCommand()",
  );
  expect(src("dispatch.ts")).toContain("workerCommand = stableSelfCommand()");
  expect(src("dispatch.ts")).toContain('[...stableSelfCommand(), "ls"');
  expect(src("next/run.ts")).toContain("ownCommand = stableSelfCommand()");
});

test("no source file besides self-command.ts calls selfCommand()", () => {
  const root = new URL("../src", import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );
  const offenders = walk(root).filter(
    (f) =>
      !f.endsWith("/self-command.ts") &&
      /(?<![A-Za-z])selfCommand\b/u.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
});
