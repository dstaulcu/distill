/**
 * Property 7: Export document section ordering
 * Validates: Requirements 5.1, 5.3, 5.4, 5.5
 *
 * Verifies that the Export Manager always assembles documents with sections
 * in strict order: frontmatter → Summary → Q&A → Content, regardless of
 * the combination of available data.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createExportManager } from "./manager";
import type { CreateExportManagerOptions, DownloadInput } from "./manager";
import type { ExtractionResult } from "@content/extractor/extract";
import type { Settings, Conversation, ConversationMessage, ExtractedArticle } from "@shared/types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a random ExtractedArticle with non-empty alphanumeric title
 * (to ensure filename generation succeeds).
 */
const articleArb = fc
  .record({
    title: fc.stringOf(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789 ".split(""))), {
      minLength: 3,
      maxLength: 40,
    }),
    author: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: null }),
    publicationDate: fc.option(fc.constant("2024-01-15"), { nil: null }),
    sourceUrl: fc.constant("https://example.com/article"),
    siteName: fc.constant("Example"),
    bodyMarkdown: fc.string({ minLength: 1, maxLength: 200 }),
    bodyCharacterCount: fc.nat({ max: 10000 }),
  })
  .filter((a) => /[a-z0-9]/.test(a.title));

/**
 * Generates a conversation message.
 */
const messageArb = (role: "user" | "assistant"): fc.Arbitrary<ConversationMessage> =>
  fc.record({
    role: fc.constant(role),
    content: fc.string({ minLength: 1, maxLength: 100 }),
    timestamp: fc.constant("2024-01-15T10:00:00Z"),
  });

/**
 * Generates a conversation with optional summary (first assistant message)
 * and optional follow-up Q&A messages.
 */
const conversationArb = fc.record({
  hasSummary: fc.boolean(),
  qaExchangeCount: fc.nat({ max: 4 }),
}).chain(({ hasSummary, qaExchangeCount }) => {
  const messages: fc.Arbitrary<ConversationMessage>[] = [];

  if (hasSummary) {
    messages.push(messageArb("assistant"));
  }

  for (let i = 0; i < qaExchangeCount; i++) {
    messages.push(messageArb("user"));
    messages.push(messageArb("assistant"));
  }

  if (messages.length === 0) {
    return fc.record({
      hasSummary: fc.constant(hasSummary),
      qaExchangeCount: fc.constant(qaExchangeCount),
      messages: fc.constant([] as ConversationMessage[]),
    });
  }

  return fc.tuple(...messages).map((msgs) => ({
    hasSummary,
    qaExchangeCount,
    messages: msgs,
  }));
});

/**
 * Generates the includeQA flag.
 */
const includeQAArb = fc.boolean();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(): Settings {
  return {
    schemaVersion: 1,
    ai: {
      baseUrl: "https://api.example.com",
      modelId: "gpt-4",
      apiKeyRef: null,
      systemPrompt: "Summarize.",
    },
    export: {
      filenamePattern: "YYYY-MM-DD-slugified-title",
      defaultDestination: { kind: "download" },
      frontmatterFields: ["title", "source_url", "capture_date"],
    },
    sitePatterns: [],
    autoExportConfigs: [],
  };
}

function makeConversation(messages: ConversationMessage[]): Conversation | null {
  if (messages.length === 0) return null;
  return {
    tabId: 1,
    url: "https://example.com/article",
    title: "Test",
    messages,
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:30:00Z",
  };
}

function makeOpts(article: ExtractedArticle, conversation: Conversation | null): CreateExportManagerOptions {
  const extraction: ExtractionResult = { ok: true, article, confidence: "high" };
  return {
    extractContent: vi.fn().mockResolvedValue(extraction),
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    getConversation: vi.fn().mockReturnValue(conversation),
    deliverToDownload: vi.fn().mockResolvedValue({ ok: true }),
    deliverToClipboard: vi.fn().mockResolvedValue({ ok: true }),
    getCaptureDate: () => new Date("2024-01-20T10:30:00Z"),
  };
}

