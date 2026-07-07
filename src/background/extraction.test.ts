/**
 * Unit tests for the extraction orchestration service.
 *
 * Covers CF-1.1 (hasSavedPattern = user patterns only), CF-1.4 (precise stale
 * flagging), CF-1.5 (privileged-page guard), CF-1.6 (content-script timeout),
 * and CF-6.4 (picker-saved user selector is actually used).
 */

import { describe, it, expect, vi } from "vitest";
import { createExtractionService, type ExtractionServiceDeps } from "./extraction";
import type { Settings, SitePattern } from "@shared/types";
import { buildMessage, type MessageOf } from "@shared/messages";

function makeSettings(sitePatterns: ReadonlyArray<SitePattern> = []): Settings {
  return {
    schemaVersion: 1,
    ai: { baseUrl: "", modelId: "", apiKeyRef: null, systemPrompt: "" },
    export: { filenamePattern: "YYYY-MM-DD-slugified-title", defaultDestination: { kind: "download" }, frontmatterFields: ["title"] },
    sitePatterns,
    autoExportConfigs: [],
  };
}

function makeExtractResponse(overrides?: Partial<MessageOf<"extractResult">["payload"]>): MessageOf<"extractResult"> {
  return buildMessage("extractResult", {
    ok: true,
    article: {
      title: "Test Article",
      author: null,
      publicationDate: null,
      sourceUrl: "https://example.com/a",
      siteName: "Example",
      bodyMarkdown: "# Hello",
      bodyCharacterCount: 7,
    },
    confidence: "high",
    ...overrides,
  });
}

function makeDeps(overrides?: Partial<ExtractionServiceDeps>): ExtractionServiceDeps & {
  sentMessages: MessageOf<"extractRequested">[];
  updatedPatterns: ReadonlyArray<SitePattern>[];
} {
  const sentMessages: MessageOf<"extractRequested">[] = [];
  const updatedPatterns: ReadonlyArray<SitePattern>[] = [];
  return {
    sentMessages,
    updatedPatterns,
    getTabUrl: async () => "https://example.com/article",
    sendExtractMessage: async (_tabId, msg) => {
      sentMessages.push(msg);
      return makeExtractResponse();
    },
    getSettings: async () => makeSettings(),
    updateSitePatterns: async (patterns) => {
      updatedPatterns.push(patterns);
    },
    ...overrides,
  };
}

describe("CF-1.5 privileged-page guard", () => {
  it.each(["about:blank", "about:config", "moz-extension://abc/page.html", "chrome://settings", ""])(
    "refuses extraction for %j without messaging the content script",
    async (url) => {
      const deps = makeDeps({ getTabUrl: async () => url });
      const service = createExtractionService(deps);

      const result = await service.extractContent(1);

      expect(result.ok).toBe(false);
      expect(deps.sentMessages).toHaveLength(0);
    },
  );

  it("returns an error when the tab is not accessible", async () => {
    const deps = makeDeps({
      getTabUrl: async () => {
        throw new Error("No tab with id 99");
      },
    });
    const service = createExtractionService(deps);

    const result = await service.extractContent(99);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe("Tab not accessible");
    }
  });
});

describe("CF-1.6 content-script timeout", () => {
  it("fails with a timeout error when the content script never responds", async () => {
    const deps = makeDeps({
      sendExtractMessage: () => new Promise(() => {}), // never resolves
      timeoutMs: 25,
    });
    const service = createExtractionService(deps);

    const result = await service.extractContent(1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("did not respond");
    }
  });
});

describe("CF-6.4 selector resolution from saved patterns", () => {
  it("uses the picker-saved user pattern's selector for the matching site", async () => {
    const userPattern: SitePattern = {
      id: "user-example",
      source: "user",
      urlMatchPattern: "*://example.com/*",
      contentSelector: "#picked-content",
    };
    const deps = makeDeps({ getSettings: async () => makeSettings([userPattern]) });
    const service = createExtractionService(deps);

    await service.extractContent(1);

    expect(deps.sentMessages).toHaveLength(1);
    expect(deps.sentMessages[0].payload.selector).toBe("#picked-content");
  });

  it("an explicitly passed selector overrides pattern lookup", async () => {
    const deps = makeDeps();
    const service = createExtractionService(deps);

    await service.extractContent(1, ".explicit");

    expect(deps.sentMessages[0].payload.selector).toBe(".explicit");
  });
});

