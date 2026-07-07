import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractMetadata } from "./metadata";

function createDoc(html: string): Document {
  const dom = new JSDOM(html, { url: "https://example.com/article" });
  return dom.window.document;
}

describe("CF-1.7 extractMetadata", () => {
  describe("title resolution", () => {
    it("prefers og:title over all other sources", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="og:title" content="OG Title" />
            <title>Document Title</title>
            <script type="application/ld+json">{"@type":"Article","headline":"JSON-LD Title"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("OG Title");
    });

    it("falls back to JSON-LD headline when no og:title", () => {
      const doc = createDoc(`
        <html>
          <head>
            <title>Document Title</title>
            <script type="application/ld+json">{"@type":"Article","headline":"JSON-LD Headline"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("JSON-LD Headline");
    });

    it("falls back to JSON-LD name when no headline", () => {
      const doc = createDoc(`
        <html>
          <head>
            <title>Document Title</title>
            <script type="application/ld+json">{"@type":"Article","name":"JSON-LD Name"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("JSON-LD Name");
    });

    it("falls back to document.title when no OG or JSON-LD", () => {
      const doc = createDoc(`
        <html>
          <head><title>Document Title</title></head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Document Title");
    });

    it("returns empty string when no title source available", () => {
      const doc = createDoc(`<html><head></head><body></body></html>`);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("");
    });

    it("skips empty og:title and falls through", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="og:title" content="  " />
            <title>Fallback Title</title>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Fallback Title");
    });
  });

  describe("author resolution", () => {
    it("prefers article:author OG tag", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="article:author" content="OG Author" />
            <meta name="author" content="Meta Author" />
            <script type="application/ld+json">{"@type":"Article","author":{"name":"JSON-LD Author"}}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.author).toBe("OG Author");
    });

    it("falls back to JSON-LD author.name", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta name="author" content="Meta Author" />
            <script type="application/ld+json">{"@type":"Article","author":{"name":"JSON-LD Author"}}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.author).toBe("JSON-LD Author");
    });

    it("handles JSON-LD author as string", () => {
      const doc = createDoc(`
        <html>
          <head>
            <script type="application/ld+json">{"@type":"Article","author":"String Author"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.author).toBe("String Author");
    });

    it("falls back to meta[name=author]", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta name="author" content="Meta Author" />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.author).toBe("Meta Author");
    });

    it("returns null when no author source available", () => {
      const doc = createDoc(`<html><head></head><body></body></html>`);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.author).toBeNull();
    });
  });

  describe("publicationDate resolution", () => {
    it("prefers article:published_time OG tag", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="article:published_time" content="2024-01-15T10:00:00Z" />
            <meta name="date" content="2024-01-10" />
            <script type="application/ld+json">{"@type":"Article","datePublished":"2024-01-12"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.publicationDate).toBe("2024-01-15T10:00:00Z");
    });

    it("falls back to JSON-LD datePublished", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta name="date" content="2024-01-10" />
            <script type="application/ld+json">{"@type":"Article","datePublished":"2024-01-12"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.publicationDate).toBe("2024-01-12");
    });

    it("falls back to meta[name=date]", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta name="date" content="2024-01-10" />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.publicationDate).toBe("2024-01-10");
    });

    it("falls back to time[datetime] element", () => {
      const doc = createDoc(`
        <html>
          <head></head>
          <body><time datetime="2024-03-20T08:30:00Z">March 20, 2024</time></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.publicationDate).toBe("2024-03-20T08:30:00Z");
    });

    it("returns null when no date source available", () => {
      const doc = createDoc(`<html><head></head><body></body></html>`);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.publicationDate).toBeNull();
    });
  });

  describe("sourceUrl resolution", () => {
    it("prefers og:url", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="og:url" content="https://example.com/canonical-og" />
            <link rel="canonical" href="https://example.com/canonical-link" />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/provided" });
      expect(result.sourceUrl).toBe("https://example.com/canonical-og");
    });

    it("falls back to canonical link", () => {
      const doc = createDoc(`
        <html>
          <head>
            <link rel="canonical" href="https://example.com/canonical-link" />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/provided" });
      expect(result.sourceUrl).toBe("https://example.com/canonical-link");
    });

    it("falls back to provided url", () => {
      const doc = createDoc(`<html><head></head><body></body></html>`);

      const result = extractMetadata({ doc, url: "https://example.com/provided" });
      expect(result.sourceUrl).toBe("https://example.com/provided");
    });
  });

  describe("siteName resolution", () => {
    it("prefers og:site_name", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="og:site_name" content="OG Site" />
            <meta name="application-name" content="App Name" />
            <script type="application/ld+json">{"@type":"Article","publisher":{"name":"Publisher Name"}}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.siteName).toBe("OG Site");
    });

    it("falls back to JSON-LD publisher.name", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta name="application-name" content="App Name" />
            <script type="application/ld+json">{"@type":"Article","publisher":{"name":"Publisher Name"}}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.siteName).toBe("Publisher Name");
    });

    it("handles JSON-LD publisher as string", () => {
      const doc = createDoc(`
        <html>
          <head>
            <script type="application/ld+json">{"@type":"Article","publisher":"String Publisher"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.siteName).toBe("String Publisher");
    });

    it("falls back to meta[name=application-name]", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta name="application-name" content="My App" />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.siteName).toBe("My App");
    });

    it("falls back to hostname from URL", () => {
      const doc = createDoc(`<html><head></head><body></body></html>`);

      const result = extractMetadata({ doc, url: "https://blog.example.com/article" });
      expect(result.siteName).toBe("blog.example.com");
    });

    it("returns empty string for invalid URL hostname fallback", () => {
      const doc = createDoc(`<html><head></head><body></body></html>`);

      const result = extractMetadata({ doc, url: "" });
      expect(result.siteName).toBe("");
    });
  });

  describe("JSON-LD edge cases", () => {
    it("handles invalid JSON in ld+json script", () => {
      const doc = createDoc(`
        <html>
          <head>
            <script type="application/ld+json">{ invalid json }</script>
            <title>Fallback Title</title>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Fallback Title");
    });

    it("handles JSON-LD array format", () => {
      const doc = createDoc(`
        <html>
          <head>
            <script type="application/ld+json">[{"@type":"Article","headline":"Array Article"}]</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Array Article");
    });

    it("handles multiple ld+json scripts, uses first matching", () => {
      const doc = createDoc(`
        <html>
          <head>
            <script type="application/ld+json">{"@type":"Organization","name":"Org"}</script>
            <script type="application/ld+json">{"@type":"Article","headline":"Article Title"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Article Title");
    });

    it("handles JSON-LD with no recognized @type but has headline", () => {
      const doc = createDoc(`
        <html>
          <head>
            <script type="application/ld+json">{"headline":"Untyped Headline"}</script>
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Untyped Headline");
    });
  });

  describe("complete metadata extraction", () => {
    it("extracts all fields from a well-structured page", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="og:title" content="Complete Article" />
            <meta property="og:url" content="https://example.com/complete" />
            <meta property="og:site_name" content="Example Blog" />
            <meta property="article:author" content="Jane Doe" />
            <meta property="article:published_time" content="2024-06-15T12:00:00Z" />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/complete" });
      expect(result).toEqual({
        title: "Complete Article",
        author: "Jane Doe",
        publicationDate: "2024-06-15T12:00:00Z",
        sourceUrl: "https://example.com/complete",
        siteName: "Example Blog",
      });
    });

    it("handles a page with only DOM heuristics", () => {
      const doc = createDoc(`
        <html>
          <head>
            <title>Simple Page</title>
            <link rel="canonical" href="https://example.com/simple" />
          </head>
          <body>
            <time datetime="2024-02-01">Feb 1</time>
          </body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/simple" });
      expect(result.title).toBe("Simple Page");
      expect(result.author).toBeNull();
      expect(result.publicationDate).toBe("2024-02-01");
      expect(result.sourceUrl).toBe("https://example.com/simple");
      expect(result.siteName).toBe("example.com");
    });

    it("trims whitespace from all extracted values", () => {
      const doc = createDoc(`
        <html>
          <head>
            <meta property="og:title" content="  Spaced Title  " />
            <meta property="article:author" content="  Spaced Author  " />
            <meta property="og:site_name" content="  Spaced Site  " />
          </head>
          <body></body>
        </html>
      `);

      const result = extractMetadata({ doc, url: "https://example.com/article" });
      expect(result.title).toBe("Spaced Title");
      expect(result.author).toBe("Spaced Author");
      expect(result.siteName).toBe("Spaced Site");
    });
  });
});
