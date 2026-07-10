import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatController, type Port, type CreateChatControllerOptions } from "./controller";
import type { Settings, TabState, SkillDefinition, SkillLibrary, StoredSkill } from "@shared/types";
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
// Dave All-Hands Skill Fixture
// ---------------------------------------------------------------------------

const DAVE_SKILL_RAW = `---
name: Dave
description: Stands in at all-hands meetings, answers questions about team updates
---

## Personality
You are Dave, a friendly and knowledgeable stand-in for department all-hands meetings. You speak in a warm, professional tone and love connecting dots between different team updates.

## Knowledge
- The engineering team shipped 3 features last sprint
- The design team is working on a rebrand
- Q3 goals focus on performance and reliability

## Commands
/recap - Summarize the meeting highlights so far
/action - List any action items mentioned

## Activation
Hey everyone! Dave here. I've got the latest updates ready — ask me anything about what's happening across the teams.
`;

const DAVE_SKILL_NO_ACTIVATION = `---
name: Dave
description: Stands in at all-hands meetings, answers questions about team updates
---

## Personality
You are Dave, a friendly and knowledgeable stand-in for department all-hands meetings. You speak in a warm, professional tone and love connecting dots between different team updates.

## Knowledge
- The engineering team shipped 3 features last sprint
- The design team is working on a rebrand
- Q3 goals focus on performance and reliability

## Commands
/recap - Summarize the meeting highlights so far
/action - List any action items mentioned
`;

const INVALID_SKILL_RAW = `---
description: No name field
---

## Knowledge
Some knowledge here
`;

const GENERATED_SKILL_RAW = `---
name: Bedrock Architecture Expert
description: Knows the service mesh topology and event-driven patterns from the Bedrock docs
---

## Personality
I'm an expert on the Bedrock platform's architecture, happy to explain its service mesh and event-driven design.

## Knowledge
- Microservice boundaries are enforced via the service mesh
- Event sourcing is implemented with Kafka
- Inter-service communication uses gRPC
`;

// ---------------------------------------------------------------------------
// Test helpers (mirrors controller.test.ts patterns)
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
    activateSkill: vi.fn(async (id: string) => {
      library = { ...library, active: { kind: "skill", skillId: id } };
    }),
    activatePersona: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {
      library = { ...library, active: { kind: "none" } };
    }),
    getActiveSkills: vi.fn(async () => {
      const active = library.active;
      if (active.kind === "skill") {
        const skill = library.skills.find((s) => s.id === active.skillId);
        return skill ? [skill] : [];
      }
      return [];
    }),
  };
}

function createMockExtractionResult(): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Bedrock Architecture Overview",
      author: "Engineering Team",
      publicationDate: "2024-06-01",
      sourceUrl: "https://confluence.internal/wiki/bedrock-arch",
      siteName: "Confluence",
      bodyMarkdown: "# Bedrock Architecture\n\nThis document covers the service mesh topology and event-driven patterns used in production.\n\n## Key Points\n- Microservice boundaries\n- Event sourcing via Kafka\n- gRPC for inter-service communication",
      bodyCharacterCount: 220,
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

interface TestContext {
  controller: ReturnType<typeof createChatController>;
  port: ReturnType<typeof createMockPort>;
  tabState: TabStateManager;
  skillLibrary: SkillLibraryManager;
  extractContent: ReturnType<typeof vi.fn>;
  capturedMessages: ChatMessage[][];
  createStreamingClient: ReturnType<typeof vi.fn>;
}

function setup(overrides?: {
  extractionResult?: ExtractionResult;
}): TestContext {
  const settings = createMockSettings();
  const secureStore = createMockSecureStore();
  const tabState = createMockTabState();
  const skillLibrary = createMockSkillLibrary();
  const extractContent = vi.fn().mockResolvedValue(
    overrides?.extractionResult ?? createMockExtractionResult(),
  );

  const capturedMessages: ChatMessage[][] = [];

  const mockClient: StreamingAiClient = {
    streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
      capturedMessages.push([...req.messages]);
      req.onToken("AI response");
      return { ok: true, content: "AI response" } as StreamChatCompletionResult;
    }),
  };
  const createStreamingClientFn = vi.fn().mockReturnValue(mockClient);

  const opts: CreateChatControllerOptions = {
    getSettings: vi.fn().mockResolvedValue(settings),
    getSecureStore: () => secureStore,
    extractContent,
    createStreamingClient: createStreamingClientFn,
    tabState,
    skillLibrary,
    clock: () => "2024-01-15T10:00:00.000Z",
  };

  const controller = createChatController(opts);
  const port = createMockPort();

  return {
    controller,
    port,
    tabState,
    skillLibrary,
    extractContent,
    capturedMessages,
    createStreamingClient: createStreamingClientFn,
  };
}

