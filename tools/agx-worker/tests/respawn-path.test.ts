import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stableCommand } from "../src/self-command.ts";

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
  expect(run).toContain("stableCommand(selfCommand())");
  expect(run).toContain("Bun.spawn(spawnCommand,");
  expect(dispatch).not.toContain("/Cellar/");
});
