/* eslint-disable eslint/max-depth, eslint-js/no-restricted-syntax -- Parsing test source must fail closed on unsupported syntax. */
import { expect, test } from "bun:test";
import { join, relative } from "node:path";
import { z } from "../../shared/src/zod.ts";
import ratchet from "./timing-contract.json" with { type: "json" };

const root = join(import.meta.dir, "../../..");
type Entry = { file: string; name: string; timeout: number };

// Tokenize strings and balanced delimiters so callbacks, comments, and multiline calls
// cannot make a timeout look like an unrelated number.
function tokens(source: string): string[] {
  const result: string[] = [];
  const pattern =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\[\s\S]|\[[^\]\n]*\]|[^/\n\\])+\/[a-z]*|[A-Za-z_$][\w$]*|[0-9][\w_]*|./gu;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    if (
      !/^\s/u.test(token) &&
      !token.startsWith("//") &&
      !token.startsWith("/*")
    )
      result.push(token);
  }
  return result;
}

function argumentsAt(
  ts: string[],
  open: number,
): { args: string[][]; end: number } {
  const args: string[][] = [[]];
  const stack: string[] = [")"];
  const closes: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = open + 1; i < ts.length; i++) {
    const t = ts[i];
    if (t === undefined) break;
    if (t === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return { args, end: i };
    } else if (Object.hasOwn(closes, t)) {
      const close = closes[t];
      if (close !== undefined) stack.push(close);
    }
    if (t === "," && stack.length === 1) args.push([]);
    else args.at(-1)?.push(t);
  }
  throw new Error("Unbalanced test call");
}

function numeric(
  expr: string[],
  ts: string[],
  seen = new Set<string>(),
): number {
  const expanded = expr
    .map((part) => {
      if (/^[0-9][0-9_]*$/u.test(part)) return part.replaceAll("_", "");
      if (["+", "-", "*", "/", "(", ")"].includes(part)) return part;
      if (seen.has(part)) throw new Error("cyclic timeout expression");
      const index = ts.findIndex(
        (t, i) => t === "const" && ts[i + 1] === part && ts[i + 2] === "=",
      );
      if (index < 0) throw new Error(`unknown timeout expression: ${part}`);
      const end = ts.indexOf(";", index + 3);
      if (end < 0) throw new Error("unterminated timeout constant");
      return String(
        numeric(ts.slice(index + 3, end), ts, new Set([...seen, part])),
      );
    })
    .join(" ");
  const sum = expanded.split("+");
  return sum.reduce(
    (total, term) =>
      total +
      term.split("*").reduce((product, value) => {
        const number = Number(value.trim());
        if (!Number.isFinite(number))
          throw new Error("unsupported timeout expression");
        return product * number;
      }, 1),
    0,
  );
}

export function overrides(file: string, source: string): Entry[] {
  const ts = tokens(source);
  const entries: Entry[] = [];
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (let i = 0; i < ts.length - 5; i++) {
    const alias = ts[i + 3];
    if (
      ts[i] === "import" &&
      ts[i + 1] === "*" &&
      ts[i + 2] === "as" &&
      alias !== undefined &&
      ts[i + 4] === "from" &&
      (ts[i + 5] === `"bun:test"` || ts[i + 5] === `'bun:test'`)
    )
      namespaces.add(alias);
  }
  for (let i = 0; i < ts.length - 2; i++) {
    const original = ts[i];
    const alias = ts[i + 2];
    if (
      (original === "test" ||
        original === "it" ||
        original === "setDefaultTimeout") &&
      ts[i + 1] === "as" &&
      alias !== undefined
    )
      aliases.set(alias, original);
  }
  for (let i = 0; i < ts.length; i++) {
    const kind = aliases.get(ts[i] ?? "") ?? ts[i];
    if (kind !== "test" && kind !== "it" && kind !== "setDefaultTimeout")
      continue;
    if (ts[i - 1] === "." && !namespaces.has(ts[i - 2] ?? "")) continue;
    let j = i + 1;
    while (ts[j] === "." && ts[j + 1] !== undefined) j += 2;
    if (ts[j] !== "(") continue;
    let args: string[][];
    try {
      const first = argumentsAt(ts, j);
      if (ts[j - 1] === "each" && ts[first.end + 1] === "(")
        args = argumentsAt(ts, first.end + 1).args;
      else args = first.args;
    } catch {
      throw new Error(`${file}: unbalanced call at token ${i}`);
    }
    const arg = kind === "setDefaultTimeout" ? args[0] : args[2];
    if (arg === undefined || arg.length === 0) continue;
    const timeout = numeric(arg, ts);
    if (timeout <= 5000) continue;
    const label = args[0]?.[0];
    if (
      kind !== "setDefaultTimeout" &&
      (label === undefined || !/^["'`]/u.test(label))
    )
      throw new Error(`${file}: test name must be a string literal`);
    const name =
      kind === "setDefaultTimeout"
        ? "file default"
        : (label?.slice(1, -1) ?? "");
    entries.push({ file, name, timeout });
  }
  return entries;
}

export async function actualOverrides(): Promise<Entry[]> {
  const glob = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
  const entries: Entry[] = [];
  for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
    if (
      file.startsWith("node_modules/") ||
      file.startsWith(".jj/") ||
      file.startsWith(".git/")
    )
      continue;
    entries.push(...overrides(file, await Bun.file(join(root, file)).text()));
  }
  return entries.toSorted((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

test("timing contract: default and per-test timeouts match the frozen ratchet", async () => {
  const config = Bun.TOML.parse(
    await Bun.file(join(root, "bunfig.toml")).text(),
  );
  expect(
    z.object({ test: z.object({ timeout: z.literal(5000) }) }).safeParse(config)
      .success,
  ).toBe(true);
  const preload = await Bun.file(
    join(root, "tools/shared/src/test-tmp.ts"),
  ).text();
  expect(preload.match(/setDefaultTimeout\(5_000\)/gu)).toHaveLength(1);
  expect(
    overrides(
      relative(root, join(root, "tools/shared/src/test-tmp.ts")),
      preload,
    ),
  ).toEqual([]);
  const expected = ratchet
    .map(({ file, name, timeout }) => ({ file, name, timeout }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  expect(await actualOverrides()).toEqual(expected);
});
