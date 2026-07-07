import { extractWithReadability } from "./readability-wrapper";
import { domToMarkdown } from "./dom-to-markdown";
import { extractMetadata } from "./metadata";
import type { ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  readonly contentSelector?: string;
  readonly doc?: Document;
  readonly url?: string;
}

export type ExtractionResult =
  | { readonly ok: true; readonly article: ExtractedArticle; readonly confidence: "high" | "medium" | "low"; readonly stalePattern?: boolean }
  | { readonly ok: false; readonly reason: "no-content-detected" | "extraction-error"; readonly detail: string };

// ---------------------------------------------------------------------------
// Main extraction orchestrator
// ---------------------------------------------------------------------------

/**
 * Top-level content extraction orchestrator.
 *
 * 1. If `contentSelector` is provided, querySelector on the doc.
 *    - If it matches, use innerHTML as the extraction source.
 *    - If it matches nothing, fall back to Readability and flag pattern as stale.
 * 2. If no `contentSelector`, run extractWithReadability directly.
 * 3. Convert the HTML content to Markdown via domToMarkdown.
 * 4. Extract metadata via extractMetadata.
 * 5. Assemble the ExtractedArticle from metadata + markdown output.
 * 6. Return success with confidence, or failure with reason.
 */
export async function extract(opts?: ExtractOptions): Promise<ExtractionResult> {
  const doc = opts?.doc ?? document;
  const url = opts?.url ?? doc.URL ?? "";
  const contentSelector = opts?.contentSelector;

  try {
    // --- Path A: contentSelector provided ---
    if (contentSelector) {
      const selectedElement = doc.querySelector(contentSelector);

      if (selectedElement) {
        // Run Readability on a scoped document containing only the selected element.
        // This strips boilerplate (engagement widgets, nav chrome) within the selection.
        const scopedDoc = createScopedDocument(selectedElement, url);
        const readabilityResult = extractWithReadability({ doc: scopedDoc, url });

        let markdownOutput: ReturnType<typeof domToMarkdown>;
        if (readabilityResult.ok && readabilityResult.result.textContent.trim().length >= 100) {
          markdownOutput = domToMarkdown(readabilityResult.result.content);
        } else {
          // Readability stripped too much — fall back to raw innerHTML
          markdownOutput = domToMarkdown(selectedElement.innerHTML);
        }

        if (markdownOutput.markdown === "") {
          return {
            ok: false,
            reason: "no-content-detected",
            detail: "Content selector matched an element but it contained no renderable content",
          };
        }

        const metadata = extractMetadata({ doc, url });

        const article: ExtractedArticle = {
          title: metadata.title,
          author: metadata.author,
          publicationDate: metadata.publicationDate,
          sourceUrl: metadata.sourceUrl,
          siteName: metadata.siteName,
          bodyMarkdown: markdownOutput.markdown,
          bodyCharacterCount: markdownOutput.bodyCharacterCount,
        };

        return { ok: true, article, confidence: "high" };
      }

      // Selector matched nothing — fall back to Readability, flag stale
      const readabilityOutcome = extractWithReadability({ doc, url });

      if (!readabilityOutcome.ok) {
        return {
          ok: false,
          reason: "no-content-detected",
          detail: "Saved selector matched no elements and Readability detected no content",
        };
      }

      const markdownOutput = domToMarkdown(readabilityOutcome.result.content);
      const metadata = extractMetadata({ doc, url });

      const article: ExtractedArticle = {
        title: metadata.title,
        author: metadata.author,
        publicationDate: metadata.publicationDate,
        sourceUrl: metadata.sourceUrl,
        siteName: metadata.siteName,
        bodyMarkdown: markdownOutput.markdown,
        bodyCharacterCount: markdownOutput.bodyCharacterCount,
      };

      return { ok: true, article, confidence: readabilityOutcome.confidence, stalePattern: true };
    }

    // --- Path B: no contentSelector — use Readability directly ---
    const readabilityOutcome = extractWithReadability({ doc, url });

    if (!readabilityOutcome.ok) {
      return {
        ok: false,
        reason: "no-content-detected",
        detail: "Readability detected no suitable content on the page",
      };
    }

    const markdownOutput = domToMarkdown(readabilityOutcome.result.content);
    const metadata = extractMetadata({ doc, url });

    const article: ExtractedArticle = {
      title: metadata.title,
      author: metadata.author,
      publicationDate: metadata.publicationDate,
      sourceUrl: metadata.sourceUrl,
      siteName: metadata.siteName,
      bodyMarkdown: markdownOutput.markdown,
      bodyCharacterCount: markdownOutput.bodyCharacterCount,
    };

    return { ok: true, article, confidence: readabilityOutcome.confidence };
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.slice(0, 200)
      : "An unexpected error occurred during extraction";

    return {
      ok: false,
      reason: "extraction-error",
      detail,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal HTML document containing only the given element's content,
 * suitable for running Readability on a scoped selection.
 */
function createScopedDocument(element: Element, url: string): Document {
  const html = `<!DOCTYPE html><html><head><base href="${url}"></head><body>${element.innerHTML}</body></html>`;
  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html");
}
