import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createChatController, type Port, type CreateChatControllerOptions } from "./controller";
import type { Settings, TabState, Conversation, ConversationMessage, SkillDefinition, SkillLibrary, StoredSkill } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import type { TabStateManager } from "@background/tab-state";
import type { SkillLibraryManager } from "@background/skill-library";
import type { SecureStore } from "@background/secure-store";
import type {
  StreamingAiClient,
  StreamChatCompletionRequest,
  StreamChatCompletionResult,
  ChatMessage,
} from "./streaming-client";
import type { ControllerToSidebarMessage } from "@shared/port-protocol";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockSettings(systemPrompt: string = "You are a helpful assistant."): Settings {
  return {
    schemaVersion: 1,
    ai: {
      baseUrl: "https://api.example.com",
      modelId: "gpt-4",
      apiKeyRef: "ref-123",
      systemPrompt,
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

function createMockSecureStore(): SecureStore {
  return {
    setSecret: vi.fn(),
    getSecret: vi.fn().mockResolvedValue("sk-test"),
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
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: vi.fn((cb: () => void) => { disconnectListeners.push(cb); }),
      removeListener: vi.fn(),
    },
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

/** Wait for a condition to become true with a short polling interval. */
async function waitFor(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Arbitrary for generating a conversation message */
const conversationMessageArb = fc.record({
  role: fc.constantFrom("user" as const, "assistant" as const),
  content: fc.string({ minLength: 1, maxLength: 200 }),
  timestamp: fc.date().map((d) => d.toISOString()),
});

/** Arbitrary for generating page content of varying lengths (short) */
const pageContentShortArb = fc.string({ minLength: 1, maxLength: 1000 });

/**
 * Arbitrary for generating page content that may exceed the 50k truncation limit.
 * Uses a short seed string repeated to reach the target length for efficiency.
 */
const pageContentWithTruncationArb = fc.tuple(
  fc.string({ minLength: 10, maxLength: 100 }),
  fc.integer({ min: 48_000, max: 55_000 }),
).map(([seed, targetLength]) => {
  const repeated = seed.repeat(Math.ceil(targetLength / seed.length));
  return repeated.slice(0, targetLength);
});

/** Arbitrary for generating a system prompt */
const systemPromptArb = fc.string({ minLength: 1, maxLength: 200 });

/** Arbitrary for generating a user message */
const userMessageArb = fc.string({ minLength: 1, maxLength: 500 });

// ---------------------------------------------------------------------------
// Property 2: Conversation context includes page content and history
// Validates: Requirements 1.3
// ---------------------------------------------------------------------------

describe("Property 2: Conversation context includes page content and history", () => {
  it("context messages always start with a system prompt", async () => {
    /**
     * **Validates: Requirements 1.3**
     */
    await fc.assert(
      fc.asyncProperty(
        systemPromptArb,
        pageContentShortArb,
        fc.array(conversationMessageArb, { minLength: 0, maxLength: 5 }),
        userMessageArb,
        async (systemPrompt, pageContent, priorMessages, newMessage) => {
          let capturedMessages: ReadonlyArray<ChatMessage> | null = null;
          let sendMessageCallCount = 0;

          const mockClient: StreamingAiClient = {
            streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
              sendMessageCallCount++;
              if (sendMessageCallCount === 2) {
                // Capture messages from the follow-up call (second call)
                capturedMessages = [...req.messages];
              }
              return { ok: true, content: "Response" } as StreamChatCompletionResult;
            }),
          };

          const tabState = createMockTabState();
          const settings = createMockSettings(systemPrompt);

          const controller = createChatController({
            getSettings: vi.fn().mockResolvedValue(settings),
            getSecureStore: () => createMockSecureStore(),
            extractContent: vi.fn().mockResolvedValue({
              ok: true,
              article: {
                title: "Test",
                author: null,
                publicationDate: null,
                sourceUrl: "https://example.com",
                siteName: "Example",
                bodyMarkdown: pageContent,
                bodyCharacterCount: pageContent.length,
              },
              confidence: "high",
            } as ExtractionResult),
            createStreamingClient: vi.fn().mockReturnValue(mockClient),
            tabState,
            skillLibrary: createMockSkillLibrary(),
            clock: () => "2024-01-15T10:00:00.000Z",
          });

          const port = createMockPort();
          controller.handleConnect(port);
          const listener = port.messageListeners[0];

          // Init to set up state and page content
          listener({ type: "init", tabId: 1 });
          await waitFor(() => port.messages.some((m) => m.type === "contextLoaded"));
          listener({ type: "summarize" });
          await waitFor(() => port.messages.some((m) => m.type === "streamEnd"));

          // Inject prior conversation messages into tab state
          if (priorMessages.length > 0) {
            const state = tabState.get(1)!;
            tabState.update(1, {
              conversation: {
                ...state.conversation,
                messages: [...state.conversation.messages, ...priorMessages],
              },
            });
          }

          // Send a follow-up message
          listener({ type: "sendMessage", text: newMessage });
          await waitFor(() => capturedMessages !== null);

          // The first message must be the system prompt
          expect(capturedMessages![0].role).toBe("system");
          expect(capturedMessages![0].content).toBe(systemPrompt);
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);

  it("page content is included and truncated to 50k chars max", async () => {
    /**
     * **Validates: Requirements 1.3**
     */
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(pageContentShortArb, pageContentWithTruncationArb),
        userMessageArb,
        async (pageContent, newMessage) => {
          let capturedMessages: ReadonlyArray<ChatMessage> | null = null;
          let sendMessageCallCount = 0;

          const mockClient: StreamingAiClient = {
            streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
              sendMessageCallCount++;
              if (sendMessageCallCount === 2) {
                capturedMessages = [...req.messages];
              }
              return { ok: true, content: "Response" } as StreamChatCompletionResult;
            }),
          };

          const tabState = createMockTabState();
          const settings = createMockSettings("System prompt");

          const controller = createChatController({
            getSettings: vi.fn().mockResolvedValue(settings),
            getSecureStore: () => createMockSecureStore(),
            extractContent: vi.fn().mockResolvedValue({
              ok: true,
              article: {
                title: "Test",
                author: null,
                publicationDate: null,
                sourceUrl: "https://example.com",
                siteName: "Example",
                bodyMarkdown: pageContent,
                bodyCharacterCount: pageContent.length,
              },
              confidence: "high",
            } as ExtractionResult),
            createStreamingClient: vi.fn().mockReturnValue(mockClient),
            tabState,
            skillLibrary: createMockSkillLibrary(),
            clock: () => "2024-01-15T10:00:00.000Z",
          });

          const port = createMockPort();
          controller.handleConnect(port);
          const listener = port.messageListeners[0];

          // Init to set up state and page content
          listener({ type: "init", tabId: 1 });
          await waitFor(() => port.messages.some((m) => m.type === "contextLoaded"));
          listener({ type: "summarize" });
          await waitFor(() => port.messages.some((m) => m.type === "streamEnd"));

          // Send a follow-up message
          listener({ type: "sendMessage", text: newMessage });
          await waitFor(() => capturedMessages !== null);

          // The second message should contain page content (role "user")
          const pageContentMsg = capturedMessages![1];
          expect(pageContentMsg.role).toBe("user");

          // The page content in the message should be truncated to 50k chars
          const truncatedContent = pageContent.slice(0, 50_000);
          expect(pageContentMsg.content).toContain(truncatedContent);

          // The wrapper text is "Here is the page content for context:\n\n" (39 chars)
          const wrapperOverhead = "Here is the page content for context:\n\n".length;
          const expectedMaxLength = wrapperOverhead + 50_000;

          // The message content should never exceed wrapper + 50k chars
          expect(pageContentMsg.content.length).toBeLessThanOrEqual(expectedMaxLength);

          // If original content was longer than 50k, verify truncation happened
          if (pageContent.length > 50_000) {
            expect(pageContentMsg.content.length).toBe(expectedMaxLength);
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);

  it("all prior conversation messages appear in order after the page content", async () => {
    /**
     * **Validates: Requirements 1.3**
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(conversationMessageArb, { minLength: 1, maxLength: 8 }),
        userMessageArb,
        async (priorMessages, newMessage) => {
          let capturedMessages: ReadonlyArray<ChatMessage> | null = null;
          let sendMessageCallCount = 0;

          const mockClient: StreamingAiClient = {
            streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
              sendMessageCallCount++;
              if (sendMessageCallCount === 2) {
                capturedMessages = [...req.messages];
              }
              return { ok: true, content: "Response" } as StreamChatCompletionResult;
            }),
          };

          const tabState = createMockTabState();
          const settings = createMockSettings("System prompt");

          const controller = createChatController({
            getSettings: vi.fn().mockResolvedValue(settings),
            getSecureStore: () => createMockSecureStore(),
            extractContent: vi.fn().mockResolvedValue({
              ok: true,
              article: {
                title: "Test",
                author: null,
                publicationDate: null,
                sourceUrl: "https://example.com",
                siteName: "Example",
                bodyMarkdown: "Short page content",
                bodyCharacterCount: 18,
              },
              confidence: "high",
            } as ExtractionResult),
            createStreamingClient: vi.fn().mockReturnValue(mockClient),
            tabState,
            skillLibrary: createMockSkillLibrary(),
            clock: () => "2024-01-15T10:00:00.000Z",
          });

          const port = createMockPort();
          controller.handleConnect(port);
          const listener = port.messageListeners[0];

          // Init to set up state
          listener({ type: "init", tabId: 1 });
          await waitFor(() => port.messages.some((m) => m.type === "contextLoaded"));
          listener({ type: "summarize" });
          await waitFor(() => port.messages.some((m) => m.type === "streamEnd"));

          // Get the state after init (includes the summary assistant message)
          const state = tabState.get(1)!;
          const initMessages = [...state.conversation.messages];

          // Add prior messages to conversation history
          const allHistoryMessages = [...initMessages, ...priorMessages];
          tabState.update(1, {
            conversation: {
              ...state.conversation,
              messages: allHistoryMessages,
            },
          });

          // Send a follow-up message
          listener({ type: "sendMessage", text: newMessage });
          await waitFor(() => capturedMessages !== null);

          // Context structure:
          // [0] system prompt
          // [1] page content (user)
          // [2] assistant acknowledgment ("I've read the page content...")
          // [3..N-1] prior conversation messages from state
          // [N] new user message (added by sendMessage before streaming)

          const historyStartIndex = 3;
          // The last message is the new user message; the messages before it
          // (after index 2) should be the conversation history
          const historyMessages = capturedMessages!.slice(historyStartIndex, -1);

          // Verify all prior messages appear in order
          expect(historyMessages.length).toBe(allHistoryMessages.length);
          for (let i = 0; i < allHistoryMessages.length; i++) {
            const expected = allHistoryMessages[i];
            const actual = historyMessages[i];
            expect(actual.role).toBe(expected.role === "user" ? "user" : "assistant");
            expect(actual.content).toBe(expected.content);
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);

  it("the new user message is always the last message in context", async () => {
    /**
     * **Validates: Requirements 1.3**
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(conversationMessageArb, { minLength: 0, maxLength: 5 }),
        userMessageArb,
        async (priorMessages, newMessage) => {
          let capturedMessages: ReadonlyArray<ChatMessage> | null = null;
          let sendMessageCallCount = 0;

          const mockClient: StreamingAiClient = {
            streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
              sendMessageCallCount++;
              if (sendMessageCallCount === 2) {
                capturedMessages = [...req.messages];
              }
              return { ok: true, content: "Response" } as StreamChatCompletionResult;
            }),
          };

          const tabState = createMockTabState();
          const settings = createMockSettings("System prompt");

          const controller = createChatController({
            getSettings: vi.fn().mockResolvedValue(settings),
            getSecureStore: () => createMockSecureStore(),
            extractContent: vi.fn().mockResolvedValue({
              ok: true,
              article: {
                title: "Test",
                author: null,
                publicationDate: null,
                sourceUrl: "https://example.com",
                siteName: "Example",
                bodyMarkdown: "Page content here",
                bodyCharacterCount: 17,
              },
              confidence: "high",
            } as ExtractionResult),
            createStreamingClient: vi.fn().mockReturnValue(mockClient),
            tabState,
            skillLibrary: createMockSkillLibrary(),
            clock: () => "2024-01-15T10:00:00.000Z",
          });

          const port = createMockPort();
          controller.handleConnect(port);
          const listener = port.messageListeners[0];

          // Init to set up state
          listener({ type: "init", tabId: 1 });
          await waitFor(() => port.messages.some((m) => m.type === "contextLoaded"));
          listener({ type: "summarize" });
          await waitFor(() => port.messages.some((m) => m.type === "streamEnd"));

          // Add prior messages if any
          if (priorMessages.length > 0) {
            const state = tabState.get(1)!;
            tabState.update(1, {
              conversation: {
                ...state.conversation,
                messages: [...state.conversation.messages, ...priorMessages],
              },
            });
          }

          // Send a follow-up message
          listener({ type: "sendMessage", text: newMessage });
          await waitFor(() => capturedMessages !== null);

          // The last message must be the new user message
          const lastMsg = capturedMessages![capturedMessages!.length - 1];
          expect(lastMsg.role).toBe("user");
          expect(lastMsg.content).toBe(newMessage);
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);
});
