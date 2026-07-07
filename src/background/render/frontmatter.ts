/**
 * Frontmatter Renderer — generates YAML frontmatter for Markdown exports.
 *
 * Renders fields in the order specified by `input.fields`, omitting any
 * field whose value is null, undefined, or empty string. Values containing
 * YAML-special characters are double-quoted with JSON-compatible escaping.
 */

import type { ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrontmatterInput {
  readonly article: ExtractedArticle;
  readonly captureDate: string;
  readonly fields: ReadonlyArray<string>;
}

export type FrontmatterResult =
  | { readonly ok: true; readonly yaml: string }
  | { readonly ok: false; readonly reason: "frontmatter-invalid"; readonly detail: string };

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

const FIELD_MAP: Record<string, (input: FrontmatterInput) => string | null | undefined> = {
  title: (input) => input.article.title,
  author: (input) => input.article.author,
  source_url: (input) => input.article.sourceUrl,
  publication_date: (input) => input.article.publicationDate,
  capture_date: (input) => input.captureDate,
  site_name: (input) => input.article.siteName,
};

// ---------------------------------------------------------------------------
// YAML quoting logic
// ---------------------------------------------------------------------------

/**
 * Characters that require the value to be double-quoted in YAML.
 */
const NEEDS_QUOTING_RE = /[:#'"\n]|^\s|\s$/;

/**
 * Determines whether a YAML scalar value needs double-quoting.
 * Values need quoting when they contain colon, hash, single quote,
 * double quote, newline, or have leading/trailing whitespace, or are empty.
 */
export function needsQuoting(value: string): boolean {
  if (value === "") return true;
  return NEEDS_QUOTING_RE.test(value);
}

/**
 * Double-quotes a value using JSON-compatible escaping.
 * Uses JSON.stringify which handles \", \\, \n, \t, etc.
 */
export function quoteValue(value: string): string {
  return JSON.stringify(value);
}

/**
 * Formats a scalar value for YAML output.
 * Returns the value as-is if safe, or double-quoted with escaping if not.
 */
export function formatYamlValue(value: string): string {
  if (needsQuoting(value)) {
    return quoteValue(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export function renderFrontmatter(input: FrontmatterInput): FrontmatterResult {
  const { fields } = input;

  if (fields.length === 0) {
    return {
      ok: false,
      reason: "frontmatter-invalid",
      detail: "No fields specified for frontmatter rendering",
    };
  }

  const lines: string[] = ["---"];

  for (const field of fields) {
    const getter = FIELD_MAP[field];
    if (!getter) {
      // Unknown field — skip silently
      continue;
    }

    const value = getter(input);

    // Omit fields with unavailable values
    if (value === null || value === undefined || value === "") {
      continue;
    }

    lines.push(`${field}: ${formatYamlValue(value)}`);
  }

  lines.push("---");

  // If only delimiters remain (no actual fields rendered), still produce valid output
  const yaml = lines.join("\n") + "\n";

  return { ok: true, yaml };
}
