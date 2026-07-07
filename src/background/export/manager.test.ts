/**
 * Unit tests for Export Manager.
 *
 * Tests the document assembly, destination dispatch, and error handling
 * with mocked dependencies.
 */

import { describe, it, expect, vi } from "vitest";
import { createExportManager } from "./manager";
import type {
  CreateExportManagerOptions,
  ExportRequest,
  DownloadInput,
  DownloadResult,
  ClipboardResult,
} from "./manager";
import type { ExtractionResult } from "@content/extractor/extract";
import type { Settings, Conversation, ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeArticle(overrides?: Partial<ExtractedArticle>): ExtractedArticle {
  return {
    title: "Test Article",
    author: "Test Author",
    publicationDate: "2024-01-15",
    sourceUrl: "https://example.com/article",
    siteName: "Example Site",
    bodyMarkdown: "This is the article body content.",
    bodyCharacterCount: 33,
    ...overrides,
  };
}

function makeSettings(overrides?: Partial<Settings["export"]>): Settings {
  return {
    schemaVersion: 1,
    ai: {
      baseUrl: "https://api.example.com",
      modelId: "gpt-4",
      apiKeyRef: null,
      systemPrompt: "Summarize this article.",
    },
    export: {
      filenamePattern: "YYYY-MM-DD-slugified-title",
      defaultDestination: { kind: "download" },
      frontmatterFields: ["title", "author", "source_url", "capture_date"],
      ...overrides,
    },
    sitePatterns: [],
    autoExportConfigs: [],
  };
}

function makeConversation(messages: Conversation["messages"] = []): Conversation {
  return {
    tabId: 1,
    url: "https://example.com/article",
    title: "Test Article",
    messages,
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:30:00Z",
  };
}

function makeExtractionSuccess(article?: ExtractedArticle): ExtractionResult {
  return {
    ok: true,
    article: article ?? makeArticle(),
    confidence: "high",
  };
}

function makeExtractionFailure(): ExtractionResult {
  return {
    ok: false,
    reason: "no-content-detected",
    detail: "No article content found on page",
  };
}

function makeOpts(overrides?: Partial<CreateExportManagerOptions>): CreateExportManagerOptions {
  return {
    extractContent: vi.fn().mockResolvedValue(makeExtractionSuccess()),
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    getConversation: vi.fn().mockReturnValue(null),
    deliverToDownload: vi.fn().mockResolvedValue({ ok: true }),
    deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
    getCaptureDate: () => new Date("2024-01-20T10:30:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-4 Export Manager", () => {
  describe("successful export", () => {
    it("produces a valid export with frontmatter and content only (no summary, no Q&A)", async () => {
      const opts = makeOpts();
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.filename).toMatch(/\.md$/);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].ok).toBe(true);

      // Verify the download was called with content containing frontmatter and ## Content
      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).toContain("---");
      expect(downloadCall.content).toContain("## Content");
      expect(downloadCall.content).toContain("This is the article body content.");
      expect(downloadCall.content).not.toContain("## Summary");
      expect(downloadCall.content).not.toContain("## Q&A");
    });

    it("includes ## Summary section when conversation has a summary", async () => {
      const conversation = makeConversation([
        { role: "assistant", content: "This is the summary.", timestamp: "2024-01-15T10:00:00Z" },
      ]);

      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(conversation),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).toContain("## Summary");
      expect(downloadCall.content).toContain("This is the summary.");
    });

    it("includes ## Q&A section with ### Q: and ### A: sub-headings when includeQA is true", async () => {
      const conversation = makeConversation([
        { role: "assistant", content: "Summary content.", timestamp: "2024-01-15T10:00:00Z" },
        { role: "user", content: "What is the main point?", timestamp: "2024-01-15T10:01:00Z" },
        { role: "assistant", content: "The main point is X.", timestamp: "2024-01-15T10:02:00Z" },
      ]);

      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(conversation),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: true,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).toContain("## Q&A");
      expect(downloadCall.content).toContain("### Q:");
      expect(downloadCall.content).toContain("What is the main point?");
      expect(downloadCall.content).toContain("### A:");
      expect(downloadCall.content).toContain("The main point is X.");
    });

    it("does not include ## Q&A section when includeQA is false even with conversation", async () => {
      const conversation = makeConversation([
        { role: "assistant", content: "Summary.", timestamp: "2024-01-15T10:00:00Z" },
        { role: "user", content: "Question?", timestamp: "2024-01-15T10:01:00Z" },
        { role: "assistant", content: "Answer.", timestamp: "2024-01-15T10:02:00Z" },
      ]);

      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(conversation),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).not.toContain("## Q&A");
    });

    it("maintains strict section order: frontmatter → Summary → Q&A → Content", async () => {
      const conversation = makeConversation([
        { role: "assistant", content: "Summary here.", timestamp: "2024-01-15T10:00:00Z" },
        { role: "user", content: "My question", timestamp: "2024-01-15T10:01:00Z" },
        { role: "assistant", content: "My answer", timestamp: "2024-01-15T10:02:00Z" },
      ]);

      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(conversation),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: true,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      const content = downloadCall.content;

      const frontmatterEnd = content.lastIndexOf("---");
      const summaryIdx = content.indexOf("## Summary");
      const qaIdx = content.indexOf("## Q&A");
      const contentIdx = content.indexOf("## Content");

      expect(frontmatterEnd).toBeLessThan(summaryIdx);
      expect(summaryIdx).toBeLessThan(qaIdx);
      expect(qaIdx).toBeLessThan(contentIdx);
    });

    it("dispatches to multiple destinations independently", async () => {
      const opts = makeOpts();
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }, { kind: "clipboard" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0]).toEqual({ destination: { kind: "download" }, ok: true });
      expect(result.outcomes[1]).toEqual({ destination: { kind: "clipboard" }, ok: true });

      expect(opts.deliverToDownload).toHaveBeenCalledTimes(1);
      expect(opts.deliverToClipboard).toHaveBeenCalledTimes(1);
    });

    it("returns per-destination failure when one destination fails", async () => {
      const opts = makeOpts({
        deliverToDownload: vi.fn().mockResolvedValue({ ok: true }),
        deliverToClipboard: vi.fn().mockResolvedValue({
          ok: false,
          reason: "clipboard-denied",
          detail: "Permission denied",
        }),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }, { kind: "clipboard" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.outcomes[0].ok).toBe(true);
      expect(result.outcomes[1].ok).toBe(false);
      if (!result.outcomes[1].ok) {
        expect(result.outcomes[1].reason).toBe("clipboard-denied");
        expect(result.outcomes[1].detail).toBe("Permission denied");
      }
    });

    it("generates correct filename from settings pattern and article title", async () => {
      const opts = makeOpts();
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Pattern: "YYYY-MM-DD-slugified-title", date: 2024-01-20, title: "Test Article"
      expect(result.filename).toBe("2024-01-20-test-article.md");
    });

    it("passes correct content to clipboard destination", async () => {
      const opts = makeOpts();
      const manager = createExportManager(opts);

      await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "clipboard" }],
      });

      const deliverToClipboard = opts.deliverToClipboard as ReturnType<typeof vi.fn>;
      expect(deliverToClipboard).toHaveBeenCalledTimes(1);
      const clipboardContent = deliverToClipboard.mock.calls[0][0] as string;
      expect(clipboardContent).toContain("---");
      expect(clipboardContent).toContain("## Content");
    });
  });

  describe("error handling", () => {
    it("returns extraction-failed when content extraction fails", async () => {
      const opts = makeOpts({
        extractContent: vi.fn().mockResolvedValue(makeExtractionFailure()),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("extraction-failed");
      expect(result.detail).toBe("No article content found on page");
    });

    it("returns filename-invalid when filename generation fails", async () => {
      const opts = makeOpts({
        extractContent: vi.fn().mockResolvedValue(
          makeExtractionSuccess(makeArticle({ title: "!!!" })),
        ),
        getSettings: vi.fn().mockResolvedValue(
          makeSettings({ filenamePattern: "slugified-title" }),
        ),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("filename-invalid");
    });

    it("returns frontmatter-invalid when frontmatter rendering fails", async () => {
      const opts = makeOpts({
        getSettings: vi.fn().mockResolvedValue(
          makeSettings({ frontmatterFields: [] }),
        ),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("frontmatter-invalid");
    });

    it("does not dispatch to destinations when extraction fails", async () => {
      const opts = makeOpts({
        extractContent: vi.fn().mockResolvedValue(makeExtractionFailure()),
      });
      const manager = createExportManager(opts);

      await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(opts.deliverToDownload).not.toHaveBeenCalled();
      expect(opts.deliverToClipboard).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles no summary and no Q&A — produces frontmatter + content only", async () => {
      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(null),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: true, // Even with includeQA true, no conversation means no Q&A
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).toContain("---");
      expect(downloadCall.content).toContain("## Content");
      expect(downloadCall.content).not.toContain("## Summary");
      expect(downloadCall.content).not.toContain("## Q&A");
    });

    it("handles conversation with only summary (no follow-up Q&A)", async () => {
      const conversation = makeConversation([
        { role: "assistant", content: "Just a summary.", timestamp: "2024-01-15T10:00:00Z" },
      ]);

      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(conversation),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: true,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).toContain("## Summary");
      expect(downloadCall.content).toContain("Just a summary.");
      expect(downloadCall.content).not.toContain("## Q&A");
    });

    it("handles multiple Q&A exchanges", async () => {
      const conversation = makeConversation([
        { role: "assistant", content: "Summary.", timestamp: "2024-01-15T10:00:00Z" },
        { role: "user", content: "First question?", timestamp: "2024-01-15T10:01:00Z" },
        { role: "assistant", content: "First answer.", timestamp: "2024-01-15T10:02:00Z" },
        { role: "user", content: "Second question?", timestamp: "2024-01-15T10:03:00Z" },
        { role: "assistant", content: "Second answer.", timestamp: "2024-01-15T10:04:00Z" },
      ]);

      const opts = makeOpts({
        getConversation: vi.fn().mockReturnValue(conversation),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: true,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      const content = downloadCall.content;

      // Should have two Q: and two A: sub-headings
      const qHeadings = content.match(/### Q:/g);
      const aHeadings = content.match(/### A:/g);
      expect(qHeadings).toHaveLength(2);
      expect(aHeadings).toHaveLength(2);
      expect(content).toContain("First question?");
      expect(content).toContain("First answer.");
      expect(content).toContain("Second question?");
      expect(content).toContain("Second answer.");
    });

    it("uses injected getCaptureDate for frontmatter and filename", async () => {
      const fixedDate = new Date("2023-06-15T08:00:00Z");
      const opts = makeOpts({
        getCaptureDate: () => fixedDate,
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Filename should use the injected date
      expect(result.filename).toContain("2023-06-15");

      // Frontmatter should contain the capture date
      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).toContain("2023-06-15T08:00:00.000Z");
    });

    it("handles empty destinations array", async () => {
      const opts = makeOpts();
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.outcomes).toHaveLength(0);
      expect(opts.deliverToDownload).not.toHaveBeenCalled();
      expect(opts.deliverToClipboard).not.toHaveBeenCalled();
    });

    it("omits frontmatter fields with unavailable values", async () => {
      const article = makeArticle({ author: null, publicationDate: null });
      const opts = makeOpts({
        extractContent: vi.fn().mockResolvedValue(makeExtractionSuccess(article)),
        getSettings: vi.fn().mockResolvedValue(
          makeSettings({ frontmatterFields: ["title", "author", "publication_date", "capture_date"] }),
        ),
      });
      const manager = createExportManager(opts);

      const result = await manager.export({
        tabId: 1,
        includeQA: false,
        destinations: [{ kind: "download" }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
      const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
      expect(downloadCall.content).not.toContain("author:");
      expect(downloadCall.content).not.toContain("publication_date:");
      expect(downloadCall.content).toContain("title:");
      expect(downloadCall.content).toContain("capture_date:");
    });
  });
});
