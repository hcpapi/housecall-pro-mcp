/**
 * Pure helpers shared by two callers: the Node test suite imports them
 * directly, and the renderer inlines their source (via `.toString()`) into the
 * report so the browser runs the exact same code the tests pin. No imports, no
 * TS-only runtime constructs, the compiled output must be valid standalone
 * browser JS.
 */

/** Parse a display string like "$18,400" or "-1,234.5" to a number for sorting. */
export function parseNumeric(s: unknown): number {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

/** Escape the five HTML-significant characters. */
export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `backtick` -> chip, **stars** -> bold, [text](https://...) -> link.
 * Links are http(s)-only so untrusted data can never smuggle a javascript:
 * URL; anything else stays literal text. Runs on already-escaped or raw text. */
export function applyMicro(s: unknown): string {
  return String(s)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    )
    .replace(/`([^`]+)`/g, '<span class="chip">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Table cell: escape first (data is untrusted), then apply micro-syntax. */
export function cellHtml(s: unknown): string {
  return applyMicro(escapeHtml(s));
}

/** List item: authored content may carry inline HTML, so micro over raw. */
export function itemHtml(s: unknown): string {
  return applyMicro(s);
}

/** A coverage field's percent, from `pct` or `present`/`total`; null if neither. */
export function coveragePct(f: {
  pct?: number;
  present?: number;
  total?: number;
}): number | null {
  if (typeof f.pct === "number") return Math.max(0, Math.min(100, f.pct));
  if (typeof f.present === "number" && typeof f.total === "number" && f.total > 0) {
    return Math.max(0, Math.min(100, Math.round((f.present / f.total) * 100)));
  }
  return null;
}

/** Bar color band: >=90 green, 50-90 amber, <50 red. */
export function coverageBand(pct: number | null): string {
  if (pct === null) return "none";
  if (pct >= 90) return "good";
  if (pct >= 50) return "warn";
  return "bad";
}

/**
 * Which columns are worth offering as checkbox facets: a categorical column the
 * reader would filter by. Auto-detected so a skill needs no awareness, a column
 * qualifies when it is non-numeric, holds a small set of distinct values (2..8),
 * sits in a table big enough to filter (>= 10 rows), and is not opted out with
 * `filter: false`. High-cardinality columns (Customer, Description) fall out on
 * the distinct-count ceiling.
 */
export function facetableColumns(
  columns: { numeric?: boolean; filter?: boolean }[],
  rows: string[][],
): { index: number; values: string[] }[] {
  const out: { index: number; values: string[] }[] = [];
  if (!Array.isArray(rows) || rows.length < 10) return out;
  (columns || []).forEach((c, i) => {
    if (c && (c.numeric || c.filter === false)) return;
    const seen = new Set<string>();
    for (const r of rows) {
      const v = String((Array.isArray(r) ? r[i] : "") ?? "").replace(/[`*]/g, "").trim();
      if (v) seen.add(v);
      if (seen.size > 8) return; // too many distinct, not a facet
    }
    if (seen.size >= 2) out.push({ index: i, values: [...seen].sort() });
  });
  return out;
}

/** Strip micro-syntax markers and trim, the value a facet compares against. */
export function facetValue(s: unknown): string {
  return String(s ?? "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

/**
 * A table as CSV. Markers stripped (as the paste-back does), and any cell with a
 * comma, double-quote, or newline is wrapped in double-quotes with interior
 * quotes doubled, so the numbers open cleanly in a spreadsheet.
 */
export function tableToCsv(columns: { label?: string }[], rows: string[][]): string {
  const cell = (s: unknown) => {
    const v = String(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
      .replace(/[`*]/g, "");
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const head = (columns || []).map((c) => cell(c && c.label != null ? c.label : "")).join(",");
  const body = (rows || [])
    .map((r) => (Array.isArray(r) ? r : []).map(cell).join(","))
    .join("\n");
  return body ? head + "\n" + body : head;
}

/**
 * The paste-back worklist for a section's selected rows. Plain and readable,
 * micro-syntax markers stripped, so it reads as a decision list in chat.
 * `selected` is original row indices, which stay stable under sort and filter.
 */
export function pastebackText(
  title: string,
  rows: string[][],
  selected: number[],
): string {
  const strip = (s: unknown) =>
    String(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
      .replace(/[`*]/g, "");
  const lines = selected
    .filter((i) => Array.isArray(rows[i]))
    .map((i) => "- " + rows[i].map(strip).join(" · "));
  return `${title}: ${selected.length} selected\n${lines.join("\n")}`;
}
