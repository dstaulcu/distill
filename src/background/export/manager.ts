/**
 * Export Manager — assembles unified Markdown documents and dispatches
 * to configured destinations (download, clipboard).
 *
 * Requirements: 5.1, 5.3, 5.4, 5.5, 5.8, 5.9, 5.10, 5.11, 5.13, 5.14
 */

import type { ExportDestination, Settings, Conversation, ExtractedArticle } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import { renderFrontmatter } from "@background/render/frontmatter";
import { generateFilename } from "@background/render/filename";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportManager {
  export(req: ExportRequest): Promise<ExportResult>;
}

export interface ExportRequest {
  readonly tabId: number;
  readonly includeSummary?: boolean;
  readonly includeQA: boolean;
  readonly destinations: ReadonlyArray<ExportDestination>;
}

export type ExportResult =
  | { readonly ok: true; readonly filename: string; readonly outcomes: ReadonlyArray<DestinationOutcome> }
  | { readonly ok: false; readonly reason: "filename-invalid" | "frontmatter-invalid" | "extraction-failed"; readonly detail: string };

export type DestinationOutcome =
  | { readonly destination: ExportDestination; readonly ok: true }
  | { readonly destination: ExportDestination; readonly ok: false; readonly reason: string; readonly detail: string };

export interface DownloadInput {
  readonly filename: string;
  readonly content: string;
}

