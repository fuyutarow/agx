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
  if (candidates.length === 1) return { kind: "resolved", row: candidates[0]! };
  const ids = (candidates.length > 0 ? candidates : rows)
    .map((row) => row.id)
    .toSorted();
  const candidateText = ids.length > 0 ? ids.join(", ") : "(none)";
  const error =
    candidates.length > 1
      ? `run id '${selector}' is ambiguous; run id candidates: ${candidateText}`
      : `unknown run id '${selector}'; candidates: ${candidateText}`;
  return {
    kind: "error",
    error,
  };
}
