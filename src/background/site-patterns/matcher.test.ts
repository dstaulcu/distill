import { describe, it, expect } from "vitest";
import {
  matchSitePattern,
  BUILTIN_MEDIUM_PATTERN,
  BUILTIN_GENERIC_FALLBACK_PATTERN,
  BUILTIN_PATTERNS,
} from "./matcher";
import type { SitePattern } from "@shared/types";

describe("CF-6 matchSitePattern", () => {
  describe("user-defined patterns evaluated before built-in", () => {
    it("returns user-defined pattern when it matches before built-in", () => {
      const userPattern: SitePattern = {
        id: "user-medium",
        source: "user",
        urlMatchPattern: "*://*.medium.com/*",
        contentSelector: ".custom-selector",
      };

      const result = matchSitePattern({
        patterns: [userPattern],
        url: "https://blog.medium.com/some-article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("user-medium");
        expect(result.pattern.source).toBe("user");
      }
    });

    it("returns first matching user pattern in array order", () => {
      const first: SitePattern = {
        id: "user-1",
        source: "user",
        urlMatchPattern: "*://*.example.com/*",
        contentSelector: ".first",
      };
      const second: SitePattern = {
        id: "user-2",
        source: "user",
        urlMatchPattern: "*://*.example.com/*",
        contentSelector: ".second",
      };

      const result = matchSitePattern({
        patterns: [first, second],
        url: "https://www.example.com/page",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("user-1");
      }
    });

    it("falls through to built-in when no user pattern matches", () => {
      const userPattern: SitePattern = {
        id: "user-specific",
        source: "user",
        urlMatchPattern: "*://*.mysite.com/*",
        contentSelector: ".my-content",
      };

      const result = matchSitePattern({
        patterns: [userPattern],
        url: "https://blog.medium.com/article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-medium");
      }
    });

    it("CF-6.2 user pattern wins even when stored after a builtin catch-all (picker save order)", () => {
      // Legacy stored settings seeded builtin patterns FIRST; picker-saved user
      // patterns were appended after them. The user pattern must still win.
      const legacyBuiltinCatchAll: SitePattern = {
        id: "builtin-generic",
        source: "builtin",
        urlMatchPattern: "*://*/*",
        contentSelector: "article",
      };
      const pickedUserPattern: SitePattern = {
        id: "user-example-1700000000000",
        source: "user",
        urlMatchPattern: "*://www.example.com/*",
        contentSelector: "#main-content",
      };

      const result = matchSitePattern({
        patterns: [legacyBuiltinCatchAll, pickedUserPattern],
        url: "https://www.example.com/article/42",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("user-example-1700000000000");
        expect(result.pattern.contentSelector).toBe("#main-content");
      }
    });

    it("CF-6.2 builtin-source entries in stored settings are ignored in favor of the canonical builtin list", () => {
      // Legacy stored builtin-generic used plain "article"; the canonical
      // fallback (rich selector chain) must be used instead.
      const legacyBuiltinGeneric: SitePattern = {
        id: "builtin-generic",
        source: "builtin",
        urlMatchPattern: "*://*/*",
        contentSelector: "article",
      };

      const result = matchSitePattern({
        patterns: [legacyBuiltinGeneric],
        url: "https://plain-blog.example.org/post",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe(BUILTIN_GENERIC_FALLBACK_PATTERN.id);
        expect(result.pattern.contentSelector).toBe(BUILTIN_GENERIC_FALLBACK_PATTERN.contentSelector);
      }
    });
  });

  describe("built-in Medium pattern", () => {
    it("matches medium.com root domain", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://medium.com/some-article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-medium");
        expect(result.pattern.contentSelector).toBe("article");
      }
    });

    it("matches subdomains of medium.com", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://blog.medium.com/my-post-123",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-medium");
      }
    });

    it("matches nested subdomains of medium.com", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://deep.nested.medium.com/article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-medium");
      }
    });

    it("matches http scheme for medium.com", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "http://medium.com/article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-medium");
      }
    });
  });

  describe("built-in generic fallback pattern", () => {
    it("matches any http/https URL", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://random-site.org/some/path",
      });

      // Should match either Medium or generic fallback
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-generic-fallback");
      }
    });

    it("has a combined selector for common article containers", () => {
      expect(BUILTIN_GENERIC_FALLBACK_PATTERN.contentSelector).toBe(
        "article, [role='article'], main article, .post-content, .article-body, .entry-content, main, body",
      );
    });

    it("matches URLs with query strings", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://example.com/page?id=123&ref=twitter",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-generic-fallback");
      }
    });
  });

  describe("URL match pattern syntax", () => {
    it("matches wildcard scheme (*://)", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "*://example.com/*",
        contentSelector: ".content",
      };

      expect(
        matchSitePattern({ patterns: [pattern], url: "https://example.com/page" }),
      ).toEqual({ ok: true, pattern });
      expect(
        matchSitePattern({ patterns: [pattern], url: "http://example.com/page" }),
      ).toEqual({ ok: true, pattern });
    });

    it("matches specific http scheme", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "http://example.com/*",
        contentSelector: ".content",
      };

      expect(
        matchSitePattern({ patterns: [pattern], url: "http://example.com/page" }),
      ).toEqual({ ok: true, pattern });

      const httpsResult = matchSitePattern({
        patterns: [pattern],
        url: "https://example.com/page",
      });
      // Should not match http-only pattern with https URL, falls to builtin
      expect(httpsResult.ok).toBe(true);
      if (httpsResult.ok) {
        expect(httpsResult.pattern.id).not.toBe("test");
      }
    });

    it("matches specific https scheme", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "https://example.com/*",
        contentSelector: ".content",
      };

      expect(
        matchSitePattern({ patterns: [pattern], url: "https://example.com/page" }),
      ).toEqual({ ok: true, pattern });

      const httpResult = matchSitePattern({
        patterns: [pattern],
        url: "http://example.com/page",
      });
      expect(httpResult.ok).toBe(true);
      if (httpResult.ok) {
        expect(httpResult.pattern.id).not.toBe("test");
      }
    });

    it("matches wildcard subdomain pattern", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "*://*.example.com/*",
        contentSelector: ".content",
      };

      expect(
        matchSitePattern({ patterns: [pattern], url: "https://sub.example.com/page" }),
      ).toEqual({ ok: true, pattern });
      expect(
        matchSitePattern({ patterns: [pattern], url: "https://example.com/page" }),
      ).toEqual({ ok: true, pattern });
    });

    it("matches path wildcards", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "*://example.com/blog/*",
        contentSelector: ".content",
      };

      expect(
        matchSitePattern({ patterns: [pattern], url: "https://example.com/blog/post-1" }),
      ).toEqual({ ok: true, pattern });

      // Should not match non-blog path
      const otherResult = matchSitePattern({
        patterns: [pattern],
        url: "https://example.com/about",
      });
      expect(otherResult.ok).toBe(true);
      if (otherResult.ok) {
        expect(otherResult.pattern.id).not.toBe("test");
      }
    });

    it("matches all-hosts wildcard", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "*://*/*",
        contentSelector: ".content",
      };

      expect(
        matchSitePattern({ patterns: [pattern], url: "https://anything.com/page" }),
      ).toEqual({ ok: true, pattern });
    });
  });

  describe("edge cases", () => {
    it("returns ok: false for invalid URLs", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "not-a-valid-url",
      });

      expect(result.ok).toBe(false);
    });

    it("returns ok: false for non-http/https URLs", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "ftp://example.com/file",
      });

      expect(result.ok).toBe(false);
    });

    it("returns ok: false for about: URLs", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "about:blank",
      });

      expect(result.ok).toBe(false);
    });

    it("skips malformed match patterns gracefully", () => {
      const badPattern: SitePattern = {
        id: "bad",
        source: "user",
        urlMatchPattern: "not-a-valid-pattern",
        contentSelector: ".content",
      };

      const result = matchSitePattern({
        patterns: [badPattern],
        url: "https://example.com/page",
      });

      // Should skip the bad pattern and fall through to built-in
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-generic-fallback");
      }
    });

    it("handles empty patterns array", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://example.com/page",
      });

      // Should match built-in generic fallback
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.source).toBe("builtin");
      }
    });

    it("handles URL with port number", () => {
      const pattern: SitePattern = {
        id: "test",
        source: "user",
        urlMatchPattern: "*://localhost/*",
        contentSelector: ".content",
      };

      // localhost:3000 hostname is "localhost" so it should match
      const result = matchSitePattern({
        patterns: [pattern],
        url: "http://localhost:3000/page",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("test");
      }
    });

    it("does not match medium.com for non-medium domains", () => {
      const result = matchSitePattern({
        patterns: [],
        url: "https://notmedium.com/article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pattern.id).toBe("builtin-generic-fallback");
      }
    });

    it("built-in patterns have correct structure", () => {
      expect(BUILTIN_PATTERNS).toHaveLength(2);
      expect(BUILTIN_MEDIUM_PATTERN.source).toBe("builtin");
      expect(BUILTIN_GENERIC_FALLBACK_PATTERN.source).toBe("builtin");
    });
  });
});
