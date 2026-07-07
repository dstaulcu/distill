import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { extractMetadata } from "./metadata";

/**
 * Property 16: Metadata extraction priority chain
 * Validates: Requirements 3.5
 *
 * Verifies that extractMetadata resolves each field using the priority:
 * Open Graph → JSON-LD → meta tags → DOM heuristics
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a non-empty trimmed string suitable for metadata values */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 80 })
  .filter((s) => s.trim().length > 0)
  .map((s) => s.trim());

/** Generate a valid-looking URL */
const urlArb = fc.webUrl();

/** Generate a date string */
const dateStringArb = fc.date({ min: new Date("2000-01-01"), max: new Date("2030-12-31") })
  .map((d) => d.toISOString());

/** Build an HTML document string from metadata sources */
function buildHtml(opts: {
  ogTitle?: string;
  ogAuthor?: string;
  ogDate?: string;
  ogUrl?: string;
  ogSiteName?: string;
  jsonLdTitle?: string;
  jsonLdAuthor?: string;
  jsonLdDate?: string;
  jsonLdPublisher?: string;
  metaAuthor?: string;
  metaDate?: string;
  metaAppName?: string;
  docTitle?: string;
  canonicalUrl?: string;
  timeDatetime?: string;
}): string {
  const headParts: string[] = [];

  // OG tags
  if (opts.ogTitle) headParts.push(`<meta property="og:title" content="${escapeAttr(opts.ogTitle)}" />`);
  if (opts.ogAuthor) headParts.push(`<meta property="article:author" content="${escapeAttr(opts.ogAuthor)}" />`);
  if (opts.ogDate) headParts.push(`<meta property="article:published_time" content="${escapeAttr(opts.ogDate)}" />`);
  if (opts.ogUrl) headParts.push(`<meta property="og:url" content="${escapeAttr(opts.ogUrl)}" />`);
  if (opts.ogSiteName) headParts.push(`<meta property="og:site_name" content="${escapeAttr(opts.ogSiteName)}" />`);

  // JSON-LD
  const jsonLd: Record<string, unknown> = { "@type": "Article" };
  let hasJsonLd = false;
  if (opts.jsonLdTitle) { jsonLd.headline = opts.jsonLdTitle; hasJsonLd = true; }
  if (opts.jsonLdAuthor) { jsonLd.author = { name: opts.jsonLdAuthor }; hasJsonLd = true; }
  if (opts.jsonLdDate) { jsonLd.datePublished = opts.jsonLdDate; hasJsonLd = true; }
  if (opts.jsonLdPublisher) { jsonLd.publisher = { name: opts.jsonLdPublisher }; hasJsonLd = true; }
  if (hasJsonLd) {
    headParts.push(`<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`);
  }

  // Meta tags
  if (opts.metaAuthor) headParts.push(`<meta name="author" content="${escapeAttr(opts.metaAuthor)}" />`);
  if (opts.metaDate) headParts.push(`<meta name="date" content="${escapeAttr(opts.metaDate)}" />`);
  if (opts.metaAppName) headParts.push(`<meta name="application-name" content="${escapeAttr(opts.metaAppName)}" />`);

  // DOM heuristics
  if (opts.docTitle) headParts.push(`<title>${escapeHtml(opts.docTitle)}</title>`);
  if (opts.canonicalUrl) headParts.push(`<link rel="canonical" href="${escapeAttr(opts.canonicalUrl)}" />`);

  const bodyParts: string[] = [];
  if (opts.timeDatetime) bodyParts.push(`<time datetime="${escapeAttr(opts.timeDatetime)}">date</time>`);

  return `<html><head>${headParts.join("\n")}</head><body>${bodyParts.join("\n")}</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function createDoc(html: string, url = "https://example.com/article"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Property 16: Metadata extraction priority chain", () => {
  it("OG tags always win when present, regardless of other sources", () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const arb = fc.record({
      ogTitle: nonEmptyStringArb,
      ogAuthor: nonEmptyStringArb,
      ogDate: dateStringArb,
      ogUrl: urlArb,
      ogSiteName: nonEmptyStringArb,
      // Other sources that should be ignored
      jsonLdTitle: fc.option(nonEmptyStringArb, { nil: undefined }),
      jsonLdAuthor: fc.option(nonEmptyStringArb, { nil: undefined }),
      jsonLdDate: fc.option(dateStringArb, { nil: undefined }),
      jsonLdPublisher: fc.option(nonEmptyStringArb, { nil: undefined }),
      metaAuthor: fc.option(nonEmptyStringArb, { nil: undefined }),
      metaDate: fc.option(dateStringArb, { nil: undefined }),
      metaAppName: fc.option(nonEmptyStringArb, { nil: undefined }),
      docTitle: fc.option(nonEmptyStringArb, { nil: undefined }),
      canonicalUrl: fc.option(urlArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(arb, (data) => {
        const html = buildHtml(data);
        const doc = createDoc(html);
        const result = extractMetadata({ doc, url: "https://example.com/article" });

        expect(result.title).toBe(data.ogTitle);
        expect(result.author).toBe(data.ogAuthor);
        expect(result.publicationDate).toBe(data.ogDate);
        expect(result.sourceUrl).toBe(data.ogUrl);
        expect(result.siteName).toBe(data.ogSiteName);
      }),
      { numRuns: 100 },
    );
  });

  it("JSON-LD wins over meta tags when OG is absent", () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const arb = fc.record({
      jsonLdTitle: nonEmptyStringArb,
      jsonLdAuthor: nonEmptyStringArb,
      jsonLdDate: dateStringArb,
      jsonLdPublisher: nonEmptyStringArb,
      // Meta/DOM sources that should be ignored
      metaAuthor: fc.option(nonEmptyStringArb, { nil: undefined }),
      metaDate: fc.option(dateStringArb, { nil: undefined }),
      metaAppName: fc.option(nonEmptyStringArb, { nil: undefined }),
      docTitle: fc.option(nonEmptyStringArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(arb, (data) => {
        const html = buildHtml(data);
        const doc = createDoc(html);
        const result = extractMetadata({ doc, url: "https://example.com/article" });

        expect(result.title).toBe(data.jsonLdTitle);
        expect(result.author).toBe(data.jsonLdAuthor);
        expect(result.publicationDate).toBe(data.jsonLdDate);
        expect(result.siteName).toBe(data.jsonLdPublisher);
      }),
      { numRuns: 100 },
    );
  });

  it("meta tags are used when both OG and JSON-LD are absent", () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const arb = fc.record({
      metaAuthor: nonEmptyStringArb,
      metaDate: dateStringArb,
      metaAppName: nonEmptyStringArb,
      docTitle: nonEmptyStringArb,
      canonicalUrl: urlArb,
    });

    fc.assert(
      fc.property(arb, (data) => {
        const html = buildHtml(data);
        const doc = createDoc(html);
        const result = extractMetadata({ doc, url: "https://fallback.example.com/page" });

        // title falls back to document.title (no OG, no JSON-LD)
        // Note: document.title normalizes internal whitespace per the HTML spec
        const expectedTitle = data.docTitle.replace(/\s+/g, " ").trim();
        expect(result.title).toBe(expectedTitle);
        // author falls back to meta[name="author"]
        expect(result.author).toBe(data.metaAuthor);
        // publicationDate falls back to meta[name="date"]
        expect(result.publicationDate).toBe(data.metaDate);
        // sourceUrl falls back to canonical link
        expect(result.sourceUrl).toBe(data.canonicalUrl);
        // siteName falls back to meta[name="application-name"]
        expect(result.siteName).toBe(data.metaAppName);
      }),
      { numRuns: 100 },
    );
  });

  it("never throws for any combination of metadata sources", () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const arb = fc.record({
      ogTitle: fc.option(nonEmptyStringArb, { nil: undefined }),
      ogAuthor: fc.option(nonEmptyStringArb, { nil: undefined }),
      ogDate: fc.option(dateStringArb, { nil: undefined }),
      ogUrl: fc.option(urlArb, { nil: undefined }),
      ogSiteName: fc.option(nonEmptyStringArb, { nil: undefined }),
      jsonLdTitle: fc.option(nonEmptyStringArb, { nil: undefined }),
      jsonLdAuthor: fc.option(nonEmptyStringArb, { nil: undefined }),
      jsonLdDate: fc.option(dateStringArb, { nil: undefined }),
      jsonLdPublisher: fc.option(nonEmptyStringArb, { nil: undefined }),
      metaAuthor: fc.option(nonEmptyStringArb, { nil: undefined }),
      metaDate: fc.option(dateStringArb, { nil: undefined }),
      metaAppName: fc.option(nonEmptyStringArb, { nil: undefined }),
      docTitle: fc.option(nonEmptyStringArb, { nil: undefined }),
      canonicalUrl: fc.option(urlArb, { nil: undefined }),
      timeDatetime: fc.option(dateStringArb, { nil: undefined }),
    });

    // Use valid URLs for JSDOM construction, but pass various URL strings to extractMetadata
    const urlPassedToExtractor = fc.oneof(
      urlArb,
      fc.constant(""),
      fc.constant("not-a-url"),
      fc.constant("https://example.com/page"),
    );

    fc.assert(
      fc.property(arb, urlPassedToExtractor, (data, url) => {
        const html = buildHtml(data);
        // JSDOM requires a valid URL for construction
        const doc = createDoc(html, "https://example.com/test");

        // Must never throw — extractMetadata handles any url string gracefully
        const result = extractMetadata({ doc, url });

        // Result must always have the expected shape
        expect(typeof result.title).toBe("string");
        expect(result.author === null || typeof result.author === "string").toBe(true);
        expect(result.publicationDate === null || typeof result.publicationDate === "string").toBe(true);
        expect(typeof result.sourceUrl).toBe("string");
        expect(typeof result.siteName).toBe("string");
      }),
      { numRuns: 200 },
    );
  });
});
