import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { domToMarkdown } from "./dom-to-markdown";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a heading level 1–6. */
const headingLevel = fc.integer({ min: 1, max: 6 });

/** Generate simple text content (no HTML special chars that would break structure). */
const simpleText = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split("")),
  { minLength: 1, maxLength: 40 },
).map((s) => s.trim() || "text");

/** Generate a valid URL-safe path segment. */
const urlPath = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_".split("")),
  { minLength: 1, maxLength: 20 },
);

/** Generate a programming language name for code blocks. */
const languageName = fc.constantFrom(
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "java",
  "css",
  "html",
  "ruby",
  "c",
);

/** Generate simple code content (no backticks to avoid breaking fences). */
const codeContent = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 =();{}\n".split("")),
  { minLength: 1, maxLength: 60 },
).map((s) => s.trim() || "code");

/** Generate a transparent wrapper tag. */
const wrapperTag = fc.constantFrom("div", "section", "span");

// ---------------------------------------------------------------------------
// Property 8: Markdown converter heading preservation
// Validates: Requirements 4.1, 4.2
// ---------------------------------------------------------------------------

describe("Property 8: Markdown converter heading preservation", () => {
  it("generates correct # prefix for each heading level", () => {
    /**
     * **Validates: Requirements 4.1, 4.2**
     */
    fc.assert(
      fc.property(headingLevel, simpleText, (level, text) => {
        const html = `<h${level}>${text}</h${level}>`;
        const result = domToMarkdown(html);

        const expectedPrefix = "#".repeat(level) + " ";
        expect(result.markdown).toContain(expectedPrefix);
      }),
      { numRuns: 100 },
    );
  });

  it("preserves heading count between input and output", () => {
    /**
     * **Validates: Requirements 4.1, 4.2**
     */
    fc.assert(
      fc.property(
        fc.array(fc.tuple(headingLevel, simpleText), { minLength: 1, maxLength: 6 }),
        (headings) => {
          const html = headings
            .map(([level, text]) => `<h${level}>${text}</h${level}>`)
            .join("<p>paragraph</p>");

          const result = domToMarkdown(html);

          // Count heading lines in output (lines starting with one or more # followed by space)
          const headingLines = result.markdown
            .split("\n")
            .filter((line) => /^#{1,6} .+/.test(line));

          expect(headingLines.length).toBe(headings.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Markdown converter whitespace normalization
// Validates: Requirements 4.5
// ---------------------------------------------------------------------------

describe("Property 9: Markdown converter whitespace normalization", () => {
  it("never produces runs of 3+ consecutive newlines", () => {
    /**
     * **Validates: Requirements 4.5**
     */
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            // Paragraphs with varied internal whitespace
            simpleText.map((t) => `<p>${t}</p>`),
            // Headings
            fc.tuple(headingLevel, simpleText).map(
              ([l, t]) => `<h${l}>${t}</h${l}>`,
            ),
            // Extra whitespace between elements
            fc.constantFrom("<br>", "<br><br>", "\n\n\n", "   \n\t\n   "),
          ),
          { minLength: 2, maxLength: 8 },
        ),
        (elements) => {
          const html = elements.join("");
          const result = domToMarkdown(html);

          // No runs of 3+ newlines (which would mean multiple blank lines)
          expect(result.markdown).not.toMatch(/\n{3,}/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("collapses inline whitespace to single spaces within text content", () => {
    /**
     * **Validates: Requirements 4.5**
     */
    fc.assert(
      fc.property(
        fc.array(simpleText, { minLength: 2, maxLength: 5 }),
        (words) => {
          // Join words with varied whitespace
          const spacedText = words.join("   \t  ");
          const html = `<p>${spacedText}</p>`;
          const result = domToMarkdown(html);

          // The output should not contain runs of multiple spaces
          // (tabs and multiple spaces should be collapsed to single space)
          const lines = result.markdown.split("\n");
          for (const line of lines) {
            // Each line should not have runs of 2+ spaces (except possibly in code)
            if (line.trim().length > 0) {
              expect(line).not.toMatch(/  +/);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Markdown converter element type preservation
// Validates: Requirements 4.3, 4.4, 4.6, 4.7
// ---------------------------------------------------------------------------

describe("Property 10: Markdown converter element type preservation", () => {
  it("renders images as ![alt](src) format", () => {
    /**
     * **Validates: Requirements 4.3**
     */
    fc.assert(
      fc.property(urlPath, simpleText, (path, alt) => {
        const src = `https://example.com/${path}.png`;
        const html = `<img src="${src}" alt="${alt}">`;
        const result = domToMarkdown(html);

        expect(result.markdown).toContain(`![${alt}](${src})`);
      }),
      { numRuns: 100 },
    );
  });

  it("renders code blocks with ``` fencing and language annotation", () => {
    /**
     * **Validates: Requirements 4.4**
     */
    fc.assert(
      fc.property(languageName, codeContent, (lang, code) => {
        const html = `<pre><code class="language-${lang}">${code}</code></pre>`;
        const result = domToMarkdown(html);

        // Should contain opening fence with language
        expect(result.markdown).toContain("```" + lang);
        // Should contain closing fence
        const fenceCount = (result.markdown.match(/```/g) || []).length;
        expect(fenceCount).toBeGreaterThanOrEqual(2);
        // Should contain the code content
        expect(result.markdown).toContain(code);
      }),
      { numRuns: 100 },
    );
  });

  it("renders code blocks with ``` fencing even without language class", () => {
    /**
     * **Validates: Requirements 4.4**
     */
    fc.assert(
      fc.property(codeContent, (code) => {
        const html = `<pre><code>${code}</code></pre>`;
        const result = domToMarkdown(html);

        // Should contain fenced code block markers
        const fenceCount = (result.markdown.match(/```/g) || []).length;
        expect(fenceCount).toBeGreaterThanOrEqual(2);
        // Should contain the code content
        expect(result.markdown).toContain(code);
      }),
      { numRuns: 100 },
    );
  });

  it("does not include wrapper tags (div, section, span) in output", () => {
    /**
     * **Validates: Requirements 4.7**
     */
    fc.assert(
      fc.property(wrapperTag, simpleText, (tag, text) => {
        const html = `<${tag}><p>${text}</p></${tag}>`;
        const result = domToMarkdown(html);

        // Output should not contain the wrapper tag names as HTML tags
        expect(result.markdown).not.toContain(`<${tag}`);
        expect(result.markdown).not.toContain(`</${tag}>`);
        // But should contain the text content
        expect(result.markdown).toContain(text);
      }),
      { numRuns: 100 },
    );
  });

  it("processes nested wrapper elements without introducing artifacts", () => {
    /**
     * **Validates: Requirements 4.7**
     */
    fc.assert(
      fc.property(
        fc.array(wrapperTag, { minLength: 1, maxLength: 3 }),
        simpleText,
        (tags, text) => {
          // Build nested wrappers: <div><section><span><p>text</p></span></section></div>
          let html = `<p>${text}</p>`;
          for (const tag of tags) {
            html = `<${tag}>${html}</${tag}>`;
          }

          const result = domToMarkdown(html);

          // No wrapper tags should appear in output
          for (const tag of tags) {
            expect(result.markdown).not.toContain(`<${tag}`);
            expect(result.markdown).not.toContain(`</${tag}>`);
          }
          // Text content should be preserved
          expect(result.markdown).toContain(text);
        },
      ),
      { numRuns: 100 },
    );
  });
});