// ---------------------------------------------------------------------------
// End-to-End Smoke Tests
// ---------------------------------------------------------------------------

describe("Skill E2E: Full skill lifecycle", () => {
  describe("Load skill → page extraction → send message → clear skill", () => {
    it("loads the Dave skill and responds with skillLoaded including activation", async () => {
      const { controller, port } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      // Init the tab to set up currentTabId
      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Load the Dave skill
      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      const loaded = port.messages.find((m) => m.type === "skillLoaded");
      expect(loaded).toBeDefined();
      if (loaded && loaded.type === "skillLoaded") {
        expect(loaded.name).toBe("Dave");
        expect(loaded.description).toBe("Stands in at all-hands meetings, answers questions about team updates");
        expect(loaded.activation).toBe("Hey everyone! Dave here. I've got the latest updates ready — ask me anything about what's happening across the teams.");
      }
    });

    it("persists the activation greeting as first message in conversation history", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Load skill
      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      // Check tab state conversation includes the activation message
      const state = tabState.get(1);
      expect(state).toBeDefined();
      expect(state!.conversation.messages.length).toBe(1);
      expect(state!.conversation.messages[0].role).toBe("assistant");
      expect(state!.conversation.messages[0].content).toBe(
        "Hey everyone! Dave here. I've got the latest updates ready — ask me anything about what's happening across the teams."
      );
    });

    it("uses composite prompt with page context when sending a message with skill loaded", async () => {
      const { controller, port, capturedMessages } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      // Init → extraction happens
      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Load skill
      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Clear captured messages from summarization (if any happened during init)
      capturedMessages.length = 0;

      // Send a user message
      send({ type: "sendMessage", text: "What did the engineering team ship?" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "streamEnd")).toBe(true);
      });

      // Verify the system prompt sent to the AI
      expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
      const lastCall = capturedMessages[capturedMessages.length - 1];
      const systemMsg = lastCall.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();

      const prompt = systemMsg!.content;

      // Composite prompt should contain personality
      expect(prompt).toContain("You are Dave, a friendly and knowledgeable stand-in");

      // Should contain knowledge
      expect(prompt).toContain("The engineering team shipped 3 features last sprint");

      // Should contain page context with title, URL, and body
      expect(prompt).toContain("## Page Context");
      expect(prompt).toContain("Title: Bedrock Architecture Overview");
      expect(prompt).toContain("URL: https://confluence.internal/wiki/bedrock-arch");
      expect(prompt).toContain("Bedrock Architecture");

      // Should contain commands
      expect(prompt).toContain("/recap - Summarize the meeting highlights so far");

      // Should NOT contain activation text
      expect(prompt).not.toContain("Hey everyone! Dave here.");
    });

    it("composite prompt includes Page Context formatted as ## Page Context with title, URL, body", async () => {
      const { controller, port, capturedMessages } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });

      // Load skill
      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      capturedMessages.length = 0;
      send({ type: "sendMessage", text: "Tell me about the architecture" });

      await vi.waitFor(() => {
        expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
      });

      const lastCall = capturedMessages[capturedMessages.length - 1];
      const systemMsg = lastCall.find((m) => m.role === "system")!;
      const prompt = systemMsg.content;

      // Verify the Page Context block format
      const pageContextIdx = prompt.indexOf("## Page Context");
      expect(pageContextIdx).toBeGreaterThan(-1);

      const afterPageContext = prompt.slice(pageContextIdx);
      expect(afterPageContext).toContain("Title: Bedrock Architecture Overview");
      expect(afterPageContext).toContain("URL: https://confluence.internal/wiki/bedrock-arch");
      expect(afterPageContext).toContain("service mesh topology");
    });

    it("composite prompt does NOT include activation text", async () => {
      const { controller, port, capturedMessages } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });

      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      capturedMessages.length = 0;
      send({ type: "sendMessage", text: "Hello" });

      await vi.waitFor(() => {
        expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
      });

      const lastCall = capturedMessages[capturedMessages.length - 1];
      const systemMsg = lastCall.find((m) => m.role === "system")!;

      // Activation text must never appear in the system prompt
      expect(systemMsg.content).not.toContain("Hey everyone! Dave here.");
      expect(systemMsg.content).not.toContain("I've got the latest updates ready");
    });

    it("clearing the skill sends skillCleared and clears the conversation", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });

      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Clear skill
      send({ type: "clearSkill" });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillCleared")).toBe(true);
      });

      // Conversation should be cleared
      const state = tabState.get(1);
      expect(state).toBeDefined();
      expect(state!.conversation.messages).toHaveLength(0);

      // conversationRestored with empty messages should be sent
      expect(port.messages.some((m) => m.type === "conversationRestored")).toBe(true);
      const restored = port.messages.find((m) => m.type === "conversationRestored");
      if (restored && restored.type === "conversationRestored") {
        expect(restored.messages).toHaveLength(0);
      }
    });

    it("after clearing skill, sending a message uses DEFAULT system prompt", async () => {
      const { controller, port, capturedMessages } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });

      // Load then clear skill
      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      send({ type: "clearSkill" });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillCleared")).toBe(true);
      });

      capturedMessages.length = 0;
      port.messages.length = 0;

      // Send a message after clearing — should use default system prompt
      send({ type: "sendMessage", text: "Summarize this page" });

      await vi.waitFor(() => {
        expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
      });

      const lastCall = capturedMessages[capturedMessages.length - 1];
      const systemMsg = lastCall.find((m) => m.role === "system")!;

      // Should be the default summarization prompt, NOT composite
      expect(systemMsg.content).toContain("helpful assistant");
      expect(systemMsg.content).not.toContain("You are Dave");
      expect(systemMsg.content).not.toContain("## Page Context");
      expect(systemMsg.content).not.toContain("## Knowledge");
    });
  });

  describe("Skill with no activation", () => {
    it("loads successfully without posting any greeting message", async () => {
      const { controller, port, tabState } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Load skill without activation section
      send({ type: "loadSkill", raw: DAVE_SKILL_NO_ACTIVATION });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      const loaded = port.messages.find((m) => m.type === "skillLoaded");
      if (loaded && loaded.type === "skillLoaded") {
        expect(loaded.name).toBe("Dave");
        expect(loaded.activation).toBeNull();
      }

      // No greeting persisted — conversation should be empty
      const state = tabState.get(1);
      expect(state).toBeDefined();
      expect(state!.conversation.messages).toHaveLength(0);
    });
  });

  describe("Skill with parse errors", () => {
    it("returns skillError when skill file is invalid", async () => {
      const { controller, port } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });
      port.messages.length = 0;

      // Load invalid skill (missing name and personality)
      send({ type: "loadSkill", raw: INVALID_SKILL_RAW });

      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillError")).toBe(true);
      });

      const errorMsg = port.messages.find((m) => m.type === "skillError");
      expect(errorMsg).toBeDefined();
      if (errorMsg && errorMsg.type === "skillError") {
        expect(errorMsg.errors.length).toBeGreaterThan(0);
        // Should mention the missing name field
        expect(errorMsg.errors.some((e) => e.toLowerCase().includes("name"))).toBe(true);
        // Should mention the missing personality section
        expect(errorMsg.errors.some((e) => e.toLowerCase().includes("personality"))).toBe(true);
      }
    });
  });

  describe("Loading a new skill replaces old one and clears conversation", () => {
    it("replaces the active skill and clears conversation history", async () => {
      const { controller, port, tabState, skillLibrary } = setup();
      controller.handleConnect(port);
      const send = port.messageListeners[0];

      send({ type: "init", tabId: 1 });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
      });

      // Load first skill
      send({ type: "loadSkill", raw: DAVE_SKILL_RAW });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      // Verify activation was persisted
      const stateAfterFirst = tabState.get(1);
      expect(stateAfterFirst!.conversation.messages.length).toBe(1);

      port.messages.length = 0;

      // Load second skill (no activation variant)
      send({ type: "loadSkill", raw: DAVE_SKILL_NO_ACTIVATION });
      await vi.waitFor(() => {
        expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
      });

      // Conversation should be cleared (no activation on second load)
      const stateAfterSecond = tabState.get(1);
      expect(stateAfterSecond!.conversation.messages).toHaveLength(0);

      // addSkill should have been called twice (once per load)
      expect(skillLibrary.addSkill).toHaveBeenCalledTimes(2);

      // The second loaded event has null activation
      const loaded = port.messages.find((m) => m.type === "skillLoaded");
      if (loaded && loaded.type === "skillLoaded") {
        expect(loaded.activation).toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Generate skill from context tabs
// ---------------------------------------------------------------------------

describe("generateSkillFromContext", () => {
  it("sends skillGenerationStarted, then adds and activates the AI-derived skill", async () => {
    const { controller, port, skillLibrary, createStreamingClient } = setup();
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
        req.onToken(GENERATED_SKILL_RAW);
        return { ok: true, content: GENERATED_SKILL_RAW } as StreamChatCompletionResult;
      }),
    };
    createStreamingClient.mockReturnValue(mockClient);

    controller.handleConnect(port);
    const send = port.messageListeners[0];

    send({ type: "init", tabId: 1 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    port.messages.length = 0;

    send({ type: "generateSkillFromContext" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
    });

    expect(port.messages.some((m) => m.type === "skillGenerationStarted")).toBe(true);

    const loaded = port.messages.find((m) => m.type === "skillLoaded");
    if (loaded && loaded.type === "skillLoaded") {
      expect(loaded.name).toBe("Bedrock Architecture Expert");
      expect(loaded.description).toBe(
        "Knows the service mesh topology and event-driven patterns from the Bedrock docs",
      );
    }

    expect(skillLibrary.addSkill).toHaveBeenCalledTimes(1);
    expect(skillLibrary.activateSkill).toHaveBeenCalledTimes(1);
  });

  it("sends the context tabs' extracted content to the AI as the user message", async () => {
    const { controller, port, capturedMessages, createStreamingClient } = setup();
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
        capturedMessages.push([...req.messages]);
        req.onToken(GENERATED_SKILL_RAW);
        return { ok: true, content: GENERATED_SKILL_RAW } as StreamChatCompletionResult;
      }),
    };
    createStreamingClient.mockReturnValue(mockClient);

    controller.handleConnect(port);
    const send = port.messageListeners[0];

    send({ type: "init", tabId: 1 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });

    capturedMessages.length = 0;
    send({ type: "generateSkillFromContext" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "skillLoaded")).toBe(true);
    });

    const call = capturedMessages[capturedMessages.length - 1];
    const userMsg = call.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("Bedrock Architecture Overview");
    expect(userMsg.content).toContain("service mesh topology");
  });

  it("surfaces a skillError and adds nothing to the library when the AI response is not a valid skill file", async () => {
    const { controller, port, skillLibrary, createStreamingClient } = setup();
    const mockClient: StreamingAiClient = {
      streamChatCompletion: vi.fn(async (req: StreamChatCompletionRequest) => {
        req.onToken("Sorry, I can't help with that.");
        return { ok: true, content: "Sorry, I can't help with that." } as StreamChatCompletionResult;
      }),
    };
    createStreamingClient.mockReturnValue(mockClient);

    controller.handleConnect(port);
    const send = port.messageListeners[0];

    send({ type: "init", tabId: 1 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextLoaded")).toBe(true);
    });
    port.messages.length = 0;

    send({ type: "generateSkillFromContext" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "skillError")).toBe(true);
    });

    expect(skillLibrary.addSkill).not.toHaveBeenCalled();
  });

  it("sends a skillError and does not call the AI when there are no context tabs", async () => {
    const { controller, port, skillLibrary, createStreamingClient } = setup({
      extractionResult: { ok: false, reason: "extraction-error", detail: "boom" },
    });
    controller.handleConnect(port);
    const send = port.messageListeners[0];

    send({ type: "init", tabId: 1 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "contextError")).toBe(true);
    });
    port.messages.length = 0;

    send({ type: "generateSkillFromContext" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "skillError")).toBe(true);
    });

    const errorMsg = port.messages.find((m) => m.type === "skillError");
    if (errorMsg && errorMsg.type === "skillError") {
      expect(errorMsg.errors.join(" ")).toContain("context");
    }
    expect(skillLibrary.addSkill).not.toHaveBeenCalled();
    expect(createStreamingClient).not.toHaveBeenCalled();
  });

  it("sends configError and never calls the AI when the endpoint isn't configured", async () => {
    const settings = createMockSettings({ baseUrl: "", modelId: "" });
    const secureStore = createMockSecureStore();
    const tabState = createMockTabState();
    const skillLibrary = createMockSkillLibrary();
    const extractContent = vi.fn().mockResolvedValue(createMockExtractionResult());
    const createStreamingClientFn = vi.fn();

    const controller = createChatController({
      getSettings: vi.fn().mockResolvedValue(settings),
      getSecureStore: () => secureStore,
      extractContent,
      createStreamingClient: createStreamingClientFn,
      tabState,
      skillLibrary,
      clock: () => "2024-01-15T10:00:00.000Z",
    });
    const port = createMockPort();
    controller.handleConnect(port);
    const send = port.messageListeners[0];

    send({ type: "init", tabId: 1 });
    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "configError")).toBe(true);
    });
    port.messages.length = 0;

    send({ type: "generateSkillFromContext" });

    await vi.waitFor(() => {
      expect(port.messages.some((m) => m.type === "configError")).toBe(true);
    });
    expect(createStreamingClientFn).not.toHaveBeenCalled();
  });
});
