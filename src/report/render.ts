/**
 * Render a report contract to a single self-contained HTML string.
 *
 * Validate first (a fatal error means no HTML — a half-rendered report is worse
 * than none), then inject the title and the data into the template. Both
 * injections use a replacer *function* so a `$` in the data — money is full of
 * them — is never read as a `String.replace` special pattern, and the JSON has
 * its `<` escaped so it cannot break out of the data <script> block while
 * staying valid JSON.
 */
import { validateReport } from "./validate.js";
import { reportTemplate } from "./template.js";
import { escapeHtml } from "./browser-helpers.js";
import type { ValidationResult } from "./contract.js";

export interface RenderResult extends ValidationResult {
  /** Present only when there were no fatal errors. */
  html?: string;
}

export function renderReport(input: unknown): RenderResult {
  const { errors, warnings } = validateReport(input);
  if (errors.length) return { errors, warnings };

  const data = input as { title?: string };
  const title = escapeHtml(data.title ?? "Report");
  const json = JSON.stringify(input).replace(/</g, "\\u003c");

  const html = reportTemplate()
    .replace("__TITLE__", () => title)
    .replace("__REPORT_JSON__", () => json);

  return { html, errors, warnings };
}
