/**
 * Validate a report contract before it is rendered.
 *
 * Ported from the report-renderer prototype's build.py `validate()`, keeping
 * its two-list contract: `errors` are fatal (a render would break or mislead),
 * `warnings` are advisory (the report renders, just thinner). The tool refuses
 * to render on any error and passes warnings through for the caller to see.
 *
 * The input is unknown-shaped on purpose, this runs on whatever a skill
 * hands the tool, so every access is defensive.
 */
import {
  BLOCK_TYPES,
  SEVERITIES,
  STAT_TONES,
  type ValidationResult,
} from "./contract.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The smallest contract that renders.
 *
 * Shown with any contract error, because the errors name what is wrong and a
 * skeleton names what right looks like. A caller that has just been told
 * "prose block needs 'html'" still has to guess the shape of the block it
 * wanted; this removes the guess.
 */
export const MINIMAL_REPORT_EXAMPLE = `{
  "skill": "your-skill-name",
  "title": "Report title",
  "sections": [
    {
      "title": "Section title",
      "blocks": [
        { "type": "prose", "html": "<p>Any HTML.</p>" },
        { "type": "subhead", "text": "A heading" },
        { "type": "list", "items": ["first", "second"] },
        {
          "type": "table",
          "columns": [{ "label": "Name" }, { "label": "Count", "numeric": true }],
          "rows": [["a", "1"], ["b", "2"]]
        }
      ]
    }
  ]
}`;

export function validateReport(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(input)) {
    errors.push("the report must be a JSON object");
    return { errors, warnings };
  }
  const data = input;

  // Required top-level keys.
  //
  // Everything that CAN still be checked is checked, even when one of these is
  // missing. Returning here made a caller fix one layer, re-call, and discover
  // the next - four round trips for a single malformed report, against a tool
  // that promises "the exact problems are listed so you can fix and re-call".
  for (const k of ["skill", "title", "sections"]) {
    if (!(k in data)) errors.push(`missing required key '${k}'`);
  }

  const sectionsPresent = "sections" in data;
  if (sectionsPresent && !Array.isArray(data.sections)) {
    errors.push("'sections' must be a list");
  }

  // Recommended keys, present in a full report, not required.
  for (const k of ["headline", "coverage", "stats", "order", "meta"]) {
    if (!(k in data)) {
      warnings.push(`recommended key '${k}' missing: report will render without it`);
    }
  }

  const stats = Array.isArray(data.stats) ? data.stats : [];
  stats.forEach((s, i) => {
    if (!isObject(s) || !("value" in s) || !("label" in s)) {
      errors.push(`stats[${i}] needs 'value' and 'label'`);
      return;
    }
    if (s.tone && !STAT_TONES.includes(s.tone as never)) {
      warnings.push(`stats[${i}].tone '${String(s.tone)}' not one of ${STAT_TONES.join(", ")}`);
    }
  });

  if ("coverage" in data && data.coverage != null) {
    const cov = data.coverage;
    if (!isObject(cov) || !("fields" in cov)) {
      warnings.push("coverage.fields missing: coverage card will be empty");
    }
    const fields = isObject(cov) && Array.isArray(cov.fields) ? cov.fields : [];
    fields.forEach((f, i) => {
      if (!isObject(f) || !("name" in f)) {
        errors.push(`coverage.fields[${i}] needs 'name'`);
        return;
      }
      const hasPct = "pct" in f;
      const hasRatio = "present" in f && "total" in f;
      if (!hasPct && !hasRatio) {
        warnings.push(
          `coverage.fields[${i}] '${String(f.name ?? "?")}' has no pct and no present/total`,
        );
      }
    });
  }

  const sections = Array.isArray(data.sections) ? data.sections : [];
  sections.forEach((sec, si) => {
    const title = isObject(sec) && "title" in sec ? String(sec.title) : "?";
    const where = `sections[${si}] '${title}'`;
    if (!isObject(sec) || !("title" in sec)) {
      errors.push(`sections[${si}] needs 'title'`);
    }
    if (!isObject(sec) || !("blocks" in sec)) {
      errors.push(`${where}: needs 'blocks' (can be an empty list)`);
      return;
    }
    if (sec.severity != null && !SEVERITIES.includes(sec.severity as never)) {
      warnings.push(`${where}: severity '${String(sec.severity)}' not in ${SEVERITIES.join(", ")}`);
    }
    if (!Array.isArray(sec.blocks)) {
      errors.push(`${where}: 'blocks' must be a list`);
      return;
    }
    sec.blocks.forEach((b, bi) => {
      const bw = `${where} blocks[${bi}]`;
      if (!isObject(b) || !BLOCK_TYPES.includes(b.type as never)) {
        errors.push(`${bw}: type must be one of ${BLOCK_TYPES.join(", ")}`);
        return;
      }
      if (b.type === "table") {
        const cols = Array.isArray(b.columns) ? b.columns : [];
        const rows = Array.isArray(b.rows) ? b.rows : [];
        if (cols.length === 0) errors.push(`${bw}: table needs 'columns'`);
        rows.forEach((r, ri) => {
          if (!Array.isArray(r)) {
            errors.push(`${bw} rows[${ri}]: must be a list`);
          } else if (cols.length && r.length !== cols.length) {
            errors.push(`${bw} rows[${ri}]: ${r.length} cells for ${cols.length} columns`);
          }
        });
        cols.forEach((c, ci) => {
          if (!isObject(c) || !("label" in c)) errors.push(`${bw} columns[${ci}]: needs 'label'`);
        });
      } else if (b.type === "prose" || b.type === "lead") {
        if (!("html" in b)) errors.push(`${bw}: ${b.type} block needs 'html'`);
      } else if (b.type === "list") {
        if (!Array.isArray(b.items)) errors.push(`${bw}: list block needs 'items' list`);
      } else if (b.type === "subhead") {
        if (!("text" in b)) errors.push(`${bw}: subhead needs 'text'`);
      }
    });
  });

  const order = Array.isArray(data.order) ? data.order : [];
  order.forEach((o, i) => {
    if (!isObject(o) || !("title" in o) || !("detail" in o)) {
      errors.push(`order[${i}] needs 'title' and 'detail'`);
    }
  });

  return { errors, warnings };
}
