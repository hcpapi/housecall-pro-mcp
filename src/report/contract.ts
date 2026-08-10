/**
 * The report contract — the one JSON shape every skill fills to produce a
 * report, ported from the report-renderer prototype's REPORT-CONTRACT.md.
 *
 * The contract is renderer-agnostic on purpose: nothing here mentions HTML.
 * A skill contributes data; a renderer (the HTML one in this package, or the
 * markdown chat report a skill writes anyway) turns the same contract into a
 * surface. Keeping the shape free of presentation is what lets a second
 * renderer exist without a contract change.
 */

/** Number-color for a stat card. */
export const STAT_TONES = [
  "default",
  "accent",
  "ok",
  "warning",
  "blocked",
  "confident",
] as const;
export type StatTone = (typeof STAT_TONES)[number];

/** A section's severity — also drives its pill and left border. */
export const SEVERITIES = [
  "confident",
  "ok",
  "warning",
  "blocked",
  "info",
  "neutral",
] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The block kinds a section can hold, rendered in order. */
export const BLOCK_TYPES = ["table", "prose", "lead", "list", "subhead"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export interface MetaItem {
  label: string;
  value: string;
}

export interface StatCard {
  value: string;
  label: string;
  tone?: StatTone;
  /** One short qualifier under the number. */
  sub?: string;
}

export interface CoverageSummaryItem {
  value: string;
  label: string;
  note?: string;
}

/**
 * A coverage field renders as a bar: green >=90%, amber 50-90%, red <50%.
 * Either give `pct` directly, or `present`/`total` for the renderer to divide.
 */
export interface CoverageField {
  name: string;
  present?: number;
  total?: number;
  pct?: number;
  note?: string;
}

export interface Coverage {
  summary?: CoverageSummaryItem[];
  fields?: CoverageField[];
}

export interface TableColumn {
  label: string;
  /** Right-aligned, sorts numerically (the sorter parses `$` and commas). */
  numeric?: boolean;
}

/** A table row is an array of display strings in column order. */
export type TableRow = string[];

export interface TableBlock {
  type: "table";
  columns: TableColumn[];
  rows: TableRow[];
  /** Show the first N rows, the rest behind "Show all". */
  collapsedRows?: number;
  /** Column index to sort on load. */
  defaultSort?: number;
  /** 1 asc, -1 desc. */
  defaultSortDir?: 1 | -1;
  /** Checkbox column whose ticks collect into a paste-back worklist. */
  selectable?: boolean;
  /** Italic line between the table and its footer bar. */
  moreNote?: string;
}

/** `prose` is body copy; `lead` is the larger intro variant. Inline HTML is fine. */
export interface ProseBlock {
  type: "prose" | "lead";
  html: string;
}

export interface ListBlock {
  type: "list";
  items: string[];
  /** Render items with a cross rather than a check. */
  crosses?: boolean;
}

export interface SubheadBlock {
  type: "subhead";
  text: string;
}

export type Block = TableBlock | ProseBlock | ListBlock | SubheadBlock;

export interface Section {
  title: string;
  severity?: Severity;
  /** Override the pill text (e.g. "Worklist" on a neutral section). */
  severityLabel?: string;
  /** Dimmed, appended to the title. */
  count?: string;
  summary?: string;
  /** Default true; set false for worklists. */
  defaultOpen?: boolean;
  lead?: string;
  blocks: Block[];
  footer?: string;
}

export interface OrderItem {
  title: string;
  detail: string;
}

export interface ReportContract {
  skill: string;
  title: string;
  sections: Section[];
  kicker?: string;
  generated?: string;
  provenance?: string;
  meta?: MetaItem[];
  stats?: StatCard[];
  /** The one-paragraph answer, as an HTML string. */
  headline?: string;
  coverage?: Coverage;
  order?: OrderItem[];
  closing?: string;
}

/** The validator's verdict: fatal `errors` block a render, `warnings` do not. */
export interface ValidationResult {
  errors: string[];
  warnings: string[];
}
