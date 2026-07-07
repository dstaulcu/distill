/**
 * Property 23: Timestamp-based filename uniqueness
 * Validates: Requirements 14.6
 *
 * Verifies that generateAutoExportFilename produces unique filenames for
 * different timestamps (≥1 minute apart), matches the expected pattern,
 * and respects the 100-char length cap.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generateAutoExportFilename } from "./filename";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a title with at least one alphanumeric character. */
const titleWithAlphanumeric = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 30 }),
    fc.stringOf(fc.constantFrom("a", "b", "c", "x", "y", "z", "0", "1", "9"), {
      minLength: 1,
      maxLength: 10,
    }),
    fc.string({ minLength: 0, maxLength: 30 }),
  )
  .map(([prefix, alpha, suffix]) => prefix + alpha + suffix);

/** Generates a valid date. */
const validDate = fc
  .date({ min: new Date("1970-01-01T00:00:00Z"), max: new Date("2099-12-31T23:59:59Z") })
  .filter((d) => !isNaN(d.getTime()));

/**
 * Generates a pair of dates that differ by at least 1 minute.
 * We ensure they produce different HHmm or date components.
 */
const datePairDifferingByAtLeast1Minute = fc
  .tuple(validDate, fc.integer({ min: 1, max: 525600 })) // offset in minutes (up to 1 year)
  .map(([date1, offsetMinutes]) => {
    const date2 = new Date(date1.getTime() + offsetMinutes * 60_000);
    return [date1, date2] as const;
  })
  .filter(([d1, d2]) => {
    // Ensure the dates are both valid
    return !isNaN(d1.getTime()) && !isNaN(d2.getTime());
  });

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Property 23: Timestamp-based filename uniqueness", () => {
  it("dates differing by ≥1 minute produce different filenames for the same title", () => {
    /**
     * **Validates: Requirements 14.6**
     */
    fc.assert(
      fc.property(datePairDifferingByAtLeast1Minute, titleWithAlphanumeric, ([date1, date2], title) => {
        const result1 = generateAutoExportFilename({ title, date: date1 });
        const result2 = generateAutoExportFilename({ title, date: date2 });

        // Both should succeed (title has alphanumeric chars)
        if (!result1.ok || !result2.ok) return;

        expect(result1.filename).not.toBe(result2.filename);
      }),
      { numRuns: 200 },
    );
  });

  it("filenames match YYYY-MM-DD-HHmm-{slug}.md pattern", () => {
    /**
     * **Validates: Requirements 14.6**
     */
    fc.assert(
      fc.property(validDate, titleWithAlphanumeric, (date, title) => {
        const result = generateAutoExportFilename({ title, date });

        if (!result.ok) return;

        // Pattern: YYYY-MM-DD-HHmm-slug.md
        expect(result.filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9][a-z0-9-]*\.md$/);
      }),
      { numRuns: 200 },
    );
  });

  it("filenames are always ≤100 characters", () => {
    /**
     * **Validates: Requirements 14.6**
     */
    fc.assert(
      fc.property(
        validDate,
        // Use longer titles to stress the length cap
        fc.string({ minLength: 1, maxLength: 300 }).filter((s) => /[a-z0-9]/i.test(s)),
        (date, title) => {
          const result = generateAutoExportFilename({ title, date });

          if (!result.ok) return;

          expect(result.filename.length).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("filenames always end with .md extension", () => {
    /**
     * **Validates: Requirements 14.6**
     */
    fc.assert(
      fc.property(validDate, titleWithAlphanumeric, (date, title) => {
        const result = generateAutoExportFilename({ title, date });

        if (!result.ok) return;

        expect(result.filename).toMatch(/\.md$/);
      }),
      { numRuns: 200 },
    );
  });

  it("filename timestamp prefix matches the input date's UTC components", () => {
    /**
     * **Validates: Requirements 14.6**
     */
    fc.assert(
      fc.property(validDate, titleWithAlphanumeric, (date, title) => {
        const result = generateAutoExportFilename({ title, date });

        if (!result.ok) return;

        const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
        const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(date.getUTCDate()).padStart(2, "0");
        const hh = String(date.getUTCHours()).padStart(2, "0");
        const min = String(date.getUTCMinutes()).padStart(2, "0");

        const expectedPrefix = `${yyyy}-${mm}-${dd}-${hh}${min}-`;
        expect(result.filename.startsWith(expectedPrefix)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
