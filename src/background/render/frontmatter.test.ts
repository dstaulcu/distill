import { describe, it, expect } from "vitest";
import {
  renderFrontmatter,
  needsQuoting,
  quoteValue,
  formatYamlValue,
} from "./frontmatter";
import type { FrontmatterInput } from "./frontmatter";
import type { ExtractedArticle } from "@shared/types";

function makeArticle(overrides: Partial<ExtractedArticle> = {}): ExtractedArticle {
  return {
    title: "Test Article",
    author: "Jane Doe",
    sourceUrl: "https://example.com/article",
    publicationDate: "2024-01-15",
    siteName: "Example Site",
    bodyMarkdown: "Some content",
    bodyCharacterCount: 12,
    ...overrides,
  };
}

function makeInput(overrides: Partial<FrontmatterInput> = {}): FrontmatterInput {
  return {
    article: makeArticle(),
    captureDate: "2024-03-01",
    fields: ["title", "author", "source_url", "publication_date", "capture_date", "site_name"],
    ...overrides,
  };
}

describe("CF-4.2 renderFrontmatter", () => {
  describe("basic rendering", () => {
    it("renders all fields in specified order with YAML delimiters", () => {
      const result = renderFrontmatter(makeInput());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const lines = result.yaml.split("\n");
      expect(lines[0]).toBe("---");
      expect(lines[1]).toBe("title: Test Article");
      expect(lines[2]).toBe("author: Jane Doe");
      expect(lines[3]).toBe('source_url: "https://example.com/article"');
      expect(lines[4]).toBe("publication_date: 2024-01-15");
      expect(lines[5]).toBe("capture_date: 2024-03-01");
      expect(lines[6]).toBe("site_name: Example Site");
      expect(lines[7]).toBe("---");
      expect(lines[8]).toBe(""); // trailing newline
    });

    it("respects field order from input.fields", () => {
      const result = renderFrontmatter(
        makeInput({ fields: ["site_name", "title", "author"] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const lines = result.yaml.split("\n");
      expect(lines[1]).toBe("site_name: Example Site");
      expect(lines[2]).toBe("title: Test Article");
      expect(lines[3]).toBe("author: Jane Doe");
    });

    it("renders only requested fields", () => {
      const result = renderFrontmatter(makeInput({ fields: ["title", "capture_date"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toBe("---\ntitle: Test Article\ncapture_date: 2024-03-01\n---\n");
    });
  });

  describe("field omission", () => {
    it("omits fields with null values", () => {
      const article = makeArticle({ author: null, publicationDate: null });
      const result = renderFrontmatter(makeInput({ article }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).not.toContain("author:");
      expect(result.yaml).not.toContain("publication_date:");
    });

    it("omits fields with empty string values", () => {
      const article = makeArticle({ title: "", siteName: "" });
      const result = renderFrontmatter(
        makeInput({ article, fields: ["title", "site_name"] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toBe("---\n---\n");
    });

    it("skips unknown field names silently", () => {
      const result = renderFrontmatter(
        makeInput({ fields: ["title", "unknown_field", "author"] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).not.toContain("unknown_field");
      expect(result.yaml).toContain("title: Test Article");
      expect(result.yaml).toContain("author: Jane Doe");
    });
  });

  describe("YAML quoting", () => {
    it("double-quotes values containing a colon", () => {
      const article = makeArticle({ title: "Part 1: Introduction" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('title: "Part 1: Introduction"');
    });

    it("double-quotes values containing a hash", () => {
      const article = makeArticle({ title: "Issue #42" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('title: "Issue #42"');
    });

    it("double-quotes values containing single quotes", () => {
      const article = makeArticle({ title: "It's a test" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain(`title: "It's a test"`);
    });

    it("double-quotes and escapes values containing double quotes", () => {
      const article = makeArticle({ title: 'She said "hello"' });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('title: "She said \\"hello\\""');
    });

    it("double-quotes and escapes values containing newlines", () => {
      const article = makeArticle({ title: "Line 1\nLine 2" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('title: "Line 1\\nLine 2"');
    });

    it("double-quotes values with leading whitespace", () => {
      const article = makeArticle({ title: "  leading spaces" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('title: "  leading spaces"');
    });

    it("double-quotes values with trailing whitespace", () => {
      const article = makeArticle({ title: "trailing spaces  " });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('title: "trailing spaces  "');
    });

    it("does not quote simple safe values", () => {
      const article = makeArticle({ title: "Simple Title" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain("title: Simple Title");
      expect(result.yaml).not.toContain('"Simple Title"');
    });

    it("does not quote URLs without special characters needing quoting", () => {
      // URLs contain colons, so they should be quoted
      const article = makeArticle({ sourceUrl: "https://example.com/page" });
      const result = renderFrontmatter(makeInput({ article, fields: ["source_url"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain('source_url: "https://example.com/page"');
    });
  });

  describe("error cases", () => {
    it("returns failure when fields array is empty", () => {
      const result = renderFrontmatter(makeInput({ fields: [] }));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("frontmatter-invalid");
      expect(result.detail).toContain("No fields specified");
    });
  });

  describe("edge cases", () => {
    it("produces valid output when all fields are omitted due to null/empty values", () => {
      const article = makeArticle({
        title: "",
        author: null,
        sourceUrl: "",
        publicationDate: null,
        siteName: "",
      });
      const result = renderFrontmatter(
        makeInput({ article, captureDate: "", fields: ["title", "author", "source_url"] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toBe("---\n---\n");
    });

    it("handles captureDate field correctly", () => {
      const result = renderFrontmatter(
        makeInput({ captureDate: "2024-12-25T10:30:00Z", fields: ["capture_date"] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Contains colon, so should be quoted
      expect(result.yaml).toContain('capture_date: "2024-12-25T10:30:00Z"');
    });

    it("handles captureDate without special characters", () => {
      const result = renderFrontmatter(
        makeInput({ captureDate: "2024-12-25", fields: ["capture_date"] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.yaml).toContain("capture_date: 2024-12-25");
    });

    it("handles values with multiple special characters", () => {
      const article = makeArticle({ title: "Q&A: What's \"new\"?\nMore info" });
      const result = renderFrontmatter(makeInput({ article, fields: ["title"] }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // JSON.stringify handles all escaping
      const expected = JSON.stringify("Q&A: What's \"new\"?\nMore info");
      expect(result.yaml).toContain(`title: ${expected}`);
    });
  });
});

describe("needsQuoting", () => {
  it("returns true for empty string", () => {
    expect(needsQuoting("")).toBe(true);
  });

  it("returns true for strings with colon", () => {
    expect(needsQuoting("key: value")).toBe(true);
  });

  it("returns true for strings with hash", () => {
    expect(needsQuoting("issue #1")).toBe(true);
  });

  it("returns true for strings with single quote", () => {
    expect(needsQuoting("it's")).toBe(true);
  });

  it("returns true for strings with double quote", () => {
    expect(needsQuoting('say "hi"')).toBe(true);
  });

  it("returns true for strings with newline", () => {
    expect(needsQuoting("line1\nline2")).toBe(true);
  });

  it("returns true for strings with leading whitespace", () => {
    expect(needsQuoting(" leading")).toBe(true);
  });

  it("returns true for strings with trailing whitespace", () => {
    expect(needsQuoting("trailing ")).toBe(true);
  });

  it("returns false for simple safe strings", () => {
    expect(needsQuoting("hello world")).toBe(false);
  });

  it("returns false for alphanumeric strings", () => {
    expect(needsQuoting("abc123")).toBe(false);
  });
});

describe("quoteValue", () => {
  it("wraps value in double quotes", () => {
    expect(quoteValue("hello")).toBe('"hello"');
  });

  it("escapes internal double quotes", () => {
    expect(quoteValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes newlines", () => {
    expect(quoteValue("a\nb")).toBe('"a\\nb"');
  });

  it("escapes backslashes", () => {
    expect(quoteValue("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes tabs", () => {
    expect(quoteValue("a\tb")).toBe('"a\\tb"');
  });
});

describe("formatYamlValue", () => {
  it("returns unquoted value for safe strings", () => {
    expect(formatYamlValue("simple")).toBe("simple");
  });

  it("returns quoted value for strings needing quoting", () => {
    expect(formatYamlValue("has: colon")).toBe('"has: colon"');
  });

  it("returns quoted empty string", () => {
    expect(formatYamlValue("")).toBe('""');
  });
});
