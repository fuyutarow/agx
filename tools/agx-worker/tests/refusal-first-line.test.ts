import { expect, test } from "bun:test";
import { composePreflightRefusal } from "../src/next/sandbox-needs.ts";

const warn = (store: string) =>
  `WARN sandbox capability=external-vcs-store-write; requested=workspace-write; evidence=${JSON.stringify(`workspace VCS store=${store}; writes[0]: a`)}; allows=none (--sandbox none, unsandboxed); sandbox unchanged`;
const refusal =
  "cannot continue run r1: fresh routing selected row sonnet-medium outside the 1800 s time box; repair: x; check=launch-premises expected=satisfied observed=refused";
const stores = ["/r/.git/worktrees/ws", "/r/.git", "/r/.jj/repo"];

test("refusal is the first line; the store WARNs merge into one line", () => {
  const out = composePreflightRefusal({
    tree: "--cd /w",
    checkCode: 2,
    checkErr: `${stores.map(warn).join("\n")}\n${refusal}\n`,
    failures: [],
  });
  const lines = (out ?? "").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith(refusal);
  expect(lines[0]).not.toContain("WARN");
  expect(lines[1]).toStartWith(
    "WARN sandbox capability=external-vcs-store-write",
  );
  for (const store of stores) expect(lines[1]).toContain(store);
  expect(out?.match(/WARN/gu)).toHaveLength(1);
});

test("a check with only WARNs and exit 0 does not refuse", () => {
  expect(
    composePreflightRefusal({
      tree: "--cd /w",
      checkCode: 0,
      checkErr: `${stores.map(warn).join("\n")}\n`,
      failures: [],
    }),
  ).toBeUndefined();
});

test("a repeated identical WARN prints once", () => {
  const out = composePreflightRefusal({
    tree: "t",
    checkCode: 1,
    checkErr: "WARN a\nWARN a\n",
    failures: ["unit u is running"],
  });
  expect(out?.startsWith("unit u is running; preflight failed")).toBe(true);
  expect(out?.match(/WARN a/gu)).toHaveLength(1);
});
