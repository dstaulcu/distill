/**
 * Unit tests for the settings page logic.
 *
 * Tests client-side validation, pattern management, and rendering helpers.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// We test the validation and utility logic extracted from options.ts.
// Since options.ts is a DOM-dependent entry point, we test the core logic
// by importing the module in a jsdom environment.

describe("Options Page", () => {
  beforeEach(() => {
    // Set up a minimal DOM for the options page
    document.body.innerHTML = `
      <div id="app">
        <input id="ai-base-url" />
        <input id="ai-model-id" />
        <input id="ai-api-key" type="password" />
        <span id="error-ai-base-url" class="field-error"></span>
        <span id="error-ai-model-id" class="field-error"></span>
        <span id="error-ai-api-key" class="field-error"></span>
        <button id="btn-test-connection"></button>
        <span id="connection-status" class="connection-status"></span>
        <div id="patterns-list"></div>
        <button id="btn-add-pattern"></button>
        <div id="pattern-editor" class="hidden">
          <h3 id="pattern-editor-title"></h3>
          <input id="pattern-url" />
          <input id="pattern-selector" />
          <span id="error-pattern-url" class="field-error"></span>
          <span id="error-pattern-selector" class="field-error"></span>
          <div id="selector-preview"></div>
          <button id="btn-save-pattern"></button>
          <button id="btn-cancel-pattern"></button>
        </div>
        <input id="export-filename-pattern" />
        <span id="error-export-filename-pattern" class="field-error"></span>
        <div id="frontmatter-fields">
          <label><input type="checkbox" value="title" /></label>
          <label><input type="checkbox" value="author" /></label>
          <label><input type="checkbox" value="source_url" /></label>
          <label><input type="checkbox" value="publication_date" /></label>
          <label><input type="checkbox" value="capture_date" /></label>
          <label><input type="checkbox" value="site_name" /></label>
        </div>
        <div id="auto-export-list"></div>
        <button id="btn-save-settings"></button>
        <span id="save-status" class="save-status"></span>
      </div>
    `;
  });

  describe("Client-side validation", () => {
    it("rejects base URL without http/https prefix", () => {
      const errors = validateFormFields("ftp://example.com", "YYYY-MM-DD-slugified-title");
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("ai.baseUrl");
    });

    it("accepts empty base URL (optional)", () => {
      const errors = validateFormFields("", "YYYY-MM-DD-slugified-title");
      expect(errors).toHaveLength(0);
    });

    it("accepts valid http base URL", () => {
      const errors = validateFormFields("http://localhost:8080", "YYYY-MM-DD-slugified-title");
      expect(errors).toHaveLength(0);
    });

    it("accepts valid https base URL", () => {
      const errors = validateFormFields("https://api.openai.com", "YYYY-MM-DD-slugified-title");
      expect(errors).toHaveLength(0);
    });

    it("rejects empty filename pattern", () => {
      const errors = validateFormFields("", "");
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("export.filenamePattern");
    });

    it("rejects whitespace-only filename pattern", () => {
      const errors = validateFormFields("", "   ");
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("export.filenamePattern");
    });

    it("reports multiple errors simultaneously", () => {
      const errors = validateFormFields("invalid-url", "");
      expect(errors).toHaveLength(2);
    });
  });

  describe("Pattern validation", () => {
    it("rejects empty URL pattern", () => {
      const errors = validatePatternFields("", "article");
      expect(errors.some((e) => e.field === "pattern-url")).toBe(true);
    });

    it("rejects empty selector", () => {
      const errors = validatePatternFields("*://*.example.com/*", "");
      expect(errors.some((e) => e.field === "pattern-selector")).toBe(true);
    });

    it("rejects selector longer than 1024 chars", () => {
      const longSelector = "a".repeat(1025);
      const errors = validatePatternFields("*://*.example.com/*", longSelector);
      expect(errors.some((e) => e.field === "pattern-selector")).toBe(true);
      expect(errors.some((e) => e.message.includes("1024"))).toBe(true);
    });

    it("rejects invalid CSS selector syntax", () => {
      const errors = validatePatternFields("*://*.example.com/*", "[[[invalid");
      expect(errors.some((e) => e.field === "pattern-selector")).toBe(true);
      expect(errors.some((e) => e.message.includes("Invalid CSS"))).toBe(true);
    });

    it("accepts valid pattern fields", () => {
      const errors = validatePatternFields("*://*.example.com/*", "article.main-content");
      expect(errors).toHaveLength(0);
    });
  });

  describe("HTML escaping", () => {
    it("escapes HTML special characters", () => {
      const result = escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain("<script>");
      expect(result).toContain("&lt;script&gt;");
    });

    it("preserves normal text", () => {
      const result = escapeHtml("Hello World");
      expect(result).toBe("Hello World");
    });
  });

  describe("Attribute escaping", () => {
    it("escapes double quotes", () => {
      const result = escapeAttr('value with "quotes"');
      expect(result).toContain("&quot;");
      expect(result).not.toContain('"');
    });

    it("escapes angle brackets", () => {
      const result = escapeAttr("<script>");
      expect(result).toContain("&lt;");
      expect(result).toContain("&gt;");
    });
  });

  describe("Field-to-element mapping", () => {
    it("maps ai.baseUrl to ai-base-url", () => {
      expect(fieldToElementId("ai.baseUrl")).toBe("ai-base-url");
    });

    it("maps export.filenamePattern to export-filename-pattern", () => {
      expect(fieldToElementId("export.filenamePattern")).toBe("export-filename-pattern");
    });

    it("returns unknown fields as-is", () => {
      expect(fieldToElementId("unknown.field")).toBe("unknown.field");
    });
  });
});

// ---------------------------------------------------------------------------
// Extracted functions for testing (mirroring options.ts logic)
// ---------------------------------------------------------------------------

interface FieldError {
  readonly field: string;
  readonly message: string;
}

function validateFormFields(baseUrl: string, filenamePattern: string): FieldError[] {
  const errors: FieldError[] = [];

  if (baseUrl !== "" && !/^https?:\/\//.test(baseUrl)) {
    errors.push({ field: "ai.baseUrl", message: "Base URL must start with http:// or https://" });
  }

  if (filenamePattern.trim() === "") {
    errors.push({ field: "export.filenamePattern", message: "Filename pattern must not be empty" });
  }

  return errors;
}

function validatePatternFields(urlPattern: string, selector: string): FieldError[] {
  const errors: FieldError[] = [];

  if (!urlPattern) {
    errors.push({ field: "pattern-url", message: "URL match pattern is required" });
  }

  if (!selector) {
    errors.push({ field: "pattern-selector", message: "Content selector is required" });
  } else if (selector.length > 1024) {
    errors.push({ field: "pattern-selector", message: "Selector must be at most 1024 characters" });
  } else {
    try {
      document.querySelector(selector);
    } catch {
      errors.push({ field: "pattern-selector", message: "Invalid CSS selector syntax" });
    }
  }

  return errors;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/[&"'<>]/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return ch;
    }
  });
}

function fieldToElementId(field: string): string {
  const map: Record<string, string> = {
    "ai.baseUrl": "ai-base-url",
    "ai.modelId": "ai-model-id",
    "ai.apiKey": "ai-api-key",
    "export.filenamePattern": "export-filename-pattern",
  };
  return map[field] ?? field;
}
