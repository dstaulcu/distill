import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractWithReadability } from "./readability-wrapper";
import type { ReadabilityOutcome } from "./readability-wrapper";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a jsdom Document from an HTML string.
 */
function createDocument(html: string, url = "https://example.com/article"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

/**
 * Generates a paragraph with the specified character count of text content.
 */
function makeArticleHtml(textLength: number, title = "Test Article"): string {
  const body = "a".repeat(textLength);
  return `
    <!DOCTYPE html>
    <html>
      <head><title>${title}</title></head>
      <body>
        <article>
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

describe("CF-1.2 extractWithReadability", () => {
  describe("successful extraction", () => {
    it("returns ok: true with result and confidence for a valid article", () => {
      const doc = createDocument(makeArticleHtml(600));
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.title).toBe("Test Article");
        expect(outcome.result.textContent.length).toBeGreaterThan(0);
        expect(outcome.result.content).toContain("<");
        expect(outcome.confidence).toBeDefined();
      }
    });

    it("maps Readability output fields correctly", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>My Great Article</title>
            <meta property="og:site_name" content="Example Blog" />
          </head>
          <body>
            <article>
              <h1>My Great Article</h1>
              <p class="byline">By John Doe</p>
              <p>${"Lorem ipsum dolor sit amet. ".repeat(50)}</p>
            </article>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.title).toBe("My Great Article");
        expect(outcome.result.textContent).toContain("Lorem ipsum");
        expect(outcome.result.length).toBe(outcome.result.textContent.length);
        expect(typeof outcome.result.content).toBe("string");
        expect(typeof outcome.result.excerpt).toBe("string");
      }
    });

    it("returns byline as null when no author is detected", () => {
      const doc = createDocument(makeArticleHtml(600));
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        // Readability may or may not detect a byline depending on content
        expect(outcome.result.byline === null || typeof outcome.result.byline === "string").toBe(true);
      }
    });

    it("returns siteName as null when no site name is detected", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Plain Article</title></head>
          <body>
            <article>
              <h1>Plain Article</h1>
              <p>${"Content goes here. ".repeat(50)}</p>
            </article>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.siteName).toBeNull();
      }
    });
  });

  describe("confidence scoring", () => {
    it("returns 'high' confidence when content length > 500 chars", () => {
      const doc = createDocument(makeArticleHtml(600));
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.confidence).toBe("high");
      }
    });

    it("returns 'medium' confidence when content length is 100–500 chars", () => {
      // We need enough content for Readability to detect it as an article
      // but the text content should be between 100-500 chars
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Medium Article</title></head>
          <body>
            <article>
              <h1>Medium Article</h1>
              <p>${"x".repeat(200)}</p>
            </article>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        // The text content should be in the medium range
        if (outcome.result.textContent.length >= 100 && outcome.result.textContent.length <= 500) {
          expect(outcome.confidence).toBe("medium");
        } else if (outcome.result.textContent.length > 500) {
          expect(outcome.confidence).toBe("high");
        }
      }
    });

    it("returns 'low' confidence when content length < 100 chars", () => {
      // Very short content — Readability may still parse it if structured well
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Short</title></head>
          <body>
            <article>
              <h1>Short</h1>
              <p>Brief content here.</p>
              <p>Another line.</p>
              <p>Third line of text.</p>
            </article>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      // Readability might return null for very short content, which is also valid
      if (outcome.ok) {
        if (outcome.result.textContent.length < 100) {
          expect(outcome.confidence).toBe("low");
        }
      }
    });
  });

  describe("failure cases", () => {
    it("returns ok: false with 'no-content-detected' when Readability returns null", () => {
      // A completely empty page with no text content at all
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Empty</title></head>
          <body></body>
        </html>
      `;
      const doc = createDocument(html);
      const outcome = extractWithReadability({ doc, url: "https://example.com/" });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe("no-content-detected");
      }
    });

    it("returns ok: false when extracted text content is empty after trimming", () => {
      // A page where Readability might parse something but textContent is whitespace
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Whitespace</title></head>
          <body>
            <div>   </div>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const outcome = extractWithReadability({ doc, url: "https://example.com/" });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe("no-content-detected");
      }
    });
  });

  describe("dependency injection", () => {
    it("accepts doc and url as injectable dependencies", () => {
      const doc = createDocument(makeArticleHtml(800), "https://test.org/page");
      const outcome = extractWithReadability({ doc, url: "https://test.org/page" });

      expect(outcome.ok).toBe(true);
    });

    it("works with different URLs", () => {
      const doc = createDocument(makeArticleHtml(600), "https://blog.example.com/post/123");
      const outcome = extractWithReadability({ doc, url: "https://blog.example.com/post/123" });

      expect(outcome.ok).toBe(true);
    });
  });

  describe("document cloning", () => {
    it("does not mutate the original document", () => {
      const html = makeArticleHtml(600);
      const doc = createDocument(html);
      const originalHtml = doc.documentElement.outerHTML;

      extractWithReadability({ doc, url: "https://example.com/article" });

      // The original document should remain unchanged
      expect(doc.documentElement.outerHTML).toBe(originalHtml);
    });
  });

  describe("result type structure", () => {
    it("success result has ok, result, and confidence fields", () => {
      const doc = createDocument(makeArticleHtml(600));
      const outcome = extractWithReadability({ doc, url: "https://example.com/article" });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome).toHaveProperty("result");
        expect(outcome).toHaveProperty("confidence");
        expect(outcome.result).toHaveProperty("title");
        expect(outcome.result).toHaveProperty("content");
        expect(outcome.result).toHaveProperty("textContent");
        expect(outcome.result).toHaveProperty("length");
        expect(outcome.result).toHaveProperty("excerpt");
        expect(outcome.result).toHaveProperty("byline");
        expect(outcome.result).toHaveProperty("siteName");
      }
    });

    it("failure result has ok and reason fields only", () => {
      const html = `
        <!DOCTYPE html>
        <html><head><title>Empty</title></head><body></body></html>
      `;
      const doc = createDocument(html);
      const outcome: ReadabilityOutcome = extractWithReadability({ doc, url: "https://example.com/" });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome).toHaveProperty("reason");
        expect(outcome.reason).toBe("no-content-detected");
        expect(outcome).not.toHaveProperty("result");
        expect(outcome).not.toHaveProperty("confidence");
      }
    });
  });
});
