import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isSamePageNavigation, canonicalizeUrl } from "./url-utils";

/**
 * Property-based tests for URL navigation session logic.
 *
 * **Validates: Requirements 1.9, 12.4**
 *
 * Requirement 1.9: WHEN the active tab navigates to a URL with a different
 * origin, pathname, or query string, THE Background_Script SHALL start a new
 * session for that page (fragment-only changes are treated as the same page).
 *
 * Requirement 12.4: THE Active_Tab_Tracker SHALL listen to browser.tabs.onUpdated
 * events filtered to status "complete" and, when the updated tab is the currently
 * tracked active tab, trigger a re-extraction if the URL has changed.
 */

/** Arbitrary that generates a valid URL origin (scheme + host + optional port). */
const urlOrigin = fc.record({
  scheme: fc.constantFrom("http", "https"),
  host: fc.stringOf(fc.constantFrom("a", "b", "c", "d", "e", "1", "2", "3"), { minLength: 1, maxLength: 10 })
    .map((s) => `${s}.example.com`),
  port: fc.option(fc.integer({ min: 80, max: 9999 }), { nil: undefined }),
}).map(({ scheme, host, port }) =>
  port !== undefined ? `${scheme}://${host}:${port}` : `${scheme}://${host}`
);

/** Arbitrary that generates a valid URL path segment. */
const urlPath = fc.array(
  fc.stringOf(fc.constantFrom("a", "b", "c", "d", "1", "2", "page", "docs", "api"), { minLength: 1, maxLength: 8 }),
  { minLength: 0, maxLength: 3 },
).map((segments) => "/" + segments.join("/"));

/** Arbitrary that generates a query string (possibly empty). */
const urlQuery = fc.array(
  fc.record({
    key: fc.stringOf(fc.constantFrom("q", "page", "id", "sort", "filter"), { minLength: 1, maxLength: 6 }),
    value: fc.stringOf(fc.constantFrom("a", "b", "1", "2", "true", "false"), { minLength: 1, maxLength: 5 }),
  }),
  { minLength: 0, maxLength: 3 },
).map((pairs) =>
  pairs.length === 0 ? "" : "?" + pairs.map(({ key, value }) => `${key}=${value}`).join("&")
);

/** Arbitrary that generates a fragment (possibly empty). */
const urlFragment = fc.option(
  fc.stringOf(fc.constantFrom("a", "b", "c", "section", "top", "bottom", "1", "2"), { minLength: 1, maxLength: 10 }),
  { nil: undefined },
).map((frag) => (frag !== undefined ? `#${frag}` : ""));

/** Arbitrary that generates a complete valid URL. */
const validUrl = fc.record({
  origin: urlOrigin,
  path: urlPath,
  query: urlQuery,
  fragment: urlFragment,
}).map(({ origin, path, query, fragment }) => `${origin}${path}${query}${fragment}`);

/** Arbitrary that generates a URL with its components separated for manipulation. */
const urlComponents = fc.record({
  origin: urlOrigin,
  path: urlPath,
  query: urlQuery,
  fragment: urlFragment,
});

describe("url-utils property tests", () => {
  describe("Property 3: URL navigation resets session", () => {
    it("changing only the fragment preserves same-page navigation (returns true)", () => {
      fc.assert(
        fc.property(
          urlComponents,
          fc.stringOf(fc.constantFrom("a", "b", "c", "x", "y", "1", "2", "3"), { minLength: 1, maxLength: 10 }),
          fc.stringOf(fc.constantFrom("d", "e", "f", "z", "w", "4", "5", "6"), { minLength: 1, maxLength: 10 }),
          ({ origin, path, query }, frag1, frag2) => {
            const base = `${origin}${path}${query}`;
            const url1 = `${base}#${frag1}`;
            const url2 = `${base}#${frag2}`;

            expect(isSamePageNavigation(url1, url2)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("adding or removing a fragment preserves same-page navigation (returns true)", () => {
      fc.assert(
        fc.property(
          urlComponents,
          fc.stringOf(fc.constantFrom("a", "b", "c", "top", "section"), { minLength: 1, maxLength: 10 }),
          ({ origin, path, query }, frag) => {
            const base = `${origin}${path}${query}`;
            const urlWithFragment = `${base}#${frag}`;
            const urlWithoutFragment = base;

            expect(isSamePageNavigation(urlWithFragment, urlWithoutFragment)).toBe(true);
            expect(isSamePageNavigation(urlWithoutFragment, urlWithFragment)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("different origins trigger session reset (returns false)", () => {
      fc.assert(
        fc.property(
          urlComponents,
          urlOrigin,
          ({ origin, path, query, fragment }, differentOrigin) => {
            // Only test when origins are actually different
            fc.pre(origin !== differentOrigin);

            const url1 = `${origin}${path}${query}${fragment}`;
            const url2 = `${differentOrigin}${path}${query}${fragment}`;

            expect(isSamePageNavigation(url1, url2)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("different paths trigger session reset (returns false)", () => {
      fc.assert(
        fc.property(
          urlComponents,
          urlPath,
          ({ origin, path, query, fragment }, differentPath) => {
            fc.pre(path !== differentPath);

            const url1 = `${origin}${path}${query}${fragment}`;
            const url2 = `${origin}${differentPath}${query}${fragment}`;

            expect(isSamePageNavigation(url1, url2)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("different query strings trigger session reset (returns false)", () => {
      fc.assert(
        fc.property(
          urlComponents,
          urlQuery,
          ({ origin, path, query, fragment }, differentQuery) => {
            fc.pre(query !== differentQuery);

            const url1 = `${origin}${path}${query}${fragment}`;
            const url2 = `${origin}${path}${differentQuery}${fragment}`;

            expect(isSamePageNavigation(url1, url2)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("canonicalizeUrl always strips the fragment", () => {
      fc.assert(
        fc.property(validUrl, (url) => {
          const canonical = canonicalizeUrl(url);
          expect(canonical).not.toContain("#");
        }),
        { numRuns: 200 },
      );
    });

    it("canonicalizeUrl preserves origin, path, and query", () => {
      fc.assert(
        fc.property(urlComponents, ({ origin, path, query, fragment }) => {
          const url = `${origin}${path}${query}${fragment}`;
          const canonical = canonicalizeUrl(url);

          // The URL constructor normalizes default ports (80 for http, 443 for https),
          // so we compare against the URL-parsed expected value rather than raw string.
          const parsed = new URL(url);
          const expected = parsed.origin + parsed.pathname + parsed.search;

          expect(canonical).toBe(expected);
        }),
        { numRuns: 200 },
      );
    });

    it("isSamePageNavigation never throws for any string input", () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (a, b) => {
          // Should never throw — returns boolean for any input
          const result = isSamePageNavigation(a, b);
          expect(typeof result).toBe("boolean");
        }),
        { numRuns: 200 },
      );
    });
  });
});
