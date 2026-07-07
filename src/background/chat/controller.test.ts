import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatController, type Port, type CreateChatControllerOptions } from "./controller";
import type { Settings, TabState, Conversation, SkillDefinition, SkillLibrary, StoredSkill } from "@shared/types";
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

function createSuccessfulExtractionResult(): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Test Article",
      author: "Author",
      publicationDate: "2024-01-01",
      sourceUrl: "https://example.com/article",
      siteName: "Example",
      bodyMarkdown: "This is the article content.",
      bodyCharacterCount: 27,
    },
    confidence: "high",
  };
}

function createMockStreamingClient(
  result?: StreamChatCompletionResult,
  onCall?: (req: StreamChatCompletionRequest) => void,
): StreamingAiClient {
  const defaultResult: StreamChatCompletionResult = {
    ok: true,
    content: "Summary content here.",
  };
  return {
    streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
      onCall?.(req);
      // Simulate token delivery
      const r = result ?? defaultResult;
      if (r.ok) {
        for (const char of r.content) {
          req.onToken(char);
        }
      }
      return r;
    }),
  };
}

function createMockPort(): Port & { messages: ControllerToSidebarMessage[]; messageListeners: Array<(msg: unknown) => void>; disconnectListeners: Array<() => void> } {
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

interface TestContext {
  controller: ReturnType<typeof createChatController>;
  port: ReturnType<typeof createMockPort>;
  tabState: TabStateManager;
  skillLibrary: SkillLibraryManager;
  settings: Settings;
  secureStore: SecureStore;
  extractContent: ReturnType<typeof vi.fn>;
  mockClient: StreamingAiClient;
  createStreamingClient: ReturnType<typeof vi.fn>;
  clock: () => string;
}

function setup(overrides?: {
  settings?: Settings;
  extractionResult?: ExtractionResult;
  streamResult?: StreamChatCompletionResult;
  onStreamCall?: (req: StreamChatCompletionRequest) => void;
}): TestContext {
  const settings = overrides?.settings ?? createMockSettings();
  const secureStore = createMockSecureStore();
  const tabState = createMockTabState();
  const skillLibrary = createMockSkillLibrary();
  const extractContent = vi.fn().mockResolvedValue(
    overrides?.extractionResult ?? createSuccessfulExtractionResult(),
  );
  const mockClient = createMockStreamingClient(overrides?.streamResult, overrides?.onStreamCall);
  const createStreamingClientFn = vi.fn().mockReturnValue(mockClient);
  const clock = () => "2024-01-15T10:00:00.000Z";

  const opts: CreateChatControllerOptions = {
    getSettings: vi.fn().mockResolvedValue(settings),
    getSecureStore: () => secureStore,
    extractContent,
    createStreamingClient: createStreamingClientFn,
    tabState,
    skillLibrary,
    clock,
  };

  const controller = createChatController(opts);
  const port = createMockPort();

  return {
    controller,
    port,
    tabState,
    skillLibrary,
    settings,
    secureStore,
    extractContent,
    mockClient,
    createStreamingClient: createStreamingClientFn,
    clock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-2/CF-3 createChatController", () => {
  describe("handleConnect", () => {
    it("registers message and disconnect listeners on the port", () => {
      const { controller, port } = setup();
      controller.handleConnect(port);

      expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("init message", () => {
    it("extracts content and sends contextLoaded; summarize triggers streaming", async () => {
      const { controller, port, extractContent } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(extractContent).toHaveBeenCalledWith(42);
      });

      // Init should produce contextLoaded but NOT start streaming
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      expect(port.messages.some((m) => m.type === "streamStart")).toBe(false);

      // Summarization is user-triggered
      listener({ type: "summarize" });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("streamStart");
        expect(types).toContain("streamEnd");
      });
    });

    it("restores cached session when tab state exists", async () => {
      const { controller, port, tabState } = setup();

      // Pre-populate tab state
      const existingState: TabState = {
        url: "https://example.com/page",
        title: "Cached Page",
        summary: "Cached summary",
        conversation: {
          tabId: 42,
          url: "https://example.com/page",
          title: "Cached Page",
          messages: [
            { role: "assistant", content: "Cached summary", timestamp: "2024-01-15T09:00:00.000Z" },
          ],
          createdAt: "2024-01-15T09:00:00.000Z",
          updatedAt: "2024-01-15T09:00:00.000Z",
        },
        extractionConfidence: "high",
        consecutiveFailures: 0,
      };
      tabState.set(42, existingState);

      controller.handleConnect(port);
      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("conversationRestored");
        expect(types).not.toContain("contextLoaded");
      });

      const restored = port.messages.find((m) => m.type === "conversationRestored");
      expect(restored).toBeDefined();
      if (restored && restored.type === "conversationRestored") {
        expect(restored.messages).toHaveLength(1);
        expect(restored.messages[0].content).toBe("Cached summary");
      }
    });

    it("sends configError when AI endpoint is not configured", async () => {
      const { controller, port } = setup({
        settings: createMockSettings({ baseUrl: "", modelId: "" }),
      });
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("configError");
      });
    });

    it("sends contextError when extraction fails", async () => {
      const { controller, port } = setup({
        extractionResult: {
          ok: false,
          reason: "no-content-detected",
          detail: "No content found on page",
        },
      });
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("contextError");
      });

      const errorMsg = port.messages.find((m) => m.type === "contextError");
      if (errorMsg && errorMsg.type === "contextError") {
        expect(errorMsg.canRetry).toBe(true);
      }
    });

    it("sends contextError when extraction throws", async () => {
      const { controller, port, extractContent } = setup();
      extractContent.mockRejectedValue(new Error("Timeout"));
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        const errorMsg = port.messages.find((m) => m.type === "contextError");
        expect(errorMsg).toBeDefined();
        if (errorMsg && errorMsg.type === "contextError") {
          expect(errorMsg.reason).toBe("Timeout");
          expect(errorMsg.canRetry).toBe(true);
        }
      });
    });

    it("sends streamError when summarization fails", async () => {
      const { controller, port } = setup({
        streamResult: {
          ok: false,
          reason: "network",
          detail: "Connection refused",
          partialContent: "Partial",
        },
      });
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("streamError");
      });

      const errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.reason).toBe("Connection refused");
        expect(errorMsg.partialContent).toBe("Partial");
        expect(errorMsg.canRetry).toBe(true);
      }
    });
  });

  describe("sendMessage", () => {
    it("streams a response with conversation context", async () => {
      const { controller, port, tabState, mockClient } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Clear messages
      port.messages.length = 0;

      // Send a follow-up message
      listener({ type: "sendMessage", text: "What is the main point?" });

      await vi.waitFor(() => {
        const types = port.messages.map((m) => m.type);
        expect(types).toContain("streamStart");
        expect(types).toContain("streamEnd");
      });

      // Verify the streaming client was called with conversation context
      expect(mockClient.streamChatCompletion).toHaveBeenCalledTimes(2);
    });

    it("sends configError when AI is not configured during sendMessage", async () => {
      const settings = createMockSettings({ baseUrl: "", modelId: "" });
      const { controller, port, tabState } = setup({ settings });

      // Manually set up tab state to bypass init
      tabState.set(42, {
        url: "https://example.com",
        title: "Test",
        summary: "Summary",
        conversation: {
          tabId: 42, url: "https://example.com", title: "Test",
          messages: [], createdAt: "2024-01-01", updatedAt: "2024-01-01",
        },
        extractionConfidence: "high",
        consecutiveFailures: 0,
      });

      controller.handleConnect(port);
      const listener = port.messageListeners[0];

      // Restore session first
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "conversationRestored")).toBe(true);
      });

      port.messages.length = 0;
      listener({ type: "sendMessage", text: "Hello" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "configError")).toBe(true);
      });
    });
  });

  describe("abort", () => {
    it("cancels in-flight request and retains partial content", async () => {
      let capturedReq: StreamChatCompletionRequest | null = null;
      const { controller, port } = setup({
        streamResult: {
          ok: false,
          reason: "aborted",
          detail: "Request was aborted",
          partialContent: "Partial summary",
        },
        onStreamCall: (req) => { capturedReq = req; },
      });

      controller.handleConnect(port);
      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // The aborted result sends streamEnd with partial content
      const endMsg = port.messages.find((m) => m.type === "streamEnd");
      if (endMsg && endMsg.type === "streamEnd") {
        expect(endMsg.fullContent).toBe("Partial summary");
      }
    });

    it("abort message triggers abort on the controller", async () => {
      // We need a streaming client that doesn't resolve immediately
      let resolveStream: ((result: StreamChatCompletionResult) => void) | null = null;
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn((req: StreamChatCompletionRequest) => {
          return new Promise<StreamChatCompletionResult>((resolve) => {
            resolveStream = resolve;
            // Listen for abort
            req.signal.addEventListener("abort", () => {
              resolve({
                ok: false,
                reason: "aborted",
                detail: "Aborted",
                partialContent: "partial",
              });
            });
          });
        }),
      };

      const tabState = createMockTabState();
      const extractContent = vi.fn().mockResolvedValue(createSuccessfulExtractionResult());
      const settings = createMockSettings();

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(settings),
        getSecureStore: () => createMockSecureStore(),
        extractContent,
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState,
        skillLibrary: createMockSkillLibrary(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      // Wait for streaming to start
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamStart")).toBe(true);
      });

      // Send abort
      listener({ type: "abort" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });
    });
  });

  describe("retry", () => {
    it("re-sends the last failed user message on retry", async () => {
      let callCount = 0;
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
          callCount++;
          if (callCount <= 2) {
            // First two calls: explicit summarize (success) + sendMessage (fail)
            if (callCount === 1) {
              req.onToken("Summary");
              return { ok: true, content: "Summary" };
            }
            return {
              ok: false,
              reason: "network",
              detail: "Connection failed",
              partialContent: "",
            };
          }
          // Third call: retry succeeds
          req.onToken("Retry response");
          return { ok: true, content: "Retry response" };
        }),
      };

      const tabState = createMockTabState();
      const settings = createMockSettings();

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(settings),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState,
        skillLibrary: createMockSkillLibrary(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);
      const listener = port.messageListeners[0];

      // Init + explicit summarize
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      port.messages.length = 0;

      // Send message that fails
      listener({ type: "sendMessage", text: "Hello" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      port.messages.length = 0;

      // Retry
      listener({ type: "retry" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const endMsg = port.messages.find((m) => m.type === "streamEnd");
      if (endMsg && endMsg.type === "streamEnd") {
        expect(endMsg.fullContent).toBe("Retry response");
      }
    });

    it("disables retry after 3 consecutive failures", async () => {
      let callCount = 0;
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
          callCount++;
          if (callCount === 1) {
            // Summarization succeeds
            req.onToken("Summary");
            return { ok: true, content: "Summary" };
          }
          // All subsequent calls fail
          return {
            ok: false,
            reason: "network",
            detail: "Connection failed",
            partialContent: "",
          };
        }),
      };

      const tabState = createMockTabState();
      const settings = createMockSettings();

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(settings),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState,
        skillLibrary: createMockSkillLibrary(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);
      const listener = port.messageListeners[0];

      // Init + explicit summarize (succeeds)
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });
      port.messages.length = 0;

      // Send message that fails (failure 1)
      listener({ type: "sendMessage", text: "Hello" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      let errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.canRetry).toBe(true);
      }
      port.messages.length = 0;

      // Retry (failure 2)
      listener({ type: "retry" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.canRetry).toBe(true);
      }
      port.messages.length = 0;

      // Retry (failure 3)
      listener({ type: "retry" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
      });

      errorMsg = port.messages.find((m) => m.type === "streamError");
      if (errorMsg && errorMsg.type === "streamError") {
        expect(errorMsg.canRetry).toBe(false);
      }
      port.messages.length = 0;

      // Retry should be a no-op now (failures >= 3)
      listener({ type: "retry" });
      // Give it a moment to potentially process
      await new Promise((r) => setTimeout(r, 50));
      expect(port.messages).toHaveLength(0);
    });
  });

  describe("session management", () => {
    it("stores tab state after successful summarization", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      expect(tabState.set).toHaveBeenCalled();
      const state = tabState.get(42);
      expect(state).toBeDefined();
      expect(state?.url).toBe("https://example.com/article");
      expect(state?.title).toBe("Test Article");
    });

    it("records user and assistant messages in conversation", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      port.messages.length = 0;
      listener({ type: "sendMessage", text: "What is this about?" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const state = tabState.get(42);
      expect(state).toBeDefined();
      // Should have: summary (assistant) + user message + assistant response
      expect(state!.conversation.messages.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("port disconnect", () => {
    it("cancels in-flight request on disconnect", async () => {
      let resolveStream: ((result: StreamChatCompletionResult) => void) | null = null;
      const captured: { signal?: AbortSignal } = {};

      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn((req: StreamChatCompletionRequest) => {
          captured.signal = req.signal;
          return new Promise<StreamChatCompletionResult>((resolve) => {
            resolveStream = resolve;
            req.signal.addEventListener("abort", () => {
              resolve({
                ok: false,
                reason: "aborted",
                detail: "Aborted",
                partialContent: "",
              });
            });
          });
        }),
      };

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(createMockSettings()),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState: createMockTabState(),
        skillLibrary: createMockSkillLibrary(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      // Wait for streaming to start
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamStart")).toBe(true);
      });

      // Disconnect
      port.disconnectListeners[0]();

      // The abort signal should have been triggered
      expect(captured.signal?.aborted).toBe(true);
    });
  });

  describe("message validation", () => {
    it("ignores invalid messages", async () => {
      const { controller, port } = setup();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];

      // Send invalid messages
      listener(null);
      listener(undefined);
      listener({ type: "unknown" });
      listener("not an object");
      listener(42);

      // No messages should be sent to the port
      expect(port.messages).toHaveLength(0);
    });
  });

  describe("streaming token delivery", () => {
    it("delivers tokens incrementally during summarization", async () => {
      const mockClient: StreamingAiClient = {
        streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
          req.onToken("Hello");
          req.onToken(" ");
          req.onToken("world");
          return { ok: true, content: "Hello world" };
        }),
      };

      const controller = createChatController({
        getSettings: vi.fn().mockResolvedValue(createMockSettings()),
        getSecureStore: () => createMockSecureStore(),
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: vi.fn().mockReturnValue(mockClient),
        tabState: createMockTabState(),
        skillLibrary: createMockSkillLibrary(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const port = createMockPort();
      controller.handleConnect(port);

      const listener = port.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      const tokenMessages = port.messages.filter((m) => m.type === "streamToken");
      expect(tokenMessages.length).toBe(3);
      expect(tokenMessages.map((m) => m.type === "streamToken" && (m as any).token)).toEqual([
        "Hello", " ", "world",
      ]);
    });
  });

  describe("API key retrieval", () => {
    it("retrieves API key from secure store using apiKeyRef", async () => {
      const secureStore = createMockSecureStore("sk-real-key");
      const { controller, port, createStreamingClient: csClient } = setup();

      // Override the controller with our custom secure store
      const customController = createChatController({
        getSettings: vi.fn().mockResolvedValue(createMockSettings()),
        getSecureStore: () => secureStore,
        extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
        createStreamingClient: csClient,
        tabState: createMockTabState(),
        skillLibrary: createMockSkillLibrary(),
        clock: () => "2024-01-15T10:00:00.000Z",
      });

      const customPort = createMockPort();
      customController.handleConnect(customPort);

      const listener = customPort.messageListeners[0];
      listener({ type: "init", tabId: 42 });
      await vi.waitFor(() => {
        expect(customPort.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      listener({ type: "summarize" });

      await vi.waitFor(() => {
        expect(secureStore.getSecret).toHaveBeenCalledWith("ref-123");
      });

      await vi.waitFor(() => {
        expect(csClient).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: "sk-real-key" }),
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// CF-3.2 / CF-3.3 retry semantics (Q6 decision) and SF-1 cached confidence
// ---------------------------------------------------------------------------

describe("CF-3.3 retry accounting — controller is the single source of truth", () => {
  it("disables retry on the third consecutive summarize failure (same rule as the Q&A path)", async () => {
    const { controller, port } = setup({
      streamResult: { ok: false, reason: "network", detail: "boom", partialContent: "" },
    });
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    const errorsSeen = () =>
      port.messages.filter((m) => m.type === "streamError") as Array<{ canRetry: boolean }>;

    listener({ type: "summarize" });
    await vi.waitFor(() => expect(errorsSeen()).toHaveLength(1));
    listener({ type: "retry" });
    await vi.waitFor(() => expect(errorsSeen()).toHaveLength(2));
    listener({ type: "retry" });
    await vi.waitFor(() => expect(errorsSeen()).toHaveLength(3));

    expect(errorsSeen()[0].canRetry).toBe(true);
    expect(errorsSeen()[1].canRetry).toBe(true);
    expect(errorsSeen()[2].canRetry).toBe(false);
  });

  it("CF-3.2 a retried message appears exactly once in the AI context", async () => {
    const requests: StreamChatCompletionRequest[] = [];
    let callCount = 0;
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> => {
        requests.push(req);
        callCount++;
        if (callCount === 1) {
          return { ok: false, reason: "network", detail: "fail", partialContent: "" };
        }
        req.onToken("ok");
        return { ok: true, content: "ok" };
      }),
    };
    const controller = createChatController({
      getSettings: vi.fn().mockResolvedValue(createMockSettings()),
      getSecureStore: () => createMockSecureStore(),
      extractContent: vi.fn().mockResolvedValue(createSuccessfulExtractionResult()),
      createStreamingClient: vi.fn().mockReturnValue(mockClient),
      tabState: createMockTabState(),
      skillLibrary: createMockSkillLibrary(),
    });
    const port = createMockPort();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 7 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    listener({ type: "sendMessage", text: "What is X?" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
    });

    listener({ type: "retry" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
    });

    const retryRequest = requests[1];
    const occurrences = retryRequest.messages.filter(
      (m) => m.role === "user" && m.content === "What is X?",
    ).length;
    expect(occurrences).toBe(1);
  });

  it("retry with no message and no context answers with a streamError instead of silence", async () => {
    const { controller, port } = setup();
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 9, url: "about:blank" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "personaModeReady")).toBe(true);
    });

    listener({ type: "retry" });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "streamError")).toBe(true);
    });
    const err = port.messages.find((m) => m.type === "streamError") as { canRetry: boolean };
    expect(err.canRetry).toBe(false);
  });
});

describe("SF-1 restored sessions report cached confidence honestly", () => {
  it("passes null confidence through instead of defaulting to high", async () => {
    const { controller, port, tabState } = setup();
    tabState.set(42, {
      url: "https://example.com/article",
      title: "Cached",
      summary: null,
      conversation: {
        tabId: 42,
        url: "https://example.com/article",
        title: "Cached",
        messages: [],
        createdAt: "t",
        updatedAt: "t",
      },
      extractionConfidence: null,
      consecutiveFailures: 0,
    });
    controller.handleConnect(port);
    const listener = port.messageListeners[0];
    listener({ type: "init", tabId: 42, url: "https://example.com/article" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextTabAdded")).toBe(true);
    });
    const added = port.messages.find((m) => m.type === "contextTabAdded") as {
      confidence: "high" | "medium" | "low" | null;
    };
    expect(added.confidence).toBeNull();
  });
});
