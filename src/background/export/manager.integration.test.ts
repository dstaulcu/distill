/**
 * Integration tests for the Export Pipeline.
 *
 * Tests the full export assembly end-to-end with mocked destinations
 * (download + clipboard), verifying document structure and per-destination outcomes.
 *
 * Validates: Requirements 5.1, 5.8, 5.9, 5.10
 */

import { describe, it, expect, vi } from "vitest";
import { createExportManager } from "./manager";
import type {
  CreateExportManagerOptions,
  DownloadInput,
  DownloadResult,
  ClipboardResult,
} from "./manager";
import type { ExtractionResult } from "@content/extractor/extract";
import type { Settings, Conversation, ConversationMessage, ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

function makeArticle(overrides?: Partial<ExtractedArticle>): ExtractedArticle {
  return {
    title: "Understanding Web Performance",
    author: "Jane Smith",
    publicationDate: "2024-03-10",
    sourceUrl: "https://blog.example.com/web-performance",
    siteName: "Example Blog",
    bodyMarkdown:
      "# Introduction\n\nWeb performance is critical for user experience.\n\n## Key Metrics\n\n- LCP\n- FID\n- CLS",
    bodyCharacterCount: 95,
    ...overrides,
  };
}

function makeSettings(overrides?: Partial<Settings["export"]>): Settings {
  return {
    schemaVersion: 1,
    ai: {
      baseUrl: "https://api.openai.com",
      modelId: "gpt-4",
      apiKeyRef: "ref-123",
      systemPrompt: "Summarize this article.",
    },
    export: {
      filenamePattern: "YYYY-MM-DD-slugified-title",
      defaultDestination: { kind: "download" },
      frontmatterFields: ["title", "author", "source_url", "publication_date", "capture_date", "site_name"],
      ...overrides,
    },
    sitePatterns: [],
    autoExportConfigs: [],
  };
}

function makeConversation(messages: ConversationMessage[]): Conversation {
  return {
    tabId: 42,
    url: "https://blog.example.com/web-performance",
    title: "Understanding Web Performance",
    messages,
    createdAt: "2024-03-10T09:00:00Z",
    updatedAt: "2024-03-10T09:15:00Z",
  };
}

const FIXED_DATE = new Date("2024-03-10T14:30:00Z");

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("CF-4 Export Pipeline Integration", () => {
  describe("full export assembly produces correct document structure", () => {
    it("assembles frontmatter → Summary → Q&A → Content in correct order with all sections", async () => {
      const article = makeArticle();
      const conversation = makeConversation([
        { role: "assistant", content: "This article covers web performance metrics including LCP, FID, and CLS.", timestamp: "2024-03-10T09:01:00Z" },
        { role: "user", content: "What is the most important metric?", timestamp: "2024-03-10T09:02:00Z" },
        { role: "assistant", content: "LCP (Largest Contentful Paint) is often considered the most impactful.", timestamp: "2024-03-10T09:03:00Z" },
      ]);

      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(conversation),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: true,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify filename was generated
      expect(result.filename).toBe("2024-03-10-understanding-web-performance.md");

      // Get the assembled document
      const content = downloadMock.mock.calls[0][0].content;

      // Verify frontmatter structure
      expect(content).toMatch(/^---\n/);
      expect(content).toContain("title: Understanding Web Performance");
      expect(content).toContain("author: Jane Smith");
      // URL contains colon, so it gets double-quoted by the YAML renderer
      expect(content).toContain('source_url: "https://blog.example.com/web-performance"');
      expect(content).toContain("publication_date: 2024-03-10");
      // ISO date contains colons, so it gets double-quoted
      expect(content).toContain('capture_date: "2024-03-10T14:30:00.000Z"');
      expect(content).toContain("site_name: Example Blog");

      // Verify section ordering
      const frontmatterEnd = content.indexOf("---", 4);
      const summaryIdx = content.indexOf("## Summary");
      const qaIdx = content.indexOf("## Q&A");
      const contentIdx = content.indexOf("## Content");

      expect(frontmatterEnd).toBeGreaterThan(0);
      expect(summaryIdx).toBeGreaterThan(frontmatterEnd);
      expect(qaIdx).toBeGreaterThan(summaryIdx);
      expect(contentIdx).toBeGreaterThan(qaIdx);

      // Verify summary content
      expect(content).toContain("This article covers web performance metrics");

      // Verify Q&A structure
      expect(content).toContain("### Q:");
      expect(content).toContain("What is the most important metric?");
      expect(content).toContain("### A:");
      expect(content).toContain("LCP (Largest Contentful Paint) is often considered the most impactful.");

      // Verify page content
      expect(content).toContain("# Introduction");
      expect(content).toContain("Web performance is critical for user experience.");
    });

    it("produces valid document with frontmatter + content only when no summary/Q&A exists", async () => {
      const article = makeArticle();

      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: true, // Even with includeQA true, no conversation means no Q&A
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = downloadMock.mock.calls[0][0].content;

      // Should have frontmatter
      expect(content).toMatch(/^---\n/);
      expect(content).toContain("title: Understanding Web Performance");

      // Should have content section
      expect(content).toContain("## Content");
      expect(content).toContain("Web performance is critical for user experience.");

      // Should NOT have summary or Q&A
      expect(content).not.toContain("## Summary");
      expect(content).not.toContain("## Q&A");
      expect(content).not.toContain("### Q:");
      expect(content).not.toContain("### A:");
    });

    it("omits frontmatter fields with null/unavailable values", async () => {
      const article = makeArticle({ author: null, publicationDate: null });

      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = downloadMock.mock.calls[0][0].content;

      // Present fields
      expect(content).toContain("title: Understanding Web Performance");
      expect(content).toContain("source_url:");
      expect(content).toContain("capture_date:");
      expect(content).toContain("site_name:");

      // Omitted fields (null values)
      expect(content).not.toContain("author:");
      expect(content).not.toContain("publication_date:");
    });
  });

  describe("download destination via mocked browser.downloads.download", () => {
    it("delivers assembled document to download destination with correct filename", async () => {
      const article = makeArticle();
      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Download mock should be called exactly once
      expect(downloadMock).toHaveBeenCalledTimes(1);

      // Verify the download input
      const downloadInput = downloadMock.mock.calls[0][0];
      expect(downloadInput.filename).toBe("2024-03-10-understanding-web-performance.md");
      expect(downloadInput.content).toContain("---");
      expect(downloadInput.content).toContain("## Content");

      // Verify the outcome
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toEqual({ destination: { kind: "download" }, ok: true });
    });

    it("reports download failure in per-destination outcome", async () => {
      const article = makeArticle();
      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({
        ok: false,
        reason: "download-failed",
        detail: "Disk full",
      });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      // Export itself succeeds (document was assembled), but destination failed
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].ok).toBe(false);
      if (!result.outcomes[0].ok) {
        expect(result.outcomes[0].reason).toBe("download-failed");
        expect(result.outcomes[0].detail).toBe("Disk full");
      }
    });
  });

  describe("clipboard destination via mocked clipboard write", () => {
    it("delivers full Markdown content (including frontmatter) to clipboard", async () => {
      const article = makeArticle();
      const conversation = makeConversation([
        { role: "assistant", content: "Summary of the article.", timestamp: "2024-03-10T09:01:00Z" },
      ]);

      const clipboardMock = vi.fn<(content: string) => Promise<ClipboardResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(conversation),
        deliverToDownload: vi.fn().mockResolvedValue({ ok: true }),
        deliverToClipboard: clipboardMock,
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "clipboard" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Clipboard mock should be called exactly once
      expect(clipboardMock).toHaveBeenCalledTimes(1);

      // Verify the clipboard content includes frontmatter
      const clipboardContent = clipboardMock.mock.calls[0][0];
      expect(clipboardContent).toMatch(/^---\n/);
      expect(clipboardContent).toContain("title: Understanding Web Performance");
      expect(clipboardContent).toContain("## Summary");
      expect(clipboardContent).toContain("Summary of the article.");
      expect(clipboardContent).toContain("## Content");

      // Verify the outcome
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toEqual({ destination: { kind: "clipboard" }, ok: true });
    });

    it("reports clipboard failure in per-destination outcome", async () => {
      const article = makeArticle();
      const clipboardMock = vi.fn<(content: string) => Promise<ClipboardResult>>().mockResolvedValue({
        ok: false,
        reason: "clipboard-denied",
        detail: "Clipboard write permission denied",
      });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: vi.fn().mockResolvedValue({ ok: true }),
        deliverToClipboard: clipboardMock,
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "clipboard" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].ok).toBe(false);
      if (!result.outcomes[0].ok) {
        expect(result.outcomes[0].reason).toBe("clipboard-denied");
        expect(result.outcomes[0].detail).toBe("Clipboard write permission denied");
      }
    });
  });

  describe("multiple destinations dispatched independently with per-destination outcomes", () => {
    it("dispatches to both download and clipboard independently, both succeed", async () => {
      const article = makeArticle();
      const conversation = makeConversation([
        { role: "assistant", content: "A brief summary.", timestamp: "2024-03-10T09:01:00Z" },
        { role: "user", content: "Tell me more about CLS.", timestamp: "2024-03-10T09:02:00Z" },
        { role: "assistant", content: "CLS measures visual stability.", timestamp: "2024-03-10T09:03:00Z" },
      ]);

      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });
      const clipboardMock = vi.fn<(content: string) => Promise<ClipboardResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(conversation),
        deliverToDownload: downloadMock,
        deliverToClipboard: clipboardMock,
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: true,
        destinations: [{ kind: "download" }, { kind: "clipboard" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both destinations called
      expect(downloadMock).toHaveBeenCalledTimes(1);
      expect(clipboardMock).toHaveBeenCalledTimes(1);

      // Both receive the same content
      const downloadContent = downloadMock.mock.calls[0][0].content;
      const clipboardContent = clipboardMock.mock.calls[0][0];
      expect(downloadContent).toBe(clipboardContent);

      // Both outcomes are success
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0]).toEqual({ destination: { kind: "download" }, ok: true });
      expect(result.outcomes[1]).toEqual({ destination: { kind: "clipboard" }, ok: true });
    });

    it("one destination fails while the other succeeds — both outcomes reported independently", async () => {
      const article = makeArticle();

      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });
      const clipboardMock = vi.fn<(content: string) => Promise<ClipboardResult>>().mockResolvedValue({
        ok: false,
        reason: "clipboard-denied",
        detail: "Not focused",
      });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: clipboardMock,
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }, { kind: "clipboard" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both destinations were attempted
      expect(downloadMock).toHaveBeenCalledTimes(1);
      expect(clipboardMock).toHaveBeenCalledTimes(1);

      // Per-destination outcomes
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0]).toEqual({ destination: { kind: "download" }, ok: true });
      expect(result.outcomes[1].ok).toBe(false);
      if (!result.outcomes[1].ok) {
        expect(result.outcomes[1].destination).toEqual({ kind: "clipboard" });
        expect(result.outcomes[1].reason).toBe("clipboard-denied");
      }
    });

    it("both destinations fail — overall export still succeeds with failure outcomes", async () => {
      const article = makeArticle();

      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({
        ok: false,
        reason: "download-failed",
        detail: "Network error",
      });
      const clipboardMock = vi.fn<(content: string) => Promise<ClipboardResult>>().mockResolvedValue({
        ok: false,
        reason: "clipboard-denied",
        detail: "Permission denied",
      });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: clipboardMock,
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }, { kind: "clipboard" }],
      });

      // Export assembly succeeded even though delivery failed
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.filename).toBe("2024-03-10-understanding-web-performance.md");
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0].ok).toBe(false);
      expect(result.outcomes[1].ok).toBe(false);
    });

    it("extraction failure prevents dispatch to any destination", async () => {
      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });
      const clipboardMock = vi.fn<(content: string) => Promise<ClipboardResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({
          ok: false,
          reason: "no-content-detected",
          detail: "Page has no extractable content",
        } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: clipboardMock,
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }, { kind: "clipboard" }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("extraction-failed");
      expect(result.detail).toBe("Page has no extractable content");

      // Neither destination should have been called
      expect(downloadMock).not.toHaveBeenCalled();
      expect(clipboardMock).not.toHaveBeenCalled();
    });
  });

  describe("export without summary/Q&A produces valid document with frontmatter + content only", () => {
    it("no conversation at all — valid document with only frontmatter and content", async () => {
      const article = makeArticle();
      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(null),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = downloadMock.mock.calls[0][0].content;

      // Valid frontmatter
      expect(content).toMatch(/^---\n/);
      expect(content).toContain("---\n");

      // Content section present
      expect(content).toContain("## Content");
      expect(content).toContain("Web performance is critical for user experience.");

      // No summary or Q&A
      expect(content).not.toContain("## Summary");
      expect(content).not.toContain("## Q&A");
    });

    it("empty conversation (no messages) — valid document with only frontmatter and content", async () => {
      const article = makeArticle();
      const emptyConversation = makeConversation([]);
      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(emptyConversation),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: true,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = downloadMock.mock.calls[0][0].content;

      // Valid structure: frontmatter + content only
      expect(content).toMatch(/^---\n/);
      expect(content).toContain("## Content");
      expect(content).not.toContain("## Summary");
      expect(content).not.toContain("## Q&A");
    });

    it("conversation with only user messages (no assistant summary) — no summary section", async () => {
      const article = makeArticle();
      const conversation = makeConversation([
        { role: "user", content: "Hello?", timestamp: "2024-03-10T09:01:00Z" },
      ]);
      const downloadMock = vi.fn<(input: DownloadInput) => Promise<DownloadResult>>().mockResolvedValue({ ok: true });

      const opts: CreateExportManagerOptions = {
        extractContent: vi.fn().mockResolvedValue({ ok: true, article, confidence: "high" } as ExtractionResult),
        getSettings: vi.fn().mockResolvedValue(makeSettings()),
        getConversation: vi.fn().mockReturnValue(conversation),
        deliverToDownload: downloadMock,
        deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
        getCaptureDate: () => FIXED_DATE,
      };

      const manager = createExportManager(opts);
      const result = await manager.export({
        tabId: 42,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = downloadMock.mock.calls[0][0].content;

      // No summary since there's no assistant message
      expect(content).not.toContain("## Summary");
      expect(content).toContain("## Content");
    });
  });
});
