import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  matchSitePattern,
  BUILTIN_MEDIUM_PATTERN,
  BUILTIN_GENERIC_FALLBACK_PATTERN,
} from "./matcher";
import type { SitePattern } from "@shared/types";

/**
 * Property-based tests for site pattern priority ordering.
 *
 * **Validates: Requirements 3.1, 7.4, 7.5**
 *
 * Requirement 3.1: WHEN a page has a saved Site_Pattern (user-defined selector
 * for the current site), THE Content_Extractor SHALL use that pattern's CSS
 * selector as the extraction source, bypassing heuristic detection.
 *
 * Requirement 7.4: THE Site_Pattern_Matcher SHALL evaluate user-defined patterns
 * (including those saved via element picker) before built-in patterns in their
 * stored array order, using the first matching pattern.
 *
 * Requirement 7.5: WHEN multiple patterns match the current page URL, THE
 * Site_Pattern_Matcher SHALL use the first matching pattern in priority order
 * (user-defined array order, then built-in array order).
 */

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a valid domain name segment. */
const domainSegment = fc.stringOf(
  fc.constantFrom("a", "b", "c", "d", "e", "f", "x", "y", "z", "1", "2", "3"),
  { minLength: 1, maxLength: 8 },
);

/** Generates a valid domain like "abc.example.com". */
const domain = fc.tuple(domainSegment, domainSegment).map(
  ([sub, base]) => `${sub}.${base}.com`,
);

/** Generates a valid path segment. */
const pathSegment = fc.stringOf(
  fc.constantFrom("a", "b", "c", "page", "post", "article", "docs", "1", "2"),
  { minLength: 1, maxLength: 10 },
);

/** Generates a URL path like "/page/article". */
const urlPath = fc
  .array(pathSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => "/" + segments.join("/"));

/** Generates a scheme. */
const scheme = fc.constantFrom("http", "https");

/** Generates a full valid http/https URL. */
const validHttpUrl = fc
  .record({ scheme, domain, path: urlPath })
  .map(({ scheme, domain, path }) => `${scheme}://${domain}${path}`);

/** Generates a unique ID string. */
const patternId = fc
  .tuple(fc.constantFrom("user", "custom", "my", "site"), fc.nat({ max: 9999 }))
  .map(([prefix, n]) => `${prefix}-${n}`);

/** Generates a CSS selector string. */
const contentSelector = fc.constantFrom(
  ".content",
  ".article",
  "article",
  "main",
  ".post-body",
  "#content",
  ".entry-content",
  "[role='main']",
);

/**
 * Generates a user-defined SitePattern that uses a wildcard match pattern
 * guaranteed to match any URL on the given domain.
 */
function userPatternForDomain(domainArb: fc.Arbitrary<string>) {
  return fc
    .record({
      id: patternId,
      domain: domainArb,
      contentSelector,
    })
    .map(
      ({ id, domain, contentSelector }): SitePattern => ({
        id,
        source: "user",
        urlMatchPattern: `*://*.${domain}/*`,
        contentSelector,
      }),
    );
}

/**
 * Generates a user-defined SitePattern with a catch-all match pattern
 * that matches any http/https URL.
 */
const catchAllUserPattern = fc
  .record({ id: patternId, contentSelector })
  .map(
    ({ id, contentSelector }): SitePattern => ({
      id,
      source: "user",
      urlMatchPattern: "*://*/*",
      contentSelector,
    }),
  );

/**
 * Generates a user-defined SitePattern that matches medium.com URLs.
 */
const mediumUserPattern = fc
  .record({ id: patternId, contentSelector })
  .map(
    ({ id, contentSelector }): SitePattern => ({
      id,
      source: "user",
      urlMatchPattern: "*://*.medium.com/*",
      contentSelector,
    }),
  );

/** Generates a Medium URL (subdomain.medium.com/path). */
const mediumUrl = fc
  .record({ sub: domainSegment, path: urlPath, scheme })
  .map(({ sub, path, scheme }) => `${scheme}://${sub}.medium.com${path}`);

/** Generates a non-medium domain. */
const nonMediumDomain = domain.filter(
  (d) => !d.endsWith("medium.com") && !d.includes("medium.com"),
);

/** Generates a URL that does NOT match medium.com. */
const nonMediumUrl = fc
  .record({ scheme, domain: nonMediumDomain, path: urlPath })
  .map(({ scheme, domain, path }) => `${scheme}://${domain}${path}`);

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Site Pattern Matcher - Property 11: Site pattern priority ordering", () => {
  it("first user-defined pattern in array order wins when multiple match the same URL", () => {
    fc.assert(
      fc.property(
        // Generate 2-5 catch-all user patterns (all will match any URL)
        fc.array(catchAllUserPattern, { minLength: 2, maxLength: 5 }),
        validHttpUrl,
        (patterns, url) => {
          // Ensure all patterns have unique IDs
          const uniquePatterns = patterns.map((p, i) => ({
            ...p,
            id: `${p.id}-${i}`,
          }));

          const result = matchSitePattern({ patterns: uniquePatterns, url });

          expect(result.ok).toBe(true);
          if (result.ok) {
            // First pattern in array order should win
            expect(result.pattern.id).toBe(uniquePatterns[0].id);
            expect(result.pattern.source).toBe("user");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("user-defined pattern takes priority over built-in Medium pattern for Medium URLs", () => {
    fc.assert(
      fc.property(mediumUserPattern, mediumUrl, (userPattern, url) => {
        const result = matchSitePattern({ patterns: [userPattern], url });

        expect(result.ok).toBe(true);
        if (result.ok) {
          // User pattern should win over built-in Medium pattern
          expect(result.pattern.id).toBe(userPattern.id);
          expect(result.pattern.source).toBe("user");
          expect(result.pattern.id).not.toBe(BUILTIN_MEDIUM_PATTERN.id);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("built-in patterns are used as fallback when no user patterns match", () => {
    fc.assert(
      fc.property(nonMediumUrl, (url) => {
        // Use a user pattern that only matches medium.com — won't match our non-medium URL
        const nonMatchingUserPattern: SitePattern = {
          id: "user-medium-only",
          source: "user",
          urlMatchPattern: "*://*.medium.com/*",
          contentSelector: ".custom",
        };

        const result = matchSitePattern({
          patterns: [nonMatchingUserPattern],
          url,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          // Should fall through to a built-in pattern
          expect(result.pattern.source).toBe("builtin");
          expect(result.pattern.id).toBe(
            BUILTIN_GENERIC_FALLBACK_PATTERN.id,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("any valid http/https URL matches at least one pattern (generic fallback)", () => {
    fc.assert(
      fc.property(validHttpUrl, (url) => {
        // With no user patterns, the built-in generic fallback should always match
        const result = matchSitePattern({ patterns: [], url });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.pattern.source).toBe("builtin");
        }
      }),
      { numRuns: 200 },
    );
  });
});
