export type RunIdRow = Readonly<{ id: string }>;

export type RunIdResolution<Row extends RunIdRow> =
  | Readonly<{ kind: "resolved"; row: Row }>
  | Readonly<{ kind: "error"; error: string }>;

/** Resolve an exact run ID or a unique prefix, with stable candidate diagnostics. */
export function resolveRunId<Row extends RunIdRow>(
  rows: readonly Row[],
  selector: string,
): RunIdResolution<Row> {
  const exact = rows.find((row) => row.id === selector);
  if (exact !== undefined) return { kind: "resolved", row: exact };
  const candidates = rows
    .filter((row) => row.id.startsWith(selector))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (candidates.length === 1) {
    const row = candidates[0];
    if (row !== undefined) return { kind: "resolved", row };
  }
  if (candidates.length === 0) {
    return {
      kind: "error",
      error: `unknown run id '${selector}'; ${rows.length} recorded runs`,
    };
  }
  const candidateText = candidates
    .slice(0, 20)
    .map((row) => row.id)
    .join(", ");
  const remaining = candidates.length - 20;
  const suffix = remaining > 0 ? `, ${remaining} more` : "";
  return {
    kind: "error",
    error: `run id '${selector}' is ambiguous; run id candidates: ${candidateText}${suffix}`,
  };
}
