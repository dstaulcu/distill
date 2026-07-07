import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownOutput {
  readonly markdown: string;
  readonly bodyCharacterCount: number;
}

// ---------------------------------------------------------------------------
// Converter factory
// ---------------------------------------------------------------------------

/**
 * Creates a configured TurndownService instance with:
 * - Fenced code block rule (language annotation from `language-*` class)
 * - GFM tables plugin
 * - Heading rule mapping h1–h6 to # through ######
 * - Whitespace normalization
 * - Transparent wrapper handling (div, section, span pass-through)
 */
export function createMarkdownConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    blankReplacement: (_content: string, _node: Node) => "\n\n",
  });

  // GFM tables plugin
  service.use(tables);

  // Custom fenced code block rule with language annotation
  service.addRule("fencedCodeBlock", {
    filter: (node: HTMLElement) => {
      return (
        node.nodeName === "PRE" &&
        node.querySelector("code") !== null
      );
    },
    replacement: (_content: string, node: HTMLElement) => {
      const codeEl = node.querySelector("code") as HTMLElement;
      const language = extractLanguage(codeEl) || extractLanguage(node);
      const code = codeEl.textContent || "";
      // Remove trailing newline from code content if present
      const trimmedCode = code.replace(/\n$/, "");
      return `\n\n\`\`\`${language}\n${trimmedCode}\n\`\`\`\n\n`;
    },
  });

  // Handle standalone <code> not inside <pre> — inline code
  service.addRule("inlineCode", {
    filter: (node: HTMLElement) => {
      return (
        node.nodeName === "CODE" &&
        node.parentElement !== null &&
        node.parentElement.nodeName !== "PRE"
      );
    },
    replacement: (_content: string, node: HTMLElement) => {
      const code = node.textContent || "";
      if (code.includes("`")) {
        return "`` " + code + " ``";
      }
      return "`" + code + "`";
    },
  });

  // Heading rule: h1–h6 → # through ######
  service.addRule("headings", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content: string, node: HTMLElement) => {
      const level = parseInt(node.nodeName.charAt(1), 10);
      const prefix = "#".repeat(level);
      const trimmed = content.trim().replace(/\s+/g, " ");
      return `\n\n${prefix} ${trimmed}\n\n`;
    },
  });

  // Transparent wrapper handling: div, section, span pass-through
  service.addRule("transparentWrappers", {
    filter: ["div", "section", "span"],
    replacement: (content: string) => {
      return content;
    },
  });

  return service;
}

// ---------------------------------------------------------------------------
// Language extraction helper
// ---------------------------------------------------------------------------

/**
 * Extracts language from a `language-*` class on an element.
 */
function extractLanguage(el: HTMLElement): string {
  if (!el || !el.className) return "";
  const classes = el.className.split(/\s+/);
  for (const cls of classes) {
    if (cls.startsWith("language-")) {
      return cls.slice("language-".length);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Main conversion function
// ---------------------------------------------------------------------------

/**
 * Converts an HTML string or Element to Markdown using the configured converter.
 * Returns a MarkdownOutput with the markdown string and body character count.
 */
export function domToMarkdown(html: string | Element): MarkdownOutput {
  if (html === "" || html === null || html === undefined) {
    return { markdown: "", bodyCharacterCount: 0 };
  }

  if (typeof html === "string" && html.trim() === "") {
    return { markdown: "", bodyCharacterCount: 0 };
  }

  const converter = createMarkdownConverter();

  let rawMarkdown: string;
  if (typeof html === "string") {
    rawMarkdown = converter.turndown(html);
  } else {
    rawMarkdown = converter.turndown(html as unknown as HTMLElement);
  }

  // Normalize whitespace:
  // - Collapse runs of blank lines to a single blank line
  // - Trim leading/trailing whitespace
  const markdown = normalizeWhitespace(rawMarkdown);

  if (markdown === "") {
    return { markdown: "", bodyCharacterCount: 0 };
  }

  return {
    markdown,
    bodyCharacterCount: markdown.length,
  };
}

// ---------------------------------------------------------------------------
// Whitespace normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes whitespace in the markdown output:
 * - Collapses multiple blank lines to a single blank line
 * - Trims leading/trailing whitespace from the document
 */
function normalizeWhitespace(md: string): string {
  // Collapse 3+ newlines to exactly 2 (one blank line between blocks)
  let result = md.replace(/\n{3,}/g, "\n\n");
  // Trim leading/trailing whitespace
  result = result.trim();
  return result;
}
