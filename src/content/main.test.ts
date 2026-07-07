/**
 * Unit tests for the content script message handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildMessage } from "@shared/messages";
import type { MessageOf } from "@shared/messages";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the extract module
vi.mock("./extractor/extract", () => ({
  extract: vi.fn(),
}));

// Mock the element-picker module
vi.mock("./element-picker", () => ({
  createElementPicker: vi.fn(),
}));

import { extract } from "./extractor/extract";
import { createElementPicker } from "./element-picker";

const mockExtract = vi.mocked(extract);
const mockCreateElementPicker = vi.mocked(createElementPicker);

// Track the listener registered via browser.runtime.onMessage.addListener
let registeredListener: ((message: unknown) => undefined | Promise<unknown>) | null = null;

// Setup browser global mock
const mockAddListener = vi.fn((listener: (message: unknown) => undefined | Promise<unknown>) => {
  registeredListener = listener;
});

Object.defineProperty(globalThis, "browser", {
  value: {
    runtime: {
      onMessage: {
        addListener: mockAddListener,
      },
    },
  },
  writable: true,
});

describe("CF-1/CF-6 content/main message handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredListener = null;
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function loadModule() {
    // Dynamic import to trigger registerMessageListener after mocks are set up
    await import("./main");
  }

  describe("listener registration", () => {
    it("registers a message listener on import", async () => {
      await loadModule();
      expect(mockAddListener).toHaveBeenCalledOnce();
      expect(registeredListener).toBeTypeOf("function");
    });
  });

  describe("extractRequested handling", () => {
    it("calls extract with the provided selector and returns extractResult on success", async () => {
      const article = {
        title: "Test Article",
        author: "Author",
        publicationDate: "2024-01-01",
        sourceUrl: "https://example.com/article",
        siteName: "Example",
        bodyMarkdown: "# Hello\n\nContent here.",
        bodyCharacterCount: 22,
      };

      mockExtract.mockResolvedValue({
        ok: true,
        article,
        confidence: "high",
      });

      await loadModule();

      const msg = buildMessage("extractRequested", {
        tabId: 1,
        selector: ".article-body",
      }, "req-123");

      const result = await registeredListener!(msg) as MessageOf<"extractResult">;

      expect(mockExtract).toHaveBeenCalledWith({
        contentSelector: ".article-body",
      });
      expect(result).toEqual({
        kind: "extractResult",
        payload: {
          ok: true,
          article,
          confidence: "high",
        },
        requestId: "req-123",
      });
    });

    it("calls extract without selector when none provided", async () => {
      mockExtract.mockResolvedValue({
        ok: true,
        article: {
          title: "Test",
          author: null,
          publicationDate: null,
          sourceUrl: "https://example.com",
          siteName: "Example",
          bodyMarkdown: "Content",
          bodyCharacterCount: 7,
        },
        confidence: "medium",
      });

      await loadModule();

      const msg = buildMessage("extractRequested", {
        tabId: 1,
      });

      const result = await registeredListener!(msg) as MessageOf<"extractResult">;

      expect(mockExtract).toHaveBeenCalledWith({
        contentSelector: undefined,
      });
      expect(result.payload.ok).toBe(true);
      if (result.payload.ok) {
        expect(result.payload.confidence).toBe("medium");
      }
    });

    it("returns failure result when extraction fails", async () => {
      mockExtract.mockResolvedValue({
        ok: false,
        reason: "no-content-detected",
        detail: "Readability detected no suitable content on the page",
      });

      await loadModule();

      const msg = buildMessage("extractRequested", {
        tabId: 2,
        selector: ".missing",
      }, "req-456");

      const result = await registeredListener!(msg) as MessageOf<"extractResult">;

      expect(result).toEqual({
        kind: "extractResult",
        payload: {
          ok: false,
          reason: "no-content-detected",
          detail: "Readability detected no suitable content on the page",
        },
        requestId: "req-456",
      });
    });
  });

  describe("pickerActivate handling", () => {
    it("returns pickerResult with selector on successful pick", async () => {
      const mockPick = vi.fn().mockResolvedValue({ selector: ".main-content", previewText: "Hello world" });
      mockCreateElementPicker.mockReturnValue({ pick: mockPick, cancel: vi.fn() });

      await loadModule();

      const msg = buildMessage("pickerActivate", {
        tabId: 3,
      }, "req-789");

      const result = await registeredListener!(msg) as MessageOf<"pickerResult">;

      expect(mockCreateElementPicker).toHaveBeenCalled();
      expect(mockPick).toHaveBeenCalled();
      expect(result).toEqual({
        kind: "pickerResult",
        payload: {
          ok: true,
          selector: ".main-content",
          previewText: "Hello world",
        },
        requestId: "req-789",
      });
    });

    it("returns pickerResult with failure when user cancels", async () => {
      const mockPick = vi.fn().mockResolvedValue(null);
      mockCreateElementPicker.mockReturnValue({ pick: mockPick, cancel: vi.fn() });

      await loadModule();

      const msg = buildMessage("pickerActivate", {
        tabId: 3,
      }, "req-790");

      const result = await registeredListener!(msg) as MessageOf<"pickerResult">;

      expect(result).toEqual({
        kind: "pickerResult",
        payload: {
          ok: false,
          reason: "Selection cancelled",
        },
        requestId: "req-790",
      });
    });
  });

  describe("invalid message handling", () => {
    it("returns undefined for null messages", async () => {
      await loadModule();
      const result = registeredListener!(null);
      expect(result).toBeUndefined();
    });

    it("returns undefined for non-object messages", async () => {
      await loadModule();
      expect(registeredListener!("hello")).toBeUndefined();
      expect(registeredListener!(42)).toBeUndefined();
      expect(registeredListener!(true)).toBeUndefined();
    });

    it("returns undefined for objects without kind", async () => {
      await loadModule();
      const result = registeredListener!({ payload: {} });
      expect(result).toBeUndefined();
    });

    it("returns undefined for objects without payload", async () => {
      await loadModule();
      const result = registeredListener!({ kind: "extractRequested" });
      expect(result).toBeUndefined();
    });

    it("returns undefined for unrecognized message kinds", async () => {
      await loadModule();
      const result = registeredListener!({ kind: "unknownKind", payload: {} });
      expect(result).toBeUndefined();
    });

    it("returns undefined for messages from other contexts (e.g. settingsChanged)", async () => {
      await loadModule();
      const msg = buildMessage("settingsChanged", {
        schemaVersion: 1,
        ai: { baseUrl: "", modelId: "", apiKeyRef: null, systemPrompt: "" },
        export: { filenamePattern: "", defaultDestination: { kind: "download" }, frontmatterFields: [] },
        sitePatterns: [],
        autoExportConfigs: [],
      });
      const result = registeredListener!(msg);
      expect(result).toBeUndefined();
    });
  });
});

describe("CF-6.5 selectorPreview handling", () => {
  async function loadModule() {
    await import("./main");
  }

  it("returns the matched element's text (trimmed to 500 chars)", async () => {
    await loadModule();
    document.body.innerHTML = '<main id="content">  Hello preview world  </main>';

    const response = await registeredListener!(
      buildMessage("selectorPreview", { selector: "#content" }),
    );

    expect(response).toMatchObject({
      kind: "selectorPreviewResult",
      payload: { ok: true, text: "Hello preview world" },
    });
  });

  it("caps the preview text at 500 characters", async () => {
    await loadModule();
    document.body.innerHTML = `<div id="long">${"x".repeat(2000)}</div>`;

    const response = (await registeredListener!(
      buildMessage("selectorPreview", { selector: "#long" }),
    )) as MessageOf<"selectorPreviewResult">;

    expect(response.payload.ok).toBe(true);
    expect(response.payload.text).toHaveLength(500);
  });

  it("reports when the selector matches nothing", async () => {
    await loadModule();
    document.body.innerHTML = "<p>content</p>";

    const response = (await registeredListener!(
      buildMessage("selectorPreview", { selector: "#does-not-exist" }),
    )) as MessageOf<"selectorPreviewResult">;

    expect(response.payload.ok).toBe(false);
  });

  it("reports invalid selector syntax instead of throwing", async () => {
    await loadModule();

    const response = (await registeredListener!(
      buildMessage("selectorPreview", { selector: "!!not-a-selector((" }),
    )) as MessageOf<"selectorPreviewResult">;

    expect(response.payload.ok).toBe(false);
  });
});
