// contract.md's environment sections and the implementation name the same agx variables.
// A name the code reads or sets but the contract omits, or one the contract still describes after
// the code stopped using it, fails here instead of misleading an operator later.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = join(import.meta.dir, "..");
// Every AGX_* name, and the agx-owned names that predate the prefix.
const NAME =
  /\b(?:AGX_[A-Z0-9_]*[A-Z0-9]|DISPATCH_COMMAND_TIMEOUT_MS|WS_ADD_TIMEOUT_MS|JEV_URL)\b/gu;
/** TypeScript identifiers that hold a variable's name or value; they are not variable names. */
const IDENTIFIERS = new Set(["AGX_WORKER_ENV", "AGX_WORKER_VALUE"]);

const namesIn = (text: string): Set<string> =>
  new Set((text.match(NAME) ?? []).filter((name) => !IDENTIFIERS.has(name)));

const sourceNames = (): Set<string> =>
  new Set(
    [join(worker, "src"), join(worker, "../shared/src")].flatMap((root) =>
      Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: root })).flatMap(
        (file) => Array.from(namesIn(readFileSync(join(root, file), "utf8"))),
      ),
    ),
  );

test("the contract and the implementation name the same AGX_* variables", () => {
  const source = sourceNames();
  const contract = namesIn(readFileSync(join(worker, "contract.md"), "utf8"));
  expect({
    "in source, missing from contract.md": [
      ...source.difference(contract),
    ].toSorted(),
    "in contract.md, absent from source": [
      ...contract.difference(source),
    ].toSorted(),
  }).toEqual({
    "in source, missing from contract.md": [],
    "in contract.md, absent from source": [],
  });
});
