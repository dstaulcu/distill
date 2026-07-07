/**
 * Filename Generator for Distill v3 export pipeline.
 *
 * Produces filenames from configurable token patterns with length capping.
 * Supported tokens: YYYY, MM, DD, slugified-title.
 *
 * Requirements: 5.7, 5.13
 */

export interface GenerateFilenameInput {
  readonly pattern: string;
  readonly title: string;
  readonly date: Date;
}

export type GenerateFilenameResult =
  | { readonly ok: true; readonly filename: string }
  | { readonly ok: false; readonly reason: "filename-invalid"; readonly detail: string };

/**
 * Converts a title string into a URL-friendly slug.
 *
 * Rules:
 * - Lowercase the input
 * - Keep only [a-z0-9] characters
 * - Join consecutive alphanumeric chunks with single hyphens
 * - No leading, trailing, or consecutive hyphens
 */
export function slugifyTitle(title: string): string {
  const lower = title.toLowerCase();
  const chunks: string[] = [];
  let current = "";

  for (const char of lower) {
    if (char >= "a" && char <= "z") {
      current += char;
    } else if (char >= "0" && char <= "9") {
      current += char;
    } else {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.join("-");
}

const MAX_FILENAME_LENGTH = 100;
const EXTENSION = ".md";

/**
 * Generates a filename from a configurable pattern with token substitution.
 *
 * Tokens:
 * - YYYY → 4-digit UTC year
 * - MM → 2-digit UTC month (01–12)
 * - DD → 2-digit UTC day (01–31)
 * - slugified-title → slugified version of the title
 *
 * The total filename is capped at 100 characters including the .md extension.
 * If the filename exceeds the cap, the slug portion is truncated.
 */
export function generateFilename(input: GenerateFilenameInput): GenerateFilenameResult {
  const { pattern, title, date } = input;

  // Failure: empty pattern
  if (pattern.trim() === "") {
    return {
      ok: false,
      reason: "filename-invalid",
      detail: "Filename pattern must not be empty",
    };
  }

  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  const slug = slugifyTitle(title);

  // Failure: pattern references slugified-title but title has no alphanumeric chars
  if (pattern.includes("slugified-title") && slug === "") {
    return {
      ok: false,
      reason: "filename-invalid",
      detail: "Title contains no alphanumeric characters for slug generation",
    };
  }

  // Perform token substitution
  let body = pattern;
  body = body.replaceAll("YYYY", yyyy);
  body = body.replaceAll("MM", mm);
  body = body.replaceAll("DD", dd);

  // For slugified-title, we may need to truncate the slug to fit within the cap
  if (body.includes("slugified-title")) {
    const bodyWithoutSlug = body.replaceAll("slugified-title", "");
    const availableForSlug = MAX_FILENAME_LENGTH - EXTENSION.length - bodyWithoutSlug.length;

    if (availableForSlug <= 0) {
      // No room for slug at all — substitute with empty and check below
      body = body.replaceAll("slugified-title", "");
    } else {
      const truncatedSlug = truncateSlug(slug, availableForSlug);
      body = body.replaceAll("slugified-title", truncatedSlug);
    }
  }

  // Failure: substituted body is empty
  if (body.trim() === "") {
    return {
      ok: false,
      reason: "filename-invalid",
      detail: "Substituted filename body is empty after token replacement",
    };
  }

  // Cap total filename length
  const maxBodyLength = MAX_FILENAME_LENGTH - EXTENSION.length;
  if (body.length > maxBodyLength) {
    body = body.slice(0, maxBodyLength);
  }

  const filename = body + EXTENSION;

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
