import { expect, test } from "bun:test";
import { resolveSandbox } from "../../src/next/sandbox.ts";

test("sandbox resolution: flag > ticket > continued run > agx.toml > workspace-write", () => {
  expect(resolveSandbox("read-only", "none", "none", "none")).toEqual({
    sandbox: "read-only",
    sandbox_source: "flag",
  });
  expect(resolveSandbox(undefined, "workspace-write", "none", "none")).toEqual({
    sandbox: "workspace-write",
    sandbox_source: "ticket",
  });
  expect(resolveSandbox(undefined, undefined, "read-only", "none")).toEqual({
    sandbox: "read-only",
    sandbox_source: "continued run",
  });
  expect(resolveSandbox(undefined, undefined, undefined, "none")).toEqual({
    sandbox: "none",
    sandbox_source: "agx.toml",
  });
  expect(resolveSandbox(undefined, undefined, undefined, undefined)).toEqual({
    sandbox: "workspace-write",
    sandbox_source: "built-in default",
  });
});
