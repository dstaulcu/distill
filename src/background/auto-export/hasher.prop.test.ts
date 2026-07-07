/**
 * Property 24: Content change detection via hash comparison
 * Validates: Requirements 14.11
 *
 * Verifies that hashContent produces deterministic 8-char hex hashes based on
 * the first 10,000 characters, and hasContentChanged correctly detects differences.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { hashContent, hasContentChanged } from "./hasher";

describe("Property 24: Content change detection via hash comparison", () => {
  it("identical content always produces the same hash", () => {
    /**
     * **Validates: Requirements 14.11**
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 15000 }), (content) => {
        const hash1 = hashContent(content);
        const hash2 = hashContent(content);
        expect(hash1).toBe(hash2);
      }),
      { numRuns: 200 },
    );
  });

  it("hash is always an 8-character hex string", () => {
    /**
     * **Validates: Requirements 14.11**
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 15000 }), (content) => {
        const hash = hashContent(content);
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
      }),
      { numRuns: 200 },
    );
  });

  it("content differing within first 10k chars produces different hashes", () => {
    /**
     * **Validates: Requirements 14.11**
     */
    fc.assert(
      fc.property(
        // Generate two strings that differ in at least one position within first 10k chars
        fc.string({ minLength: 1, maxLength: 10000 }),
        fc.string({ minLength: 1, maxLength: 10000 }),
        (a, b) => {
          // Only test when strings actually differ
          fc.pre(a !== b);
          const hashA = hashContent(a);
          const hashB = hashContent(b);
          // Hash collision is theoretically possible but extremely unlikely for random inputs
          // We accept this as a probabilistic property
          expect(hashA).not.toBe(hashB);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("SF-4 content differing only after 10k chars produces different hashes", () => {
    /**
     * **Validates: REQUIREMENTS.md SF-4** — the full content is hashed, so
     * tail-only changes are detected (Q3 decision).
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 10000, maxLength: 10000 }),
        fc.string({ minLength: 1, maxLength: 5000 }),
        fc.string({ minLength: 1, maxLength: 5000 }),
        (prefix, suffixA, suffixB) => {
          fc.pre(suffixA !== suffixB);
          const contentA = prefix + suffixA;
          const contentB = prefix + suffixB;
          expect(hashContent(contentA)).not.toBe(hashContent(contentB));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("hasContentChanged returns true when previousHash is null", () => {
    /**
     * **Validates: Requirements 14.11**
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 5000 }), (content) => {
        const currentHash = hashContent(content);
        expect(hasContentChanged(null, currentHash)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("hasContentChanged returns false for identical hashes", () => {
    /**
     * **Validates: Requirements 14.11**
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 5000 }), (content) => {
        const hash = hashContent(content);
        expect(hasContentChanged(hash, hash)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("hasContentChanged returns true for different hashes", () => {
    /**
     * **Validates: Requirements 14.11**
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 5000 }),
        fc.string({ minLength: 1, maxLength: 5000 }),
        (a, b) => {
          fc.pre(a !== b);
          const hashA = hashContent(a);
          const hashB = hashContent(b);
          // If hashes happen to collide (unlikely), skip
          fc.pre(hashA !== hashB);
          expect(hasContentChanged(hashA, hashB)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
