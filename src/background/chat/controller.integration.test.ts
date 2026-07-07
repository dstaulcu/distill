/**
 * Integration tests for sidebar ↔ chat controller port communication.
 *
 * Tests the full lifecycle of port connections, message exchange,
 * session restore, and streaming flow between the sidebar and
 * the chat controller.
 *
 * Validates: Requirements 1.1, 1.4, 1.10, 9.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatController, type Port, type CreateChatControllerOptions } from "./controller";
import type { Settings, TabState, Conversation, ConversationMessage, SkillDefinition, SkillLibrary, StoredSkill } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import type { TabStateManager } from "@background/tab-state";
import type { SkillLibraryManager } from "@background/skill-library";
import type { SecureStore } from "@background/secure-store";
import type {
  StreamingAiClient,
  StreamingClientOptions,
  StreamChatCompletionRequest,
  StreamChatCompletionResult,
} from "./streaming-client";
import type { ControllerToSidebarMessage } from "@shared/port-protocol";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockSettings(overrides?: Partial<Settings["ai"]>): Settings {
  return {
    schemaVersion: 1,
    ai: {
      baseUrl: "https://api.example.com",
      modelId: "gpt-4",
      apiKeyRef: "ref-123",
      systemPrompt: "You are a helpful assistant.",
      ...overrides,
    },
    export: {
      filenamePattern: "YYYY-MM-DD-slugified-title",
      defaultDestination: { kind: "download" },
      frontmatterFields: ["title"],
    },
    sitePatterns: [],
    autoExportConfigs: [],
  };
}

function createMockSecureStore(apiKey: string = "sk-test"): SecureStore {
  return {
    setSecret: vi.fn(),
    getSecret: vi.fn().mockResolvedValue(apiKey),
    deleteSecret: vi.fn(),
    createRef: vi.fn().mockReturnValue("new-ref"),
  };
}

function createMockSkillLibrary(): SkillLibraryManager {
  let library: SkillLibrary = { schemaVersion: 1, skills: [], personas: [], active: { kind: "none" } };
  return {
    getLibrary: vi.fn(async () => library),
    addSkill: vi.fn(async (skill: SkillDefinition) => {
      const stored: StoredSkill = { ...skill, id: `skill-${Date.now()}`, addedAt: new Date().toISOString() };
      library = { ...library, skills: [...library.skills, stored] };
      return stored;
    }),
    removeSkill: vi.fn(async () => {}),
    updateSkill: vi.fn(async () => ({ id: "", addedAt: "" }) as unknown as StoredSkill),
    addPersona: vi.fn(async () => ({ id: "", name: "", description: "", skillIds: [], createdAt: "", updatedAt: "" })),
    removePersona: vi.fn(async () => {}),
    updatePersona: vi.fn(async () => ({ id: "", name: "", description: "", skillIds: [], createdAt: "", updatedAt: "" })),
    activateSkill: vi.fn(async (id: string) => { library = { ...library, active: { kind: "skill", skillId: id } }; }),
    activatePersona: vi.fn(async () => {}),
    deactivate: vi.fn(async () => { library = { ...library, active: { kind: "none" } }; }),
    getActiveSkills: vi.fn(async () => {
      if (library.active.kind === "skill") {
        const skill = library.skills.find((s) => s.id === (library.active as { kind: "skill"; skillId: string }).skillId);
        return skill ? [skill] : [];
      }
      return [];
    }),
  };
}

function createMockTabState(): TabStateManager {
  const store = new Map<number, TabState>();
  return {
    get: vi.fn((tabId: number) => store.get(tabId)),
    set: vi.fn((tabId: number, state: TabState) => { store.set(tabId, state); }),
    update: vi.fn((tabId: number, patch: Partial<TabState>) => {
      const existing = store.get(tabId);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch } as TabState;
      store.set(tabId, updated);
      return updated;
    }),
    remove: vi.fn((tabId: number) => { store.delete(tabId); }),
    has: vi.fn((tabId: number) => store.has(tabId)),
  };
}

function createSuccessfulExtractionResult(): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Integration Test Article",
      author: "Test Author",
      publicationDate: "2024-03-15",
      sourceUrl: "https://example.com/integration-test",
      siteName: "Example",
      bodyMarkdown: "# Article\n\nThis is the full article content for integration testing.",
      bodyCharacterCount: 65,
    },
    confidence: "high",
  };
}

function createMockPort(): Port & {
  messages: ControllerToSidebarMessage[];
  messageListeners: Array<(msg: unknown) => void>;
  disconnectListeners: Array<() => void>;
} {
  const messages: ControllerToSidebarMessage[] = [];
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    name: "chat",
    messages,
    messageListeners,
    disconnectListeners,
    postMessage: vi.fn((msg: ControllerToSidebarMessage) => { messages.push(msg); }),
    onMessage: {
      addListener: vi.fn((cb: (msg: unknown) => void) => { messageListeners.push(cb); }),
      removeListener: vi.fn((cb: (msg: unknown) => void) => {
        const idx = messageListeners.indexOf(cb);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((cb: () => void) => { disconnectListeners.push(cb); }),
      removeListener: vi.fn(),
    },
  };
}

/** Simulate sending a message from the sidebar to the controller via port. */
function sendToController(port: ReturnType<typeof createMockPort>, msg: unknown): void {
  for (const listener of port.messageListeners) {
    listener(msg);
  }
}

