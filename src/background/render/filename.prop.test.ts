import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { generateFilename, slugifyTitle } from "./filename";

/**
 * Property-based tests for filename generation.
 *
 * **Validates: Requirements 5.7**
 *
 * Requirement 5.7: THE Filename_Generator SHALL produce filenames from a
 * configurable pattern supporting tokens YYYY, MM, DD, and slugified-title,
 * with total filename length capped at 100 characters including the .md extension.
 */

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a random valid Date object. */
const validDate = fc
  .date({ min: new Date("1970-01-01T00:00:00Z"), max: new Date("2099-12-31T23:59:59Z") })
  .filter((d) => !isNaN(d.getTime()));

/** Generates a title string that contains at least one alphanumeric character. */
const titleWithAlphanumeric = fc
  .tuple(
    fc.unicodeString({ minLength: 0, maxLength: 50 }),
    fc.stringOf(fc.constantFrom("a", "b", "c", "x", "y", "z", "0", "1", "9"), {
      minLength: 1,
      maxLength: 10,
    }),
    fc.unicodeString({ minLength: 0, maxLength: 50 }),
  )
  .map(([prefix, alpha, suffix]) => prefix + alpha + suffix);

/** Generates a non-empty pattern that does NOT contain the slugified-title token. */
const patternWithoutSlug = fc
  .shuffledSubarray(["YYYY", "MM", "DD", "notes", "article", "export"], {
    minLength: 1,
    maxLength: 4,
  })
  .map((parts) => parts.join("-"));

/** Generates a non-empty pattern that contains the slugified-title token. */
const patternWithSlug = fc
  .shuffledSubarray(["YYYY", "MM", "DD", "notes", "article"], {
    minLength: 0,
    maxLength: 3,
  })
  .map((parts) => [...parts, "slugified-title"].join("-"));

/** Generates a non-empty pattern (with or without slugified-title). */
const validPattern = fc.oneof(patternWithoutSlug, patternWithSlug);

/** Generates random Unicode strings for slug testing. */
const unicodeString = fc.unicodeString({ minLength: 0, maxLength: 200 });

/** Generates Unicode strings guaranteed to have at least one [a-zA-Z0-9] char. */
const unicodeWithAlphanumeric = fc
  .tuple(
    fc.unicodeString({ minLength: 0, maxLength: 80 }),
    fc.stringOf(fc.constantFrom("a", "m", "z", "A", "Z", "0", "5", "9"), {
      minLength: 1,
      maxLength: 5,
    }),
    fc.unicodeString({ minLength: 0, maxLength: 80 }),
  )
  .map(([prefix, alpha, suffix]) => prefix + alpha + suffix);

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Filename Generator - Property 5: Filename generation length invariant", () => {
  it("successful filenames are always ≤ 100 chars and end with .md", () => {
    fc.assert(
      fc.property(validPattern, titleWithAlphanumeric, validDate, (pattern, title, date) => {
        const result = generateFilename({ pattern, title, date });

        if (result.ok) {
          expect(result.filename.length).toBeLessThanOrEqual(100);
          expect(result.filename).toMatch(/\.md$/);
        }
        // If not ok, it's a valid failure case — no length assertion needed
      }),
      { numRuns: 500 },
    );
  });

  it("patterns without slugified-title produce filenames ≤ 100 chars with .md", () => {
    fc.assert(
      fc.property(patternWithoutSlug, titleWithAlphanumeric, validDate, (pattern, title, date) => {
        const result = generateFilename({ pattern, title, date });

        if (result.ok) {
          expect(result.filename.length).toBeLessThanOrEqual(100);
          expect(result.filename.endsWith(".md")).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("patterns with slugified-title produce filenames ≤ 100 chars with .md", () => {
    fc.assert(
      fc.property(patternWithSlug, titleWithAlphanumeric, validDate, (pattern, title, date) => {
        const result = generateFilename({ pattern, title, date });

        if (result.ok) {
          expect(result.filename.length).toBeLessThanOrEqual(100);
          expect(result.filename.endsWith(".md")).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("Filename Generator - Property 6: Filename slug determinism", () => {
  it("slug output contains only [a-z0-9-] characters", () => {
    fc.assert(
      fc.property(unicodeString, (input) => {
        const slug = slugifyTitle(input);
        expect(slug).toMatch(/^[a-z0-9-]*$/);
      }),
      { numRuns: 500 },
    );
  });

  it("slug has no consecutive hyphens", () => {
    fc.assert(
      fc.property(unicodeString, (input) => {
        const slug = slugifyTitle(input);
        expect(slug).not.toMatch(/--/);
      }),
      { numRuns: 500 },
    );
  });

  it("slug has no leading hyphens", () => {
    fc.assert(
      fc.property(unicodeString, (input) => {
        const slug = slugifyTitle(input);
        if (slug.length > 0) {
          expect(slug[0]).not.toBe("-");
        }
      }),
      { numRuns: 500 },
    );
  });

  it("slug has no trailing hyphens", () => {
    fc.assert(
      fc.property(unicodeString, (input) => {
        const slug = slugifyTitle(input);
        if (slug.length > 0) {
          expect(slug[slug.length - 1]).not.toBe("-");
        }
      }),
      { numRuns: 500 },
    );
  });

  it("slug is non-empty for titles with at least one alphanumeric character", () => {
    fc.assert(
      fc.property(unicodeWithAlphanumeric, (input) => {
        const slug = slugifyTitle(input);
        expect(slug.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });
});