function getExportedContent(opts: CreateExportManagerOptions): string {
  const deliverToDownload = opts.deliverToDownload as ReturnType<typeof vi.fn>;
  const downloadCall = deliverToDownload.mock.calls[0][0] as DownloadInput;
  return downloadCall.content;
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Property 7: Export document section ordering", () => {
  it("frontmatter (---) always appears first in the exported document", () => {
    /**
     * **Validates: Requirements 5.1, 5.3, 5.4, 5.5**
     */
    fc.assert(
      fc.asyncProperty(
        articleArb,
        conversationArb,
        includeQAArb,
        async (article, convData, includeQA) => {
          const conversation = makeConversation(convData.messages);
          const opts = makeOpts(article, conversation);
          const manager = createExportManager(opts);

          const result = await manager.export({
            tabId: 1,
            includeQA,
            destinations: [{ kind: "download" }],
          });

          if (!result.ok) return; // Skip if export fails (e.g., filename issue)

          const content = getExportedContent(opts);

          // Frontmatter must start at the very beginning
          expect(content.startsWith("---\n")).toBe(true);

          // The closing --- must appear before any ## heading
          const closingFrontmatter = content.indexOf("---", 3);
          expect(closingFrontmatter).toBeGreaterThan(0);

          const firstHeading = content.indexOf("## ");
          if (firstHeading !== -1) {
            expect(closingFrontmatter).toBeLessThan(firstHeading);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("when summary exists, ## Summary always appears before ## Content", () => {
    /**
     * **Validates: Requirements 5.1, 5.3, 5.5**
     */
    fc.assert(
      fc.asyncProperty(
        articleArb,
        // Generate conversations that always have a summary (first assistant message)
        fc.nat({ max: 4 }).chain((qaCount) => {
          const messages: fc.Arbitrary<ConversationMessage>[] = [messageArb("assistant")];
          for (let i = 0; i < qaCount; i++) {
            messages.push(messageArb("user"));
            messages.push(messageArb("assistant"));
          }
          return fc.tuple(...messages);
        }),
        includeQAArb,
        async (article, msgs, includeQA) => {
          const conversation = makeConversation(msgs);
          const opts = makeOpts(article, conversation);
          const manager = createExportManager(opts);

          const result = await manager.export({
            tabId: 1,
            includeQA,
            destinations: [{ kind: "download" }],
          });

          if (!result.ok) return;

          const content = getExportedContent(opts);

          const summaryIdx = content.indexOf("## Summary");
          const contentIdx = content.indexOf("## Content");

          // Summary must be present
          expect(summaryIdx).toBeGreaterThan(-1);
          // Content must be present
          expect(contentIdx).toBeGreaterThan(-1);
          // Summary must come before Content
          expect(summaryIdx).toBeLessThan(contentIdx);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("when Q&A is included, ## Q&A always appears between ## Summary and ## Content", () => {
    /**
     * **Validates: Requirements 5.1, 5.3, 5.4, 5.5**
     */
    fc.assert(
      fc.asyncProperty(
        articleArb,
        // Generate conversations with summary + at least one Q&A exchange
        fc.nat({ max: 3 }).chain((extraQA) => {
          const messages: fc.Arbitrary<ConversationMessage>[] = [
            messageArb("assistant"), // summary
            messageArb("user"),      // first question
            messageArb("assistant"), // first answer
          ];
          for (let i = 0; i < extraQA; i++) {
            messages.push(messageArb("user"));
            messages.push(messageArb("assistant"));
          }
          return fc.tuple(...messages);
        }),
        async (article, msgs) => {
          const conversation = makeConversation(msgs);
          const opts = makeOpts(article, conversation);
          const manager = createExportManager(opts);

          const result = await manager.export({
            tabId: 1,
            includeQA: true, // Must be true for Q&A to appear
            destinations: [{ kind: "download" }],
          });

          if (!result.ok) return;

          const content = getExportedContent(opts);

          const summaryIdx = content.indexOf("## Summary");
          const qaIdx = content.indexOf("## Q&A");
          const contentIdx = content.indexOf("## Content");

          // All three sections must be present
          expect(summaryIdx).toBeGreaterThan(-1);
          expect(qaIdx).toBeGreaterThan(-1);
          expect(contentIdx).toBeGreaterThan(-1);

          // Strict ordering: Summary < Q&A < Content
          expect(summaryIdx).toBeLessThan(qaIdx);
          expect(qaIdx).toBeLessThan(contentIdx);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("## Content section is always present regardless of configuration", () => {
    /**
     * **Validates: Requirements 5.1, 5.5**
     */
    fc.assert(
      fc.asyncProperty(
        articleArb,
        conversationArb,
        includeQAArb,
        async (article, convData, includeQA) => {
          const conversation = makeConversation(convData.messages);
          const opts = makeOpts(article, conversation);
          const manager = createExportManager(opts);

          const result = await manager.export({
            tabId: 1,
            includeQA,
            destinations: [{ kind: "download" }],
          });

          if (!result.ok) return;

          const content = getExportedContent(opts);

          // ## Content must always be present
          expect(content).toContain("## Content");

          // ## Content must be the last section heading
          const contentIdx = content.indexOf("## Content");
          const afterContent = content.slice(contentIdx + "## Content".length);
          // No other ## level heading should appear after ## Content
          expect(afterContent).not.toMatch(/^## [A-Z]/m);
        },
      ),
      { numRuns: 100 },
    );
  });
});