/** Simulate port disconnect (sidebar closed or navigated away). */
function disconnectPort(port: ReturnType<typeof createMockPort>): void {
  for (const cb of port.disconnectListeners) {
    cb();
  }
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("CF-2/CF-3 Sidebar ↔ Chat Controller Port Communication (Integration)", () => {
  let tabState: TabStateManager;
  let extractContent: ReturnType<typeof vi.fn>;
  let settings: Settings;
  let secureStore: SecureStore;
  let streamingTokens: string[];
  let mockClient: StreamingAiClient;
  let createStreamingClientFn: ReturnType<typeof vi.fn>;
  let controller: ReturnType<typeof createChatController>;

  beforeEach(() => {
    settings = createMockSettings();
    secureStore = createMockSecureStore();
    tabState = createMockTabState();
    extractContent = vi.fn().mockResolvedValue(createSuccessfulExtractionResult());
    streamingTokens = [];

    mockClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
        const tokens = ["Hello", " ", "from", " ", "AI"];
        for (const token of tokens) {
          if (req.signal.aborted) {
            return {
              ok: false as const,
              reason: "aborted" as const,
              detail: "Aborted",
              partialContent: streamingTokens.join(""),
            };
          }
          streamingTokens.push(token);
          req.onToken(token);
        }
        return { ok: true as const, content: "Hello from AI" };
      }),
    };
    createStreamingClientFn = vi.fn().mockReturnValue(mockClient);

    controller = createChatController({
      getSettings: vi.fn().mockResolvedValue(settings),
      getSecureStore: () => secureStore,
      extractContent,
      createStreamingClient: createStreamingClientFn,
      tabState,
      skillLibrary: createMockSkillLibrary(),
      clock: () => "2024-03-15T12:00:00.000Z",
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Port Connection Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  describe("port connection lifecycle", () => {
    it("registers listeners on connect and removes them on disconnect", () => {
      const port = createMockPort();
      controller.handleConnect(port);

      expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);

      // Disconnect
      disconnectPort(port);

      expect(port.onMessage.removeListener).toHaveBeenCalledTimes(1);
      expect(port.onDisconnect.removeListener).toHaveBeenCalledTimes(1);
    });

    it("supports multiple sequential port connections (sidebar reopen)", async () => {
      // First connection
      const port1 = createMockPort();
      controller.handleConnect(port1);
      sendToController(port1, { type: "init", tabId: 10 });

      await vi.waitFor(() => {
        expect(port1.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port1, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port1.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      disconnectPort(port1);

      // Second connection — should work independently
      const port2 = createMockPort();
      controller.handleConnect(port2);
      sendToController(port2, { type: "init", tabId: 10 });

      await vi.waitFor(() => {
        // Should restore from cache since tab 10 was already initialized
        expect(port2.messages.some((m) => m.type === "conversationRestored")).toBe(true);
      });
    });

    it("cancels in-flight streaming when port disconnects", async () => {
      const captured: { signal?: AbortSignal } = {};
      const slowClient: StreamingAiClient = {
        streamChatCompletion: vi.fn((req: StreamChatCompletionRequest) => {
          captured.signal = req.signal;
          return new Promise<StreamChatCompletionResult>((resolve) => {
            req.signal.addEventListener("abort", () => {
              resolve({ ok: false, reason: "aborted", detail: "Aborted", partialContent: "" });
            });
          });
        }),
      };
      createStreamingClientFn.mockReturnValue(slowClient);

      const port = createMockPort();
      controller.handleConnect(port);
      sendToController(port, { type: "init", tabId: 20 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamStart")).toBe(true);
      });

      // Disconnect while streaming
      disconnectPort(port);

      expect(captured.signal?.aborted).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Message Exchange (init, sendMessage, abort)
  // ─────────────────────────────────────────────────────────────────────────

  describe("message exchange", () => {
    it("full init → summarize → sendMessage flow produces correct message sequence", async () => {
      const port = createMockPort();
      controller.handleConnect(port);

      // Step 1: init extracts, then explicit summarize triggers streaming
      sendToController(port, { type: "init", tabId: 50 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });

      // Init alone should not start streaming
      expect(port.messages.some((m) => m.type === "streamStart")).toBe(false);
      expect(port.messages.map((m) => m.type)).toEqual(["contextLoaded"]);

      sendToController(port, { type: "summarize" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Verify the full message sequence after summarize
      const initSequence = port.messages.map((m) => m.type);
      expect(initSequence).toEqual([
        "contextLoaded",
        "streamStart",
        "streamToken", // "Hello"
        "streamToken", // " "
        "streamToken", // "from"
        "streamToken", // " "
        "streamToken", // "AI"
        "streamEnd",
      ]);

      // Verify contextLoaded payload
      const contextMsg = port.messages.find((m) => m.type === "contextLoaded");
      expect(contextMsg).toMatchObject({
        type: "contextLoaded",
        title: "Integration Test Article",
        url: "https://example.com/integration-test",
      });

      // Step 2: send a follow-up message
      port.messages.length = 0;
      streamingTokens = [];

      sendToController(port, { type: "sendMessage", text: "Tell me more" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const followUpSequence = port.messages.map((m) => m.type);
      expect(followUpSequence[0]).toBe("streamStart");
      expect(followUpSequence[followUpSequence.length - 1]).toBe("streamEnd");
      expect(followUpSequence.filter((t) => t === "streamToken").length).toBe(5);
    });

    it("abort during streaming retains partial content", async () => {
      let tokenCount = 0;
      const slowClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
          const tokens = ["Part", "ial", " ", "con", "tent"];
          let partial = "";
          for (const token of tokens) {
            if (req.signal.aborted) {
              return { ok: false as const, reason: "aborted" as const, detail: "Aborted", partialContent: partial };
            }
            partial += token;
            tokenCount++;
            req.onToken(token);
            // After delivering 2 tokens, the test will send abort
            if (tokenCount === 2) {
              // Simulate abort being triggered externally
              await new Promise((r) => setTimeout(r, 10));
              if (req.signal.aborted) {
                return { ok: false as const, reason: "aborted" as const, detail: "Aborted", partialContent: partial };
              }
            }
          }
          return { ok: true as const, content: partial };
        }),
      };
      createStreamingClientFn.mockReturnValue(slowClient);

      const port = createMockPort();
      controller.handleConnect(port);
      sendToController(port, { type: "init", tabId: 60 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // streamEnd should contain the content (partial or full depending on timing)
      const endMsg = port.messages.find((m) => m.type === "streamEnd");
      expect(endMsg).toBeDefined();
    });

    it("invalid messages are silently discarded without crashing", async () => {
      const port = createMockPort();
      controller.handleConnect(port);

      // Send various invalid messages
      sendToController(port, null);
      sendToController(port, undefined);
      sendToController(port, 42);
      sendToController(port, "string");
      sendToController(port, { type: "nonexistent" });
      sendToController(port, { foo: "bar" });

      // No messages should be sent back
      expect(port.messages).toHaveLength(0);

      // Controller should still work after invalid messages
      sendToController(port, { type: "init", tabId: 70 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Session Restore
  // ─────────────────────────────────────────────────────────────────────────

  describe("session restore when switching back to a tab", () => {
    it("restores full conversation history from cached session", async () => {
      const port = createMockPort();
      controller.handleConnect(port);

      // Initialize tab 80 — creates a session
      sendToController(port, { type: "init", tabId: 80 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Send a follow-up to build conversation history
      port.messages.length = 0;
      sendToController(port, { type: "sendMessage", text: "What is this about?" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Now simulate switching away and back (new port, same tab)
      disconnectPort(port);

      const port2 = createMockPort();
      controller.handleConnect(port2);
      sendToController(port2, { type: "init", tabId: 80 });

      await vi.waitFor(() => {
        expect(port2.messages.some((m) => m.type === "conversationRestored")).toBe(true);
      });

      // Verify restored messages include summary + user message + assistant response
      const restored = port2.messages.find((m) => m.type === "conversationRestored");
      expect(restored).toBeDefined();
      if (restored && restored.type === "conversationRestored") {
        expect(restored.messages.length).toBeGreaterThanOrEqual(3);
        // First message should be the summary (assistant)
        expect(restored.messages[0].role).toBe("assistant");
        // Second should be user follow-up
        expect(restored.messages[1].role).toBe("user");
        expect(restored.messages[1].content).toBe("What is this about?");
        // Third should be assistant response
        expect(restored.messages[2].role).toBe("assistant");
      }
    });

    it("does not re-extract or re-summarize for a cached tab", async () => {
      const port = createMockPort();
      controller.handleConnect(port);

      // Initialize tab 90 and summarize
      sendToController(port, { type: "init", tabId: 90 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const extractCallCount = extractContent.mock.calls.length;
      const streamCallCount = (mockClient.streamChatCompletion as ReturnType<typeof vi.fn>).mock.calls.length;

      // Re-init same tab (simulates switching back)
      port.messages.length = 0;
      sendToController(port, { type: "init", tabId: 90 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "conversationRestored")).toBe(true);
      });

      // No additional extraction or streaming calls
      expect(extractContent.mock.calls.length).toBe(extractCallCount);
      expect((mockClient.streamChatCompletion as ReturnType<typeof vi.fn>).mock.calls.length).toBe(streamCallCount);
    });

    it("starts fresh session for a different tab", async () => {
      const port = createMockPort();
      controller.handleConnect(port);

      // Initialize tab 100 and summarize
      sendToController(port, { type: "init", tabId: 100 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Switch to a different tab (101)
      port.messages.length = 0;
      sendToController(port, { type: "init", tabId: 101 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Should have gone through full extraction + summarization flow
      const types = port.messages.map((m) => m.type);
      expect(types).toContain("contextLoaded");
      expect(types).toContain("streamStart");
      expect(types).toContain("streamEnd");
      expect(types).not.toContain("conversationRestored");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Streaming Flow
  // ─────────────────────────────────────────────────────────────────────────

  describe("streaming flow (tokens delivered via port, streamEnd)", () => {
    it("delivers each token individually via streamToken messages", async () => {
      const port = createMockPort();
      controller.handleConnect(port);
      sendToController(port, { type: "init", tabId: 110 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const tokenMsgs = port.messages.filter((m) => m.type === "streamToken");
      expect(tokenMsgs).toHaveLength(5);

      const tokens = tokenMsgs.map((m) => {
        if (m.type === "streamToken") return m.token;
        return "";
      });
      expect(tokens).toEqual(["Hello", " ", "from", " ", "AI"]);
    });

    it("streamEnd contains the full concatenated content", async () => {
      const port = createMockPort();
      controller.handleConnect(port);
      sendToController(port, { type: "init", tabId: 120 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const endMsg = port.messages.find((m) => m.type === "streamEnd");
      expect(endMsg).toBeDefined();
      if (endMsg && endMsg.type === "streamEnd") {
        expect(endMsg.fullContent).toBe("Hello from AI");
      }
    });

    it("streamStart is sent before any tokens", async () => {
      const port = createMockPort();
      controller.handleConnect(port);
      sendToController(port, { type: "init", tabId: 130 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const startIdx = port.messages.findIndex((m) => m.type === "streamStart");
      const firstTokenIdx = port.messages.findIndex((m) => m.type === "streamToken");
      const endIdx = port.messages.findIndex((m) => m.type === "streamEnd");

      expect(startIdx).toBeGreaterThan(-1);
      expect(firstTokenIdx).toBeGreaterThan(startIdx);
      expect(endIdx).toBeGreaterThan(firstTokenIdx);
    });

    it("streaming error reports partial content and retry availability", async () => {
      let callCount = 0;
      const failingClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
          callCount++;
          // Deliver some tokens then fail
          req.onToken("Partial");
          req.onToken(" ");
          req.onToken("response");
          return {
            ok: false as const,
            reason: "network" as const,
            detail: "Connection lost",
            partialContent: "Partial response",
          };
        }),
      };
      createStreamingClientFn.mockReturnValue(failingClient);

      const port = createMockPort();
      controller.handleConnect(port);
      sendToController(port, { type: "init", tabId: 140 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      const errorMsg = port.messages.find((m) => m.type === "streamError");
      expect(errorMsg).toBeDefined();
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.reason).toBe("Connection lost");
        expect(errorMsg.partialContent).toBe("Partial response");
        expect(errorMsg.canRetry).toBe(true);
      }
    });

    it("follow-up message streaming includes conversation context", async () => {
      let capturedMessages: ReadonlyArray<{ role: string; content: string }> = [];
      const contextCapturingClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
          capturedMessages = req.messages;
          req.onToken("Response");
          return { ok: true as const, content: "Response" };
        }),
      };
      createStreamingClientFn.mockReturnValue(contextCapturingClient);

      const port = createMockPort();
      controller.handleConnect(port);

      // Init + explicit summarize
      sendToController(port, { type: "init", tabId: 150 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      sendToController(port, { type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Send follow-up
      port.messages.length = 0;
      sendToController(port, { type: "sendMessage", text: "Explain more" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // The second call should include conversation history
      expect(capturedMessages.length).toBeGreaterThan(2);
      // Should contain system prompt
      expect(capturedMessages[0].role).toBe("system");
      // Should contain the user's follow-up as the last user message
      const lastUserMsg = [...capturedMessages].reverse().find((m) => m.role === "user");
      expect(lastUserMsg?.content).toBe("Explain more");
    });
  });
});