describe("CF-1.4 stale flagging", () => {
  const stalePayload = { stalePattern: true } as const;

  it("flags only the user pattern that matched this URL", async () => {
    const matching: SitePattern = {
      id: "user-example",
      source: "user",
      urlMatchPattern: "*://example.com/*",
      contentSelector: ".content",
    };
    const otherSiteSameSelector: SitePattern = {
      id: "user-other",
      source: "user",
      urlMatchPattern: "*://other.org/*",
      contentSelector: ".content",
    };
    const deps = makeDeps({
      getSettings: async () => makeSettings([matching, otherSiteSameSelector]),
      sendExtractMessage: async (_tabId, msg) => {
        void msg;
        return makeExtractResponse(stalePayload);
      },
    });
    const service = createExtractionService(deps);

    await service.extractContent(1);
    // stale marking is fire-and-forget; give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.updatedPatterns).toHaveLength(1);
    const updated = deps.updatedPatterns[0];
    expect(updated.find((p) => p.id === "user-example")?.stale).toBe(true);
    expect(updated.find((p) => p.id === "user-other")?.stale).toBeUndefined();
  });

  it("never flags builtin-source patterns", async () => {
    // Legacy stored settings may still contain builtin entries
    const legacyBuiltin: SitePattern = {
      id: "builtin-generic",
      source: "builtin",
      urlMatchPattern: "*://*/*",
      contentSelector: "article",
    };
    const deps = makeDeps({
      getSettings: async () => makeSettings([legacyBuiltin]),
      sendExtractMessage: async () => makeExtractResponse(stalePayload),
    });
    const service = createExtractionService(deps);

    // The canonical builtin fallback resolves a selector, and the content
    // script reports it stale — but no stored pattern may be flagged.
    await service.extractContent(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.updatedPatterns).toHaveLength(0);
  });
});

describe("CF-1.1 hasSavedPattern means a USER pattern exists", () => {
  it("returns false when only builtins match (they match every http(s) URL)", async () => {
    const deps = makeDeps({ getSettings: async () => makeSettings([]) });
    const service = createExtractionService(deps);

    expect(await service.hasSavedPattern("https://example.com/article")).toBe(false);
  });

  it("returns true when a user pattern matches the site", async () => {
    const userPattern: SitePattern = {
      id: "user-example",
      source: "user",
      urlMatchPattern: "*://example.com/*",
      contentSelector: "#main",
    };
    const deps = makeDeps({ getSettings: async () => makeSettings([userPattern]) });
    const service = createExtractionService(deps);

    expect(await service.hasSavedPattern("https://example.com/article")).toBe(true);
    expect(await service.hasSavedPattern("https://unrelated.net/")).toBe(false);
  });
});

describe("extraction result handling", () => {
  it("propagates content-script failure results", async () => {
    const deps = makeDeps({
      sendExtractMessage: async () =>
        buildMessage("extractResult", { ok: false, reason: "no-content-detected", detail: "Nothing found" }),
    });
    const service = createExtractionService(deps);

    const result = await service.extractContent(1);

    expect(result).toEqual({ ok: false, reason: "no-content-detected", detail: "Nothing found" });
  });

  it("treats a missing response as an error", async () => {
    const deps = makeDeps({ sendExtractMessage: async () => undefined });
    const service = createExtractionService(deps);

    const result = await service.extractContent(1);

    expect(result.ok).toBe(false);
  });

  it("returns the article on success", async () => {
    const service = createExtractionService(makeDeps());

    const result = await service.extractContent(1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.article.title).toBe("Test Article");
      expect(result.confidence).toBe("high");
    }
  });
});
