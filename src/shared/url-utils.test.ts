import { describe, it, expect } from "vitest";
import { isSamePageNavigation, canonicalizeUrl } from "./url-utils";

describe("url-utils", () => {
  describe("isSamePageNavigation", () => {
    it("returns true when URLs are identical", () => {
      const url = "https://example.com/page?q=1#section";
      expect(isSamePageNavigation(url, url)).toBe(true);
    });

    it("returns true when only the fragment differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page?q=1#section1",
          "https://example.com/page?q=1#section2",
        ),
      ).toBe(true);
    });

    it("returns true when one URL has a fragment and the other does not", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page",
          "https://example.com/page#top",
        ),
      ).toBe(true);
    });

    it("returns false when the pathname differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page-a",
          "https://example.com/page-b",
        ),
      ).toBe(false);
    });

    it("returns false when the query string differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page?q=1",
          "https://example.com/page?q=2",
        ),
      ).toBe(false);
    });

    it("returns false when the origin differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page",
          "https://other.com/page",
        ),
      ).toBe(false);
    });

    it("returns false when the protocol differs", () => {
      expect(
        isSamePageNavigation(
          "http://example.com/page",
          "https://example.com/page",
        ),
      ).toBe(false);
    });

    it("returns false when the port differs", () => {
      expect(
        isSamePageNavigation(
          "https://example.com:443/page",
          "https://example.com:8080/page",
        ),
      ).toBe(false);
    });

    it("returns false for malformed old URL", () => {
      expect(isSamePageNavigation("not-a-url", "https://example.com")).toBe(false);
    });

    it("returns false for malformed new URL", () => {
      expect(isSamePageNavigation("https://example.com", "not-a-url")).toBe(false);
    });

    it("returns false when both URLs are malformed", () => {
      expect(isSamePageNavigation("bad", "also-bad")).toBe(false);
    });

    it("returns true when query is empty on both and fragments differ", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/docs#intro",
          "https://example.com/docs#conclusion",
        ),
      ).toBe(true);
    });

    it("returns false when one has a query and the other does not", () => {
      expect(
        isSamePageNavigation(
          "https://example.com/page",
          "https://example.com/page?new=true",
        ),
      ).toBe(false);
    });
  });

  describe("canonicalizeUrl", () => {
    it("strips the fragment from a URL", () => {
      expect(canonicalizeUrl("https://example.com/page#section")).toBe(
        "https://example.com/page",
      );
    });

    it("preserves the query string", () => {
      expect(canonicalizeUrl("https://example.com/page?q=1#section")).toBe(
        "https://example.com/page?q=1",
      );
    });

    it("returns the same URL when there is no fragment", () => {
      expect(canonicalizeUrl("https://example.com/page?q=1")).toBe(
        "https://example.com/page?q=1",
      );
    });

    it("handles URLs with no path", () => {
      expect(canonicalizeUrl("https://example.com#top")).toBe(
        "https://example.com/",
      );
    });

    it("handles URLs with trailing slash", () => {
      expect(canonicalizeUrl("https://example.com/path/#section")).toBe(
        "https://example.com/path/",
      );
    });

    it("returns the original string for malformed URLs", () => {
      expect(canonicalizeUrl("not-a-url")).toBe("not-a-url");
    });

    it("handles empty fragment marker", () => {
      expect(canonicalizeUrl("https://example.com/page#")).toBe(
        "https://example.com/page",
      );
    });
  });
});