export type DownloadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export type ClipboardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface CreateExportManagerOptions {
  readonly extractContent: (tabId: number) => Promise<ExtractionResult>;
  readonly getSettings: () => Promise<Settings>;
  readonly getConversation: (tabId: number) => Conversation | null;
  readonly deliverToDownload?: (input: DownloadInput) => Promise<DownloadResult>;
  readonly deliverToClipboard?: (content: string) => Promise<ClipboardResult>;
  readonly getCaptureDate?: () => Date;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExportManager(opts: CreateExportManagerOptions): ExportManager {
  const {
    extractContent,
    getSettings,
    getConversation,
    deliverToDownload = defaultDeliverToDownload,
    deliverToClipboard = defaultDeliverToClipboard,
    getCaptureDate = () => new Date(),
  } = opts;

  return {
    async export(req: ExportRequest): Promise<ExportResult> {
      // 1. Extract content from the tab
      const extractionResult = await extractContent(req.tabId);
      if (!extractionResult.ok) {
        return {
          ok: false,
          reason: "extraction-failed",
          detail: extractionResult.detail,
        };
      }

      const { article } = extractionResult;
      const settings = await getSettings();
      const captureDate = getCaptureDate();

      // 2. Generate frontmatter
      const frontmatterResult = renderFrontmatter({
        article,
        captureDate: captureDate.toISOString(),
        fields: settings.export.frontmatterFields as string[],
      });

      if (!frontmatterResult.ok) {
        return {
          ok: false,
          reason: "frontmatter-invalid",
          detail: frontmatterResult.detail,
        };
      }

      // 3. Generate filename
      const filenameResult = generateFilename({
        pattern: settings.export.filenamePattern,
        title: article.title,
        date: captureDate,
      });

      if (!filenameResult.ok) {
        return {
          ok: false,
          reason: "filename-invalid",
          detail: filenameResult.detail,
        };
      }

      // 4. Assemble the document
      const includeSummary = req.includeSummary !== false;
      const markdown = assembleDocument({
        frontmatter: frontmatterResult.yaml,
        summary: includeSummary ? getSummary(req.tabId, getConversation) : null,
        qaMessages: req.includeQA ? getQAMessages(req.tabId, getConversation) : null,
        content: article.bodyMarkdown,
      });

      // 5. Dispatch to each destination independently
      const outcomes = await dispatchToDestinations({
        destinations: req.destinations,
        filename: filenameResult.filename,
        content: markdown,
        deliverToDownload,
        deliverToClipboard,
      });

      return {
        ok: true,
        filename: filenameResult.filename,
        outcomes,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Document Assembly
// ---------------------------------------------------------------------------

interface AssembleDocumentInput {
  readonly frontmatter: string;
  readonly summary: string | null;
  readonly qaMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> | null;
  readonly content: string;
}

function assembleDocument(input: AssembleDocumentInput): string {
  const parts: string[] = [];

  // Frontmatter (already includes --- delimiters and trailing newline)
  parts.push(input.frontmatter);

  // Summary section (if available)
  if (input.summary) {
    parts.push(`\n## Summary\n\n${input.summary}\n`);
  }

  // Q&A section (if included and has messages)
  if (input.qaMessages && input.qaMessages.length > 0) {
    const qaLines: string[] = ["\n## Q&A\n"];
    for (const msg of input.qaMessages) {
      if (msg.role === "user") {
        qaLines.push(`\n### Q:\n\n${msg.content}\n`);
      } else {
        qaLines.push(`\n### A:\n\n${msg.content}\n`);
      }
    }
    parts.push(qaLines.join(""));
  }

  // Content section (always present)
  parts.push(`\n## Content\n\n${input.content}\n`);

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the summary from the conversation (first assistant message).
 */
function getSummary(
  tabId: number,
  getConversation: (tabId: number) => Conversation | null,
): string | null {
  const conversation = getConversation(tabId);
  if (!conversation || conversation.messages.length === 0) {
    return null;
  }

  // The summary is the first assistant message in the conversation
  const firstAssistant = conversation.messages.find((m) => m.role === "assistant");
  return firstAssistant?.content ?? null;
}

/**
 * Extracts Q&A messages from the conversation (all messages after the first assistant message).
 */
function getQAMessages(
  tabId: number,
  getConversation: (tabId: number) => Conversation | null,
): ReadonlyArray<{ role: "user" | "assistant"; content: string }> | null {
  const conversation = getConversation(tabId);
  if (!conversation || conversation.messages.length <= 1) {
    return null;
  }

  // Find the index of the first assistant message (the summary)
  const summaryIndex = conversation.messages.findIndex((m) => m.role === "assistant");
  if (summaryIndex === -1) {
    return null;
  }

  // Q&A messages are everything after the summary
  const qaMessages = conversation.messages.slice(summaryIndex + 1);
  if (qaMessages.length === 0) {
    return null;
  }

  return qaMessages.map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// Destination Dispatch
// ---------------------------------------------------------------------------

interface DispatchInput {
  readonly destinations: ReadonlyArray<ExportDestination>;
  readonly filename: string;
  readonly content: string;
  readonly deliverToDownload: (input: DownloadInput) => Promise<DownloadResult>;
  readonly deliverToClipboard: (content: string) => Promise<ClipboardResult>;
}

async function dispatchToDestinations(input: DispatchInput): Promise<ReadonlyArray<DestinationOutcome>> {
  const { destinations, filename, content, deliverToDownload, deliverToClipboard } = input;

  const outcomes = await Promise.all(
    destinations.map(async (destination): Promise<DestinationOutcome> => {
      if (destination.kind === "download") {
        const result = await deliverToDownload({ filename, content });
        if (result.ok) {
          return { destination, ok: true };
        }
        return { destination, ok: false, reason: result.reason, detail: result.detail };
      }

      if (destination.kind === "clipboard") {
        const result = await deliverToClipboard(content);
        if (result.ok) {
          return { destination, ok: true };
        }
        return { destination, ok: false, reason: result.reason, detail: result.detail };
      }

      // Unknown destination kind — should not happen with typed system
      return {
        destination,
        ok: false,
        reason: "unknown-destination",
        detail: `Unknown destination kind: ${(destination as { kind: string }).kind}`,
      };
    }),
  );

  return outcomes;
}

// ---------------------------------------------------------------------------
// Default Delivery Implementations
// ---------------------------------------------------------------------------

async function defaultDeliverToDownload(input: DownloadInput): Promise<DownloadResult> {
  try {
    const blob = new Blob([input.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    try {
      await browser.downloads.download({ url, filename: input.filename, saveAs: false });
      // Revoke after a delay to ensure the download has started
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { ok: true };
    } catch (err) {
      URL.revokeObjectURL(url);
      return {
        ok: false,
        reason: "download-failed",
        detail: err instanceof Error ? err.message : "Download failed",
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "download-failed",
      detail: err instanceof Error ? err.message : "Download failed",
    };
  }
}

async function defaultDeliverToClipboard(_content: string): Promise<ClipboardResult> {
  // Clipboard delivery is handled via sidebar message in production.
  // This default is a no-op placeholder; the real implementation is injected.
  return {
    ok: false,
    reason: "clipboard-not-configured",
    detail: "Clipboard delivery requires sidebar context",
  };
}
