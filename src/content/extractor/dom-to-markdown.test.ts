import { describe, it, expect } from "vitest";
import { createMarkdownConverter, domToMarkdown } from "./dom-to-markdown";

// ---------------------------------------------------------------------------
// Tests: createMarkdownConverter
// ---------------------------------------------------------------------------

describe("CF-1.2 createMarkdownConverter", () => {
  it("returns a TurndownService instance", () => {
    const converter = createMarkdownConverter();
    expect(converter).toBeDefined();
    expect(typeof converter.turndown).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: domToMarkdown
// ---------------------------------------------------------------------------

describe("CF-1.2 domToMarkdown", () => {
  describe("empty/no-content input", () => {
    it("returns empty string with zero character count for empty string", () => {
      const result = domToMarkdown("");
      expect(result.markdown).toBe("");
      expect(result.bodyCharacterCount).toBe(0);
    });

    it("returns empty string with zero character count for whitespace-only string", () => {
      const result = domToMarkdown("   \n\t  ");
      expect(result.markdown).toBe("");
      expect(result.bodyCharacterCount).toBe(0);
    });

    it("returns empty string with zero character count for empty tags", () => {
      const result = domToMarkdown("<div></div>");
      expect(result.markdown).toBe("");
      expect(result.bodyCharacterCount).toBe(0);
    });
  });

  describe("headings", () => {
    it("converts h1 to # prefix", () => {
      const result = domToMarkdown("<h1>Title</h1>");
      expect(result.markdown).toBe("# Title");
    });

    it("converts h2 to ## prefix", () => {
      const result = domToMarkdown("<h2>Subtitle</h2>");
      expect(result.markdown).toBe("## Subtitle");
    });

    it("converts h3 to ### prefix", () => {
      const result = domToMarkdown("<h3>Section</h3>");
      expect(result.markdown).toBe("### Section");
    });

    it("converts h4 to #### prefix", () => {
      const result = domToMarkdown("<h4>Subsection</h4>");
      expect(result.markdown).toBe("#### Subsection");
    });

    it("converts h5 to ##### prefix", () => {
      const result = domToMarkdown("<h5>Minor</h5>");
      expect(result.markdown).toBe("##### Minor");
    });

    it("converts h6 to ###### prefix", () => {
      const result = domToMarkdown("<h6>Smallest</h6>");
      expect(result.markdown).toBe("###### Smallest");
    });

    it("preserves heading hierarchy in a document", () => {
      const html = `
        <h1>Main Title</h1>
        <p>Intro paragraph.</p>
        <h2>Section One</h2>
        <p>Content here.</p>
        <h3>Subsection</h3>
        <p>More content.</p>
      `;
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("# Main Title");
      expect(result.markdown).toContain("## Section One");
      expect(result.markdown).toContain("### Subsection");
    });

    it("collapses inline whitespace in heading text", () => {
      const result = domToMarkdown("<h1>  Hello   World  </h1>");
      expect(result.markdown).toBe("# Hello World");
    });
  });

  describe("paragraphs and inline content", () => {
    it("converts paragraphs to plain text", () => {
      const result = domToMarkdown("<p>Hello world</p>");
      expect(result.markdown).toBe("Hello world");
    });

    it("separates paragraphs with one blank line", () => {
      const result = domToMarkdown("<p>First paragraph.</p><p>Second paragraph.</p>");
      expect(result.markdown).toBe("First paragraph.\n\nSecond paragraph.");
    });

    it("preserves bold text", () => {
      const result = domToMarkdown("<p>This is <strong>bold</strong> text.</p>");
      expect(result.markdown).toContain("**bold**");
    });

    it("preserves italic text", () => {
      const result = domToMarkdown("<p>This is <em>italic</em> text.</p>");
      expect(result.markdown).toContain("*italic*");
    });

    it("preserves links", () => {
      const result = domToMarkdown('<p>Visit <a href="https://example.com">Example</a></p>');
      expect(result.markdown).toContain("[Example](https://example.com)");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code block from pre>code", () => {
      const html = "<pre><code>const x = 1;</code></pre>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("```");
      expect(result.markdown).toContain("const x = 1;");
    });

    it("annotates language from language-* class on code element", () => {
      const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("```javascript");
      expect(result.markdown).toContain("const x = 1;");
    });

    it("annotates language from language-* class on pre element", () => {
      const html = '<pre class="language-python"><code>print("hello")</code></pre>';
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("```python");
      expect(result.markdown).toContain('print("hello")');
    });

    it("renders code block without language when no language-* class", () => {
      const html = "<pre><code>plain code</code></pre>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("```\n");
      expect(result.markdown).toContain("plain code");
    });

    it("preserves multiline code content", () => {
      const html = "<pre><code class=\"language-ts\">function hello() {\n  return 'world';\n}</code></pre>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("```ts");
      expect(result.markdown).toContain("function hello() {");
      expect(result.markdown).toContain("  return 'world';");
      expect(result.markdown).toContain("}");
    });

    it("renders inline code with backticks", () => {
      const html = "<p>Use the <code>console.log</code> function.</p>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("`console.log`");
    });
  });

  describe("tables (GFM)", () => {
    it("renders a simple table with header, separator, and data rows", () => {
      const html = `
        <table>
          <thead>
            <tr><th>Name</th><th>Age</th></tr>
          </thead>
          <tbody>
            <tr><td>Alice</td><td>30</td></tr>
            <tr><td>Bob</td><td>25</td></tr>
          </tbody>
        </table>
      `;
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("Name");
      expect(result.markdown).toContain("Age");
      expect(result.markdown).toContain("Alice");
      expect(result.markdown).toContain("30");
      expect(result.markdown).toContain("Bob");
      expect(result.markdown).toContain("25");
      // Should have separator row with dashes
      expect(result.markdown).toContain("---");
      // Should have pipe characters
      expect(result.markdown).toContain("|");
    });

    it("renders a table without explicit thead", () => {
      const html = `
        <table>
          <tr><th>Col A</th><th>Col B</th></tr>
          <tr><td>1</td><td>2</td></tr>
        </table>
      `;
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("Col A");
      expect(result.markdown).toContain("|");
    });
  });

  describe("lists", () => {
    it("renders unordered lists", () => {
      const html = "<ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("-   Item one");
      expect(result.markdown).toContain("-   Item two");
      expect(result.markdown).toContain("-   Item three");
    });

    it("renders ordered lists", () => {
      const html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("1.  First");
      expect(result.markdown).toContain("2.  Second");
      expect(result.markdown).toContain("3.  Third");
    });

    it("renders nested lists", () => {
      const html = `
        <ul>
          <li>Parent
            <ul>
              <li>Child</li>
            </ul>
          </li>
        </ul>
      `;
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("Parent");
      expect(result.markdown).toContain("Child");
    });
  });

  describe("images", () => {
    it("renders images with alt text", () => {
      const html = '<img src="https://example.com/img.png" alt="A photo">';
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("![A photo](https://example.com/img.png)");
    });

    it("renders images without alt text", () => {
      const html = '<img src="https://example.com/img.png">';
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("![](https://example.com/img.png)");
    });
  });

  describe("blockquotes", () => {
    it("renders blockquotes with > prefix", () => {
      const html = "<blockquote><p>A wise quote.</p></blockquote>";
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("> A wise quote.");
    });
  });

  describe("transparent wrappers", () => {
    it("treats div as pass-through", () => {
      const html = "<div><p>Content inside div.</p></div>";
      const result = domToMarkdown(html);
      expect(result.markdown).toBe("Content inside div.");
    });

    it("treats section as pass-through", () => {
      const html = "<section><p>Content inside section.</p></section>";
      const result = domToMarkdown(html);
      expect(result.markdown).toBe("Content inside section.");
    });

    it("treats span as pass-through", () => {
      const html = "<p>Hello <span>world</span></p>";
      const result = domToMarkdown(html);
      expect(result.markdown).toBe("Hello world");
    });

    it("handles nested transparent wrappers", () => {
      const html = "<div><section><div><p>Deep content.</p></div></section></div>";
      const result = domToMarkdown(html);
      expect(result.markdown).toBe("Deep content.");
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple blank lines to one", () => {
      const html = "<p>First</p><br><br><br><p>Second</p>";
      const result = domToMarkdown(html);
      // Should not have more than one blank line between blocks
      expect(result.markdown).not.toMatch(/\n{3,}/);
    });

    it("trims leading and trailing whitespace", () => {
      const html = "<p>Content</p>";
      const result = domToMarkdown(html);
      expect(result.markdown).toBe(result.markdown.trim());
    });

    it("collapses inline whitespace to single space in headings", () => {
      const html = "<h2>  Multiple   spaces   here  </h2>";
      const result = domToMarkdown(html);
      expect(result.markdown).toBe("## Multiple spaces here");
    });
  });

  describe("bodyCharacterCount", () => {
    it("returns correct character count for simple content", () => {
      const result = domToMarkdown("<p>Hello</p>");
      expect(result.bodyCharacterCount).toBe(result.markdown.length);
    });

    it("returns zero for empty content", () => {
      const result = domToMarkdown("");
      expect(result.bodyCharacterCount).toBe(0);
    });

    it("counts characters including markdown syntax", () => {
      const result = domToMarkdown("<h1>Title</h1>");
      // "# Title" = 7 characters
      expect(result.bodyCharacterCount).toBe("# Title".length);
    });
  });

  describe("complex documents", () => {
    it("handles a full article with mixed content", () => {
      const html = `
        <article>
          <h1>Article Title</h1>
          <p>Introduction paragraph with <strong>bold</strong> and <em>italic</em>.</p>
          <h2>Code Example</h2>
          <pre><code class="language-javascript">function greet(name) {
  return "Hello, " + name;
}</code></pre>
          <h2>Data Table</h2>
          <table>
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody><tr><td>foo</td><td>bar</td></tr></tbody>
          </table>
          <h2>Summary</h2>
          <ul>
            <li>Point one</li>
            <li>Point two</li>
          </ul>
        </article>
      `;
      const result = domToMarkdown(html);
      expect(result.markdown).toContain("# Article Title");
      expect(result.markdown).toContain("**bold**");
      expect(result.markdown).toContain("*italic*");
      expect(result.markdown).toContain("```javascript");
      expect(result.markdown).toContain("## Code Example");
      expect(result.markdown).toContain("## Data Table");
      expect(result.markdown).toContain("## Summary");
      expect(result.markdown).toContain("-   Point one");
      expect(result.bodyCharacterCount).toBeGreaterThan(0);
    });
  });
});
