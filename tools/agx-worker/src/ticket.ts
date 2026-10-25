// Shared capability parsing, verification text, and write-scope matching for current tickets.
import { z } from "../../shared/src/zod.ts";

export const CapabilitySchema = z.union([
  z.string().trim().min(1),
  z.strictObject({
    need: z.string().trim().min(1),
    lower_effort_lacks: z.string().trim().min(1),
  }),
]);

export type Capability = z.output<typeof CapabilitySchema>;
export const capabilityTags = (capabilities: readonly Capability[]): string[] =>
  capabilities.map((capability) =>
    typeof capability === "string" ? capability : capability.need,
  );

/** The one line appended to the worker's brief; empty when there is nothing to verify. */
export function verifyLine(verify: string[]): string {
  if (verify.length === 0) return "";
  const list = verify.map((c) => `\`${c}\``).join("; ");
  return `The router runs these verify commands after you exit and grades you on them: ${list}. Run them yourself in the foreground before you finish; do not background anything you need to see.`;
}

// --- overlap of write scopes ---------------------------------------------------------------------
//
// Path patterns intersect segment by segment. A single star never consumes a slash.
type Atom = {
  star: boolean;
  accepts: (code: number) => boolean;
  boundaries: number[];
};
const anyAtom = (star: boolean): Atom => ({
  star,
  accepts: (code) => code > 0 && code <= 0x10ffff && code !== 47,
  boundaries: [1, 47, 48],
});
function classAtom(
  pattern: string,
  start: number,
): { atom: Atom; end: number } | undefined {
  const end = pattern.indexOf("]", start + 1);
  if (end <= start + 1) return undefined;
  const text = pattern.slice(start + 1, end);
  const negative = text.startsWith("!") || text.startsWith("^");
  const content = Array.from(negative ? text.slice(1) : text);
  const ranges: [number, number][] = [];
  for (let j = 0; j < content.length; j++) {
    const lo = content[j]?.codePointAt(0) ?? 0;
    const ranged = content[j + 1] === "-" && j + 2 < content.length;
    const hi = ranged ? (content[j + 2]?.codePointAt(0) ?? 0) : lo;
    if (ranged) j += 2;
    ranges.push([lo, hi]);
  }
  return {
    end,
    atom: {
      star: false,
      accepts: (code) =>
        code > 0 &&
        code <= 0x10ffff &&
        code !== 47 &&
        ranges.some(([lo, hi]) => code >= lo && code <= hi) !== negative,
      boundaries: ranges.flatMap(([lo, hi]) => [lo, hi + 1]),
    },
  };
}
function segmentAtoms(pattern: string): Atom[] {
  const atoms: Atom[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" || char === "?") {
      atoms.push(anyAtom(char === "*"));
      continue;
    }
    const grouped = char === "[" ? classAtom(pattern, i) : undefined;
    if (grouped !== undefined) {
      atoms.push(grouped.atom);
      i = grouped.end;
      continue;
    }
    if (char === "\\" && i + 1 < pattern.length) i++;
    const code = pattern.codePointAt(i) ?? 0;
    atoms.push({
      star: false,
      accepts: (candidate) => candidate === code && code !== 47 && code !== 0,
      boundaries: [code, code + 1],
    });
    if (code > 0xffff) i++;
  }
  return atoms;
}
function segmentsIntersect(a: string, b: string): boolean {
  const left = segmentAtoms(a),
    right = segmentAtoms(b);
  const alphabet = new Set([
    1,
    48,
    ...left.flatMap((atom) => atom.boundaries),
    ...right.flatMap((atom) => atom.boundaries),
  ]);
  const queue: [number, number, boolean][] = [[0, 0, false]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [i, j, consumed] = queue.pop() ?? [0, 0, false];
    const key = [i, j, consumed].join(":");
    if (visited.has(key)) continue;
    visited.add(key);
    if (i === left.length && j === right.length && consumed) return true;
    const l = left[i],
      r = right[j];
    if (l?.star === true) queue.push([i + 1, j, consumed]);
    if (r?.star === true) queue.push([i, j + 1, consumed]);
    if (
      l !== undefined &&
      r !== undefined &&
      [...alphabet].some((code) => l.accepts(code) && r.accepts(code))
    )
      queue.push([l.star ? i : i + 1, r.star ? j : j + 1, true]);
  }
  return false;
}
export function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start < 0) return [pattern];
  let depth = 0,
    end = -1;
  const choices: string[] = [];
  let beginning = start + 1;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    if (pattern[i] === "}") depth--;
    if ((pattern[i] === "," && depth === 1) || depth === 0) {
      choices.push(pattern.slice(beginning, i));
      beginning = i + 1;
    }
    if (depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [pattern];
  return choices.flatMap((choice) =>
    expandBraces(pattern.slice(0, start) + choice + pattern.slice(end + 1)),
  );
}
const segments = (pattern: string) =>
  (pattern.endsWith("/") ? pattern + "**" : pattern)
    .split("/")
    .filter((part) => part !== "" && part !== ".");

function pathPatternsIntersect(a: string, b: string): boolean {
  const left = segments(a),
    right = segments(b);
  const queue: [number, number][] = [[0, 0]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [i, j] = queue.pop() ?? [0, 0];
    const key = i + ":" + j;
    if (visited.has(key)) continue;
    visited.add(key);
    if (i === left.length && j === right.length) return true;
    const l = left[i],
      r = right[j];
    if (l === "**") queue.push([i + 1, j]);
    if (r === "**") queue.push([i, j + 1]);
    if (l === undefined || r === undefined) continue;
    if (l === "**" && r !== "**") queue.push([i, j + 1]);
    if (r === "**" && l !== "**") queue.push([i + 1, j]);
    if (l !== "**" && r !== "**" && segmentsIntersect(l, r))
      queue.push([i + 1, j + 1]);
  }
  return false;
}
export function globsOverlap(a: string, b: string): boolean {
  return expandBraces(a).some((left) =>
    expandBraces(b).some((right) => pathPatternsIntersect(left, right)),
  );
}
