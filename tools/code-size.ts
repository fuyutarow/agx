// Human tables or a JSON envelope; live default-ignore Tokei scope, anchored to this repo.
// Exit 0 reconciled / 2 invalid input, missing runtime or unreconciled accounting.
import { cli } from "cleye";
import { resolve } from "node:path";
import { jsonOf, z } from "../zod.ts";

const counts = z.object({
  blanks: z.number().int().nonnegative(),
  code: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
});
type Stats = z.infer<typeof counts> & { blobs: Record<string, Stats> };
const stats: z.ZodType<Stats> = counts.extend({
  blobs: z.lazy(() => z.record(z.string(), stats)),
});
const report = z.object({ name: z.string(), stats });
const language = counts.extend({
  reports: z.array(report),
  children: z.record(z.string(), z.array(report)),
  inaccurate: z.boolean().optional(),
});
export const rawSchema = z.record(z.string(), language);
type Raw = z.infer<typeof rawSchema>;
type Count = { files: number; lines: number; code: number };
type SizeRow = { name: string; code: number };
type SizeGroup = { name: string; code: number; share: number; rows: SizeRow[] };
const zero = (): Count => ({ files: 0, lines: 0, code: 0 });
const sum = (items: Count[]): Count =>
  items.reduce(
    (a, b) => ({
      files: a.files + b.files,
      lines: a.lines + b.lines,
      code: a.code + b.code,
    }),
    zero(),
  );
function nested(s: Stats): Count {
  return sum([
    { files: 0, lines: s.blanks + s.code + s.comments, code: s.code },
    ...Object.values(s.blobs).map((value) => nested(value)),
  ]);
}

const groupNames = [
  "製品コード",
  "テスト",
  "開発・検証の道具",
  "その他",
] as const;

