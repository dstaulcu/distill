import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { extract } from "./extract";
import type { ExtractionResult } from "./extract";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDocument(html: string, url = "https://example.com/article"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

function makeArticleHtml(opts?: {
  textLength?: number;
  title?: string;
  author?: string;
  selector?: string;
}): string {
  const textLength = opts?.textLength ?? 600;
  const title = opts?.title ?? "Test Article";
  const body = "a".repeat(textLength);
  const selectorAttr = opts?.selector ? ` id="${opts.selector}"` : "";

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${title}</title>
        ${opts?.author ? `<meta name="author" content="${opts.author}" />` : ""}
        <meta property="og:title" content="${title}" />
      </head>
      <body>
        <article${selectorAttr}>
          <h1>${title}</h1>
          <p>${body}</p>
        </article>
      </body>
    </html>
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-1 extract", () => {
  describe("without contentSelector (Readability path)", () => {
    it("returns ok: true with article and confidence when Readability succeeds", async () => {
      const doc = createDocument(makeArticleHtml({ textLength: 600 }));
      const result = await extract({ doc, url: "https://example.com/article" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.article.title).toBe("Test Article");
        expect(result.article.bodyMarkdown.length).toBeGreaterThan(0);
        expect(result.article.bodyCharacterCount).toBeGreaterThan(0);
        expect(result.article.sourceUrl).toBe("https://example.com/article");
        expect(result.confidence).toBeDefined();
        expect(["high", "medium", "low"]).toContain(result.confidence);
      }
    });

    it("returns ok: false with 'no-content-detected' when page has no content", async () => {
      const html = `
        <!DOCTYPE html>
        <html><head><title>Empty</title></head><body></body></html>
      `;
      const doc = createDocument(html);
      const result = await extract({ doc, url: "https://example.com/" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-content-detected");
        expect(result.detail).toBeDefined();
        expect(result.detail.length).toBeGreaterThan(0);
      }
    });

    it("extracts metadata including author when available", async () => {
      const doc = createDocument(makeArticleHtml({ textLength: 600, author: "Jane Doe" }));
      const result = await extract({ doc, url: "https://example.com/article" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.article.author).toBe("Jane Doe");
      }
    });

    it("returns null for author when not available", async () => {
      const doc = createDocument(makeArticleHtml({ textLength: 600 }));
      const result = await extract({ doc, url: "https://example.com/article" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.article.author).toBeNull();
      }
    });

    it("converts HTML content to Markdown", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Markdown Test</title></head>
          <body>
            <article>
              <h1>Markdown Test</h1>
              <p>${"Some content here. ".repeat(40)}</p>
              <h2>Subheading</h2>
              <p>${"More content. ".repeat(30)}</p>
            </article>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extract({ doc, url: "https://example.com/article" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.article.bodyMarkdown).toContain("#");
      }
    });
  });

  describe("with contentSelector that matches", () => {
    it("uses the matched element's innerHTML for extraction", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Selector Test</title></head>
          <body>
            <nav>Navigation stuff</nav>
            <div id="main-content">
              <h1>Article Title</h1>
              <p>This is the article body content that should be extracted.</p>
            </div>
            <footer>Footer stuff</footer>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/article",
        contentSelector: "#main-content",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.article.bodyMarkdown).toContain("Article Title");
        expect(result.article.bodyMarkdown).toContain("article body content");
        expect(result.article.bodyMarkdown).not.toContain("Navigation stuff");
        expect(result.article.bodyMarkdown).not.toContain("Footer stuff");
        expect(result.confidence).toBe("high");
      }
    });

    it("returns high confidence when selector matches", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Test</title></head>
          <body>
            <div class="content"><p>Some content here.</p></div>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/article",
        contentSelector: ".content",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.confidence).toBe("high");
        expect(result.stalePattern).toBeUndefined();
      }
    });

    it("does not set stalePattern when selector matches", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Test</title></head>
          <body>
            <div id="article"><p>Content here for extraction.</p></div>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/article",
        contentSelector: "#article",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stalePattern).toBeUndefined();
      }
    });
  });

  describe("with contentSelector that matches nothing (stale pattern)", () => {
    it("falls back to Readability and flags stalePattern: true", async () => {
      const html = makeArticleHtml({ textLength: 600, title: "Fallback Article" });
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/article",
        contentSelector: "#nonexistent-selector",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stalePattern).toBe(true);
        expect(result.article.bodyMarkdown.length).toBeGreaterThan(0);
      }
    });

    it("returns failure when selector misses and Readability also fails", async () => {
      const html = `
        <!DOCTYPE html>
        <html><head><title>Empty</title></head><body></body></html>
      `;
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/",
        contentSelector: "#nonexistent",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-content-detected");
        expect(result.detail).toContain("selector");
      }
    });

    it("uses Readability confidence when falling back", async () => {
      const html = makeArticleHtml({ textLength: 600 });
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/article",
        contentSelector: ".missing-class",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(["high", "medium", "low"]).toContain(result.confidence);
        expect(result.stalePattern).toBe(true);
      }
    });
  });

  describe("contentSelector matches element with no renderable content", () => {
    it("returns failure when matched element has empty content", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Test</title></head>
          <body>
            <div id="empty-content">   </div>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/",
        contentSelector: "#empty-content",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-content-detected");
      }
    });
  });

  describe("error handling", () => {
    it("returns extraction-error when an unexpected error occurs", async () => {
      // Pass a doc that will cause querySelector to throw
      const badDoc = {
        URL: "https://example.com",
        querySelector: () => { throw new Error("DOM access failed"); },
      } as unknown as Document;

      const result = await extract({
        doc: badDoc,
        url: "https://example.com/",
        contentSelector: ".trigger-error",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("extraction-error");
        expect(result.detail).toContain("DOM access failed");
      }
    });

    it("limits detail to 200 characters", async () => {
      const longMessage = "x".repeat(300);
      const badDoc = {
        URL: "https://example.com",
        querySelector: () => { throw new Error(longMessage); },
      } as unknown as Document;

      const result = await extract({
        doc: badDoc,
        url: "https://example.com/",
        contentSelector: ".trigger-error",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail.length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe("dependency injection", () => {
    it("accepts doc and url as injectable dependencies", async () => {
      const doc = createDocument(makeArticleHtml({ textLength: 800 }), "https://test.org/page");
      const result = await extract({ doc, url: "https://test.org/page" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.article.sourceUrl).toBe("https://test.org/page");
      }
    });
  });

  describe("result type structure", () => {
    it("success result has ok, article, and confidence fields", async () => {
      const doc = createDocument(makeArticleHtml({ textLength: 600 }));
      const result = await extract({ doc, url: "https://example.com/article" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result).toHaveProperty("article");
        expect(result).toHaveProperty("confidence");
        expect(result.article).toHaveProperty("title");
        expect(result.article).toHaveProperty("author");
        expect(result.article).toHaveProperty("publicationDate");
        expect(result.article).toHaveProperty("sourceUrl");
        expect(result.article).toHaveProperty("siteName");
        expect(result.article).toHaveProperty("bodyMarkdown");
        expect(result.article).toHaveProperty("bodyCharacterCount");
      }
    });

    it("failure result has ok, reason, and detail fields", async () => {
      const html = `
        <!DOCTYPE html>
        <html><head><title>Empty</title></head><body></body></html>
      `;
      const doc = createDocument(html);
      const result: ExtractionResult = await extract({ doc, url: "https://example.com/" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result).toHaveProperty("reason");
        expect(result).toHaveProperty("detail");
        expect(result).not.toHaveProperty("article");
        expect(result).not.toHaveProperty("confidence");
      }
    });
  });
});
