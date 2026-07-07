/**
 * Auto Export Filename Generator for Distill v3.
 *
 * Produces timestamp-based filenames with pattern YYYY-MM-DD-HHmm-slugified-title.md
 * to prevent overwriting previous captures during scheduled auto-export.
 *
 * Requirements: 14.6
 */

import { slugifyTitle } from "../render/filename";

export interface AutoExportFilenameInput {
  readonly title: string;
  readonly date: Date;
}

export type AutoExportFilenameResult =
  | { readonly ok: true; readonly filename: string }
  | { readonly ok: false; readonly reason: "filename-invalid"; readonly detail: string };

const MAX_FILENAME_LENGTH = 100;
const EXTENSION = ".md";

/**
 * Generates a filename with HHmm timestamp: YYYY-MM-DD-HHmm-slugified-title.md
 * Total length capped at 100 characters including .md extension.
 * Returns failure if title has no alphanumeric characters (empty slug).
 */
export function generateAutoExportFilename(input: AutoExportFilenameInput): AutoExportFilenameResult {
  const { title, date } = input;

  const slug = slugifyTitle(title);

  if (slug === "") {
    return {
      ok: false,
      reason: "filename-invalid",
      detail: "Title contains no alphanumeric characters for slug generation",
    };
  }

  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");

  const prefix = `${yyyy}-${mm}-${dd}-${hh}${min}-`;
  const maxSlugLength = MAX_FILENAME_LENGTH - EXTENSION.length - prefix.length;

  const truncatedSlug = truncateSlug(slug, maxSlugLength);

  const filename = prefix + truncatedSlug + EXTENSION;

  return { ok: true, filename };
}

/**
 * Truncates a slug to fit within maxLength, ensuring no trailing hyphen.
 */
function truncateSlug(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) {
    return slug;
  }

  let truncated = slug.slice(0, maxLength);

  // Remove trailing hyphens from truncation
  while (truncated.endsWith("-")) {
    truncated = truncated.slice(0, -1);
  }

  return truncated;
}