export function placement(file: { path: string; isTest: boolean }): {
  group: number;
  row: string;
} {
  const { path, isTest } = file;
  const packageName = path.match(/^tools\/([^/]+)\/(?:src|tests)\//u)?.[1];
  const parent = path.split("/").slice(0, -1).join("/");
  const directory = parent === "" ? "root" : parent;
  if (isTest) return { group: 1, row: packageName ?? directory };
  if (packageName !== undefined && path.startsWith(`tools/${packageName}/src/`))
    return { group: 0, row: packageName };
  if (/^tools\/[^/]+\.ts$/u.test(path)) return { group: 2, row: "tools" };
  if (/^tools\/(?:changeset|release)\//u.test(path))
    return { group: 2, row: path.split("/")[1] ?? "tools" };
  if (/^(?:lint-[^/]+\.ts|presets\/)/u.test(path))
    return { group: 2, row: path.startsWith("presets/") ? "presets" : "root" };
  return { group: 3, row: directory };
}

function sizeView(files: ReturnType<typeof collectFiles>) {
  const measured = files.filter((file) =>
    ["TypeScript", "TSX"].includes(file.language),
  );
  const total = measured.reduce((n, file) => n + file.code, 0);
  const groups = groupNames.map((name) => ({ name }));
  const rowCounts: Map<string, number>[] = groups.map(
    () => new Map<string, number>(),
  );
  for (const file of measured) {
    const { group: groupIndex, row: rowName } = placement(file);
    const rowMap = rowCounts[groupIndex];
    rowMap?.set(rowName, (rowMap.get(rowName) ?? 0) + file.code);
  }
  const result: SizeGroup[] = groups.map((group, index) => {
    const rows = [...(rowCounts[index] ?? new Map<string, number>())]
      .map(([name, code]) => ({ name, code }))
      .toSorted((a, b) => {
        const byCode = b.code - a.code;
        return byCode === 0 ? a.name.localeCompare(b.name) : byCode;
      });
    const code = rows.reduce((n, row) => n + row.code, 0);
    return {
      name: group.name,
      code,
      share: total === 0 ? 0 : code / total,
      rows,
    };
  });
  return {
    total,
    groups: result,
    reconciled: result.reduce((n, group) => n + group.code, 0) === total,
  };
}

function languageView(raw: Raw, files: ReturnType<typeof collectFiles>) {
  const languages = new Set(
    Object.keys(raw).filter((name) => name !== "Total"),
  );
  const rows: {
    name: string;
    languages: Record<string, number>;
    code: number;
    rows: { name: string; languages: Record<string, number>; code: number }[];
  }[] = groupNames.map((name) => ({ name, languages: {}, code: 0, rows: [] }));
  const byPath = new Map(files.map((file) => [file.path, placement(file)]));
  function add(
    value: Stats,
    languageName: string,
    group: number,
    rowName: string,
  ) {
    languages.add(languageName);
    const row = rows[group];
    if (row === undefined) return;
    row.languages[languageName] =
      (row.languages[languageName] ?? 0) + value.code;
    row.code += value.code;
    let detail = row.rows.find((item) => item.name === rowName);
    if (detail === undefined) {
      detail = { name: rowName, languages: {}, code: 0 };
      row.rows.push(detail);
    }
    detail.languages[languageName] =
      (detail.languages[languageName] ?? 0) + value.code;
    detail.code += value.code;
    for (const [name, child] of Object.entries(value.blobs))
      add(child, name, group, rowName);
  }
  for (const [name, data] of Object.entries(raw)) {
    if (name === "Total") continue;
    for (const entry of data.reports) {
      const location = byPath.get(entry.name.replace(/^\.\//u, ""));
      add(entry.stats, name, location?.group ?? -1, location?.row ?? "");
    }
  }
  const total = rows.reduce((n, row) => n + row.code, 0);
  return {
    languages: [...languages].toSorted(),
    groups: rows,
    total,
    reconciled:
      total === raw["Total"]?.code &&
      rows.every(
        (row) => row.rows.reduce((n, item) => n + item.code, 0) === row.code,
      ),
  };
}

function collectFiles(raw: Raw) {
  return Object.entries(raw)
    .filter(([name]) => name !== "Total")
    .flatMap(([name, data]) =>
      data.reports.map((entry) => ({
        path: entry.name.replace(/^\.\//u, ""),
        language: name,
        ...classify(entry.name.replace(/^\.\//u, "")),
        ...nested(entry.stats),
        files: 1,
      })),
    )
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

export function classify(path: string) {
  const isTest =
    /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(
      path,
    );
  const location = placement({ path, isTest });
  const category = groupNames[location.group] ?? "Other/unclassified";
  const sdk = path.match(/^tools\/([^/]+)\/(?:src|tests)\//u)?.[1];
  const role = isTest ? "tests" : "implementation";
  return { category, sdk, role, isTest };
}

export function breakdown(raw: Raw) {
  const total = raw["Total"];
  if (total === undefined)
    return { ok: false, error: "Tokei JSON has no Total" } as const;
  const files = collectFiles(raw);
  const totals = sum(files);
  const rawTotals = {
    files: Object.entries(raw)
      .filter(([name]) => name !== "Total")
      .reduce((n, [, data]) => n + data.reports.length, 0),
    lines: total.blanks + total.code + total.comments,
    code: total.code,
  };
  const unique = new Set(files.map((f) => f.path)).size === files.length;
  const reconciled =
    unique &&
    totals.files === rawTotals.files &&
    totals.lines === rawTotals.lines &&
    totals.code === rawTotals.code;
  const categories = [
    ...new Set(files.map((f) => `${f.category} / ${f.sdk ?? "—"} / ${f.role}`)),
  ]
    .toSorted()
    .map((category) =>
      Object.assign(
        { category },
        sum(
          files.filter(
            (f) => `${f.category} / ${f.sdk ?? "—"} / ${f.role}` === category,
          ),
        ),
      ),
    );
  const ratio = (label: string, selected: typeof files) => {
    const tests = sum(selected.filter((f) => f.isTest));
    const implementation = sum(
      selected.filter((f) => f.role === "implementation"),
    );
    const denominator = sum(selected).code;
    return {
      label,
      tests,
      implementation,
      denominatorCode: denominator,
      testToImplementationCode:
        implementation.code === 0 ? null : tests.code / implementation.code,
      testCodeShare: denominator === 0 ? null : tests.code / denominator,
      implementationCodeShare:
        denominator === 0 ? null : implementation.code / denominator,
    };
  };
  const ratios = [
    ratio(
      "Product packages (implementation + tests/fixtures)",
      files.filter(
        (f) =>
          f.category === "製品コード" ||
          (f.category === "テスト" && f.sdk !== undefined),
      ),
    ),
    ratio(
      "All TS/TSX (all measured TS/TSX code)",
      files.filter((f) => ["TypeScript", "TSX"].includes(f.language)),
    ),
    ratio(
      "Development tools",
      files.filter((f) => f.category === "開発・検証の道具"),
    ),
  ];
  const composition = sizeView(files);
  const tokeiTsTotal = ["TypeScript", "TSX"].reduce(
    (count, name) =>
      count +
      (raw[name]?.reports.reduce(
        (n, entry) => n + nested(entry.stats).code,
        0,
      ) ?? 0),
    0,
  );
  composition.reconciled &&= composition.total === tokeiTsTotal;
  const languageComposition = languageView(raw, files);
  let error: string | undefined;
  if (!reconciled)
    error = "Duplicate physical paths or totals differ from Tokei Total";
  else if (!composition.reconciled)
    error = "TS/TSX composition does not reconcile to its Tokei total";
  else if (!languageComposition.reconciled)
    error = "Language composition does not reconcile to Tokei Total";
  return {
    ok: reconciled && composition.reconciled && languageComposition.reconciled,
    error,
    root: resolve(import.meta.dir, ".."),
    scope:
      "Current working tree; tokei . --output json; default ignore rules; hidden files excluded. Lines/code include recursive embedded blocks; Files counts physical reports once.",
    totals,
    rawTotals,
    reconciliation: { uniquePaths: unique, totalsMatch: reconciled },
    categories,
    ratios,
    composition,
    languageComposition,
    files,
    unclassified: files.filter((f) => f.category === "Other/unclassified"),
    rawLanguageSummary: raw,
  };
}
const tableRow = (name: string, code: number, share = "") => ({
  区分: name,
  行数: code.toLocaleString("en-US"),
  割合: share,
});
function alignNumericColumns(rows: Record<string, string>[]) {
  const columns = Object.keys(rows[0] ?? {}).filter((key) => key !== "区分");
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(
        Bun.stringWidth(column),
        ...rows.map((row) => (row[column] ?? "").length),
      ),
    ]),
  );
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key === "区分" ? value : value.padStart(widths[key] ?? 0),
      ]),
    ),
  );
}
export function render(
  result: Extract<ReturnType<typeof breakdown>, { totals: Count }>,
) {
  return `${Bun.inspect.table(
    alignNumericColumns([
      tableRow("TS/TSX 合計", result.composition.total),
      ...result.composition.groups.flatMap((group) => [
        tableRow(group.name, group.code, `${Math.round(group.share * 100)}%`),
        ...group.rows.map((item) => tableRow(`├ ${item.name}`, item.code)),
      ]),
    ]),
  )}\n\n${Bun.inspect.table(
    alignNumericColumns([
      ...result.languageComposition.groups
        .flatMap((group) => [
          group,
          ...group.rows.map((row) =>
            Object.assign({}, row, { name: `├ ${row.name}` }),
          ),
        ])
        .map((group) =>
          Object.assign(
            { 区分: group.name },
            Object.fromEntries(
              result.languageComposition.languages.map((lang) => [
                lang,
                (group.languages[lang] ?? 0).toLocaleString("en-US"),
              ]),
            ),
            { 合計: group.code.toLocaleString("en-US") },
          ),
        ),
      {
        区分: "合計",
        ...Object.fromEntries(
          result.languageComposition.languages.map((lang) => [
            lang,
            result.languageComposition.groups
              .reduce((n, group) => n + (group.languages[lang] ?? 0), 0)
              .toLocaleString("en-US"),
          ]),
        ),
        合計: result.languageComposition.total.toLocaleString("en-US"),
      },
    ]),
  )}\n`;
}
function rejectPrototypeFlag(type: string, flag: string): void {
  if (type === "unknown-flag" && flag === "__proto__") {
    process.stderr.write("FATAL: unsupported --__proto__\n");
    process.exit(2);
  }
}
async function main() {
  const args = cli({
    name: "code:size",
    parameters: [],
    flags: { json: { type: Boolean, description: "Emit only JSON" } },
    // Cleye's strict mode exits 1; this command's invalid-input contract is 2.
    strictFlags: false,
    ignoreArgv: rejectPrototypeFlag,
  });
  if (args._.length > 0 || Object.keys(args.unknownFlags).length > 0) {
    process.stderr.write("FATAL: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  if (Bun.which("tokei") === null) {
    process.stderr.write(
      "FATAL: missing declared Tokei; run mise install tokei@15.0.0\n",
    );
    process.exitCode = 2;
    return;
  }
  const child = Bun.spawn(["tokei", ".", "--output", "json"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stderr.length > 0) process.stderr.write(stderr.slice(0, 8000));
  const parsed = jsonOf(rawSchema).safeParse(stdout);
  if (exit !== 0 || !parsed.success) {
    process.stderr.write(
      `FATAL: Tokei exit ${exit}; invalid or unsupported JSON\n`,
    );
    process.exitCode = 2;
    return;
  }
  const result = breakdown(parsed.data);
  if (!result.ok) {
    process.stderr.write(`FATAL: ${result.error}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    args.flags.json === true ? `${JSON.stringify(result)}\n` : render(result),
  );
}
if (import.meta.main)
  await main().catch((error: unknown) => {
    process.stderr.write(`FATAL: ${String(error)}\n`);
    process.exitCode = 2;
  });
