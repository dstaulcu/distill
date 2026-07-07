/**
 * Tests for the sidebar markdown renderer.
 *
 * CF-3.5: chat content rendered to HTML is sanitized — HTML special
 * characters including quotes are escaped, and links render only with
 * http:/https: schemes. javascript: URLs and attribute injection must
 * not survive rendering.
 */

import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("CF-3.5 markdown sanitization", () => {
  it("escapes angle brackets so raw HTML never executes", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes double quotes so attribute injection is impossible", () => {
    const html = renderMarkdown('He said "hello" loudly');
    expect(html).not.toContain('said "hello"');
    expect(html).toContain("&quot;hello&quot;");
  });

  it("blocks javascript: URLs in links", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    // The link syntax stays as inert text — no anchor, no href
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("blocks data: URLs in links", () => {
    const html = renderMarkdown("[click](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain("<a ");
  });

  it("blocks attribute breakout via quotes inside a link URL", () => {
    const html = renderMarkdown('[x](https://a.example/" onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert(1)"');
    // The quote must arrive escaped if it appears anywhere
    expect(html).not.toMatch(/href="[^"]*" onmouseover=/);
  });

  it("renders normal http and https links", () => {
    const http = renderMarkdown("[site](http://example.com/page)");
    const https = renderMarkdown("[site](https://example.com/page)");
    expect(http).toContain('<a href="http://example.com/page"');
    expect(https).toContain('<a href="https://example.com/page"');
    expect(https).toContain('rel="noopener"');
  });
});

describe("markdown rendering basics", () => {
  it("renders bold and italic", () => {
    expect(renderMarkdown("**bold** and *italic*")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("**bold** and *italic*")).toContain("<em>italic</em>");
  });

  it("renders headings", () => {
    expect(renderMarkdown("## Key Points")).toContain("<h3>Key Points</h3>");
  });

  it("renders bullet lists", () => {
    const html = renderMarkdown("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("renders inline code and code blocks", () => {
    expect(renderMarkdown("use `foo()`")).toContain("<code>foo()</code>");
    const block = renderMarkdown("```js\nconst a = 1;\n```");
    expect(block).toContain("<pre><code");
    expect(block).toContain("const a = 1;");
  });

  it("splits paragraphs on blank lines", () => {
    const html = renderMarkdown("first\n\nsecond");
    expect(html).toContain("<p>first</p>");
    expect(html).toContain("<p>second</p>");
  });

  it("merges list items separated by blank lines into a single list", () => {
    // LLM output commonly puts a blank line between bullets.
    const html = renderMarkdown("- one\n\n- two\n\n- three");
    expect(html.match(/<ul>/g)?.length).toBe(1);
    expect(html.match(/<\/ul>/g)?.length).toBe(1);
    expect(html).not.toContain("<br>");
  });
});
