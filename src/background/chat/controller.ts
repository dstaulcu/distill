/**
 * Chat Controller — orchestrates the sidebar chat lifecycle.
 *
 * Manages port connections from the sidebar, session caching via TabStateManager,
 * content extraction, AI summarization with streaming, follow-up Q&A, abort,
 * and retry logic.
 *
 * All external dependencies are injected via the options object for testability.
 */

import type { Settings, TabState, Conversation, ConversationMessage, SkillDefinition, ExtractedArticle } from "@shared/types";
import type {
  SidebarToControllerMessage,
  ControllerToSidebarMessage,
  PortConversationMessage,
  SkillLibrarySnapshot,
} from "@shared/port-protocol";
import { isSidebarToControllerMessage } from "@shared/port-protocol";
import type { ExtractionResult } from "@content/extractor/extract";
import type { TabStateManager } from "@background/tab-state";
import type { SkillLibraryManager } from "@background/skill-library";
import type { SecureStore } from "@background/secure-store";
import type {
  StreamingAiClient,
  StreamingClientOptions,
  ChatMessage,
} from "./streaming-client";
import { parseSkillFile } from "@shared/skill-parser";
import { buildCompositePrompt } from "@shared/composite-prompt";

// ---------------------------------------------------------------------------
// Public Interface
// ---------------------------------------------------------------------------

export interface ChatController {
  /** Handle a new port connection from the sidebar. */
  handleConnect(port: Port): void;
}

export interface CreateChatControllerOptions {
  readonly getSettings: () => Promise<Settings>;
  readonly getSecureStore: () => SecureStore;
  readonly extractContent: (tabId: number, selector?: string) => Promise<ExtractionResult>;
  readonly createStreamingClient: (opts: StreamingClientOptions) => StreamingAiClient;
  readonly tabState: TabStateManager;
  readonly skillLibrary: SkillLibraryManager;
  readonly hasSavedPattern?: (url: string) => Promise<boolean>;
  readonly queryOpenTabs?: () => Promise<ReadonlyArray<{ readonly tabId: number; readonly title: string; readonly url: string }>>;
  readonly clock?: () => string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Port abstraction (matches browser.runtime.Port shape)
// ---------------------------------------------------------------------------

export interface Port {
  readonly name: string;
  postMessage(msg: ControllerToSidebarMessage): void;
  onMessage: {
    addListener(cb: (msg: unknown) => void): void;
    removeListener(cb: (msg: unknown) => void): void;
  };
  onDisconnect: {
    addListener(cb: () => void): void;
    removeListener(cb: () => void): void;
  };
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface ContextTabEntry {
  readonly url: string;
  readonly title: string;
  content: string | null;
  readonly confidence: "high" | "medium" | "low" | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PAGE_CONTENT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatController(opts: CreateChatControllerOptions): ChatController {
  const { getSettings, getSecureStore, extractContent, createStreamingClient, tabState, skillLibrary } = opts;
  const hasSavedPattern = opts.hasSavedPattern ?? (async () => false);
  const queryOpenTabs = opts.queryOpenTabs ?? (async () => []);
  const clock = opts.clock ?? (() => new Date().toISOString());

  return {
    handleConnect(port: Port): void {
      let currentTabId: number | null = null;
      let abortController: AbortController | null = null;
      let lastUserMessage: string | null = null;
      // Map of tabId → context entry (replaces single pageContent variable)
      const contextTabs = new Map<number, ContextTabEntry>();
      let activeSkills: SkillDefinition[] = [];

      // Initialize activeSkills from persisted library
      skillLibrary.getActiveSkills().then((skills) => {
        activeSkills = skills;
      });

      const send = (msg: ControllerToSidebarMessage): void => {
        port.postMessage(msg);
      };

      const onMessage = (raw: unknown): void => {
        if (!isSidebarToControllerMessage(raw)) return;
        const msg = raw as SidebarToControllerMessage;

        switch (msg.type) {
          case "init":
            handleInit(msg.tabId, (msg as { url?: string }).url);
            break;
          case "summarize":
            handleSummarize();
            break;
          case "sendMessage":
            handleSendMessage(msg.text);
            break;
          case "abort":
            handleAbort();
            break;
          case "retry":
            handleRetry();
            break;
          case "loadSkill":
            handleLoadSkill((msg as { raw: string }).raw);
            break;
          case "generateSkillFromContext":
            handleGenerateSkillFromContext();
            break;
          case "clearSkill":
            handleDeactivate();
            break;
          case "getLibrary":
            handleGetLibrary();
            break;
          case "activateSkill":
            handleActivateSkill((msg as { skillId: string }).skillId);
            break;
          case "activatePersona":
            handleActivatePersona((msg as { personaId: string }).personaId);
            break;
          case "deactivate":
            handleDeactivate();
            break;
          case "addContextTab":
            handleAddContextTab((msg as { tabId: number }).tabId);
            break;
          case "removeContextTab":
            handleRemoveContextTab((msg as { tabId: number }).tabId);
            break;
          case "getOpenTabs":
            handleGetOpenTabs();
            break;
          // autoExport messages are handled elsewhere
          default:
            break;
        }
      };

      const onDisconnect = (): void => {
        // Cancel any in-flight request when port disconnects
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      };

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);

      // -----------------------------------------------------------------------
      // init handler
      // -----------------------------------------------------------------------

      async function handleInit(tabId: number, initUrl?: string): Promise<void> {
        currentTabId = tabId;
        contextTabs.clear();

        // Cancel any in-flight request from a previous page
        if (abortController) {
          abortController.abort();
          abortController = null;
        }

        // Special case: about:blank → persona chat mode (no extraction)
        if (initUrl === "about:blank") {
          const cached = tabState.get(tabId);
          if (cached && cached.url === "about:blank") {
            // Restore cached persona-mode conversation
            const messages: PortConversationMessage[] = cached.conversation.messages.map((m) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              isPartial: m.isPartial,
            }));
            send({ type: "personaModeReady", messages });
            return;
          }

          // New persona-chat session
          if (cached) {
            tabState.remove(tabId);
          }
          const now = clock();
          const conversation: Conversation = {
            tabId,
            url: "about:blank",
            title: "Persona Chat",
            messages: [],
            createdAt: now,
            updatedAt: now,
          };
          tabState.set(tabId, {
            url: "about:blank",
            title: "Persona Chat",
            summary: null,
            conversation,
            extractionConfidence: null,
            consecutiveFailures: 0,
          });

          send({ type: "personaModeReady" });

          const settings = await getSettings();
          if (!settings.ai.baseUrl || !settings.ai.modelId) {
            send({ type: "configError", reason: "AI not configured. Set the base URL and model in Settings to enable chat." });
          }
          return;
        }

        // Check for cached session — restore if URL matches or if caller didn't provide a URL
        const cached = tabState.get(tabId);
        if (cached && (!initUrl || cached.url === initUrl)) {
          // URL matches — restore cached session
          const messages: PortConversationMessage[] = cached.conversation.messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            isPartial: m.isPartial,
          }));

          send({ type: "conversationRestored", messages });
          // Rebuild context tab entry for the cached session (content lazily re-extracted on demand)
          contextTabs.set(tabId, { url: cached.url, title: cached.title, content: null, confidence: cached.extractionConfidence });
          send({ type: "contextTabAdded", tabId, url: cached.url, title: cached.title, confidence: cached.extractionConfidence });
          return;
        }

        // URL changed or no cache — discard old session if exists
        if (cached) {
          tabState.remove(tabId);
        }

        // No cached session (or URL changed) — trigger extraction
        const settings = await getSettings();

        // Small delay to let the page's content script fully initialize after navigation
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Extract content (always — needed for export even without AI)
        let extractionResult: ExtractionResult;
        try {
          extractionResult = await extractContent(tabId);
        } catch (err) {
          send({
            type: "contextError",
            reason: err instanceof Error ? err.message : "Content extraction failed",
            canRetry: true,
          });
          return;
        }

        if (!extractionResult.ok) {
          send({
            type: "contextError",
            reason: extractionResult.detail,
            canRetry: true,
          });
          return;
        }

        const article = extractionResult.article;
        const content = article.bodyMarkdown.slice(0, MAX_PAGE_CONTENT_CHARS);

        contextTabs.set(tabId, { url: article.sourceUrl, title: article.title, content, confidence: extractionResult.confidence });

        const patternExists = await hasSavedPattern(article.sourceUrl);
        send({ type: "contextLoaded", title: article.title, url: article.sourceUrl, confidence: extractionResult.confidence, hasSavedPattern: patternExists, wordCount: Math.round(article.bodyCharacterCount / 5) });

        // Initialize tab state
        const now = clock();
        const conversation: Conversation = {
          tabId,
          url: article.sourceUrl,
          title: article.title,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };

        const newState: TabState = {
          url: article.sourceUrl,
          title: article.title,
          summary: null,
          conversation,
          extractionConfidence: extractionResult.confidence,
          consecutiveFailures: 0,
        };

        tabState.set(tabId, newState);

        // Warn early if AI is unconfigured so the user knows before clicking Summarize
        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          send({ type: "configError", reason: "AI not configured. Extraction and export are available. Set the base URL and model in Settings to enable summaries and Q&A." });
        }
      }

      // -----------------------------------------------------------------------
      // Context tab management handlers
      // -----------------------------------------------------------------------

      async function handleAddContextTab(tabId: number): Promise<void> {
        // Don't add a tab that's already in context
        if (contextTabs.has(tabId)) return;

        let tabUrl = "";
        let tabTitle = "";
        try {
          // Get URL/title from the open tabs list (requires queryOpenTabs)
          const openTabs = await queryOpenTabs();
          const found = openTabs.find((t) => t.tabId === tabId);
          if (found) {
            tabUrl = found.url;
            tabTitle = found.title;
          }
        } catch {
          // Will be filled in from extraction result
        }

        let extractionResult: ExtractionResult;
        try {
          extractionResult = await extractContent(tabId);
        } catch (err) {
          send({
            type: "contextTabFailed",
            tabId,
            url: tabUrl,
            title: tabTitle || `Tab ${tabId}`,
            reason: err instanceof Error ? err.message : "Content extraction failed",
          });
          return;
        }

        if (!extractionResult.ok) {
          send({
            type: "contextTabFailed",
            tabId,
            url: tabUrl,
            title: tabTitle || `Tab ${tabId}`,
            reason: extractionResult.detail,
          });
          return;
        }

        const article = extractionResult.article;
        const content = article.bodyMarkdown.slice(0, MAX_PAGE_CONTENT_CHARS);
        contextTabs.set(tabId, { url: article.sourceUrl, title: article.title, content, confidence: extractionResult.confidence });
        send({ type: "contextTabAdded", tabId, url: article.sourceUrl, title: article.title, confidence: extractionResult.confidence });
      }

      function handleRemoveContextTab(tabId: number): void {
        contextTabs.delete(tabId);
        send({ type: "contextTabRemoved", tabId });
      }

      async function handleGetOpenTabs(): Promise<void> {
        const tabs = await queryOpenTabs();
        send({ type: "openTabs", tabs });
      }

      // -----------------------------------------------------------------------
      // Build context articles from current contextTabs
      // -----------------------------------------------------------------------

      async function ensureContextContent(): Promise<void> {
        for (const [tabId, ctx] of contextTabs) {
          if (ctx.content === null) {
            try {
              const result = await extractContent(tabId);
              if (result.ok) {
                ctx.content = result.article.bodyMarkdown.slice(0, MAX_PAGE_CONTENT_CHARS);
              }
            } catch {
              // Continue without content for this tab
            }
          }
        }
      }

      function buildContextArticles(): ExtractedArticle[] {
        const articles: ExtractedArticle[] = [];
        for (const ctx of contextTabs.values()) {
          if (ctx.content) {
            articles.push({
              title: ctx.title,
              sourceUrl: ctx.url,
              bodyMarkdown: ctx.content,
              author: null,
              publicationDate: null,
              siteName: "",
              bodyCharacterCount: ctx.content.length,
            });
          }
        }
        return articles;
      }

      // -----------------------------------------------------------------------
      // summarize handler (user-triggered)
      // -----------------------------------------------------------------------

      async function handleSummarize(): Promise<void> {
        if (currentTabId === null) return;

        const settings = await getSettings();

        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          send({ type: "configError", reason: "AI not configured. Set the base URL and model in Settings." });
          return;
        }

        if (contextTabs.size === 0) {
          send({ type: "streamError", reason: "No page context loaded. Add a tab to the context before summarizing.", partialContent: "", canRetry: false });
          return;
        }

        // Refresh from the library so activations/deletions made in the
        // options page take effect without reconnecting the sidebar
        activeSkills = await skillLibrary.getActiveSkills();

        await ensureContextContent();
        const articles = buildContextArticles();

        if (articles.length === 0) {
          send({ type: "streamError", reason: "Could not extract content from the context tabs.", partialContent: "", canRetry: false });
          return;
        }

        await streamSummarization(settings, articles);
      }

      // -----------------------------------------------------------------------
      // Summarization streaming
      // -----------------------------------------------------------------------

      async function streamSummarization(
        settings: Settings,
        articles: ExtractedArticle[],
      ): Promise<void> {
        if (currentTabId === null) return;

        const secureStore = getSecureStore();
        const apiKey = settings.ai.apiKeyRef
          ? await secureStore.getSecret(settings.ai.apiKeyRef)
          : null;

        const client = createStreamingClient({
          baseUrl: settings.ai.baseUrl,
          apiKey: apiKey ?? "",
        });

        const systemPrompt = activeSkills.length > 0
          ? buildCompositePrompt({ skills: activeSkills, articles })
          : settings.ai.systemPrompt || buildDefaultSystemPrompt();

        const userContent = buildSummarizationUserMessage(articles);

        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ];

        abortController = new AbortController();

        send({ type: "streamStart" });

        const result = await client.streamChatCompletion({
          model: settings.ai.modelId,
          messages,
          signal: abortController.signal,
          onToken: (token) => {
            send({ type: "streamToken", token });
          },
        });

        abortController = null;

        if (result.ok) {
          send({ type: "streamEnd", fullContent: result.content });

          // Update tab state with summary
          if (currentTabId !== null) {
            const now = clock();
            const assistantMsg: ConversationMessage = {
              role: "assistant",
              content: result.content,
              timestamp: now,
            };

            const state = tabState.get(currentTabId);
            if (state) {
              tabState.update(currentTabId, {
                summary: result.content,
                conversation: {
                  ...state.conversation,
                  messages: [...state.conversation.messages, assistantMsg],
                  updatedAt: now,
                },
                consecutiveFailures: 0,
              });
            }
          }
        } else {
          if (result.reason === "aborted") {
            // Retain partial content on abort
            send({ type: "streamEnd", fullContent: result.partialContent });
            if (currentTabId !== null) {
              const state = tabState.get(currentTabId);
              if (state && result.partialContent) {
                const now = clock();
                tabState.update(currentTabId, {
                  summary: result.partialContent,
                  conversation: {
                    ...state.conversation,
                    messages: [
                      ...state.conversation.messages,
                      { role: "assistant", content: result.partialContent, timestamp: now, isPartial: true },
                    ],
                    updatedAt: now,
                  },
                });
              }
            }
          } else {
            // Same accounting as the Q&A path: increment first, then decide —
            // the third consecutive failure disables retry (CF-3.3)
            incrementFailures();
            const canRetry = getConsecutiveFailures() < MAX_CONSECUTIVE_FAILURES;
            send({
              type: "streamError",
              reason: result.detail,
              partialContent: result.partialContent,
              canRetry,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // sendMessage handler
      // -----------------------------------------------------------------------

      async function handleSendMessage(text: string): Promise<void> {
        lastUserMessage = text;
        await doSendMessage(text, false);
      }

      async function doSendMessage(text: string, isRetry: boolean): Promise<void> {
        if (currentTabId === null) return;

        const settings = await getSettings();

        // Check AI configuration
        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          send({ type: "configError", reason: "AI endpoint not configured. Please set the base URL and model ID in Settings." });
          return;
        }

        const secureStore = getSecureStore();
        const apiKey = settings.ai.apiKeyRef
          ? await secureStore.getSecret(settings.ai.apiKeyRef)
          : null;

        const client = createStreamingClient({
          baseUrl: settings.ai.baseUrl,
          apiKey: apiKey ?? "",
        });

        // Refresh from the library so activations/deletions made in the
        // options page take effect without reconnecting the sidebar
        activeSkills = await skillLibrary.getActiveSkills();

        // Ensure context tab content is loaded (lazy re-extraction for cached sessions)
        await ensureContextContent();
        const articles = buildContextArticles();

        // Build context messages
        const systemPrompt = activeSkills.length > 0
          ? buildCompositePrompt({ skills: activeSkills, articles })
          : settings.ai.systemPrompt || buildDefaultSystemPrompt();

        const contextMessages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
        ];

        // Add page content as context when no skills are active (composite prompt already includes it when skills present)
        if (activeSkills.length === 0 && articles.length > 0) {
          let pageContextText: string;
          if (articles.length === 1) {
            pageContextText = `Here is the page content for context:\n\n${articles[0].bodyMarkdown}`;
          } else {
            const combined = articles
              .map((a, i) => `### Page ${i + 1}: ${a.title}\nURL: ${a.sourceUrl}\n\n${a.bodyMarkdown}`)
              .join("\n\n---\n\n");
            pageContextText = `Here is the page content for context:\n\n${combined}`;
          }
          contextMessages.push({ role: "user", content: pageContextText });
          contextMessages.push({ role: "assistant", content: "I've read the page content. How can I help you?" });
        }

        // Add conversation history
        const state = tabState.get(currentTabId);
        if (state) {
          for (const msg of state.conversation.messages) {
            contextMessages.push({
              role: msg.role === "user" ? "user" : "assistant",
              content: msg.content,
            });
          }
        }

        // Add the new user message — unless this is a retry and the failed
        // attempt already recorded it as the last history entry, in which
        // case the loop above has already included it (CF-3.2)
        const lastHistory = state?.conversation.messages[state.conversation.messages.length - 1];
        const alreadyInContext = isRetry && lastHistory?.role === "user" && lastHistory.content === text;
        if (!alreadyInContext) {
          contextMessages.push({ role: "user", content: text });
        }

        // Record user message in state (only for new messages, not retries)
        if (!isRetry && state) {
          const now = clock();
          const userMsg: ConversationMessage = {
            role: "user",
            content: text,
            timestamp: now,
          };
          tabState.update(currentTabId, {
            conversation: {
              ...state.conversation,
              messages: [...state.conversation.messages, userMsg],
              updatedAt: now,
            },
            consecutiveFailures: 0,
          });
        }

        abortController = new AbortController();

        send({ type: "streamStart" });

        const result = await client.streamChatCompletion({
          model: settings.ai.modelId,
          messages: contextMessages,
          signal: abortController.signal,
          onToken: (token) => {
            send({ type: "streamToken", token });
          },
        });

        abortController = null;

        if (result.ok) {
          send({ type: "streamEnd", fullContent: result.content });

          // Record assistant message in state
          if (currentTabId !== null) {
            const updatedState = tabState.get(currentTabId);
            if (updatedState) {
              const assistantMsg: ConversationMessage = {
                role: "assistant",
                content: result.content,
                timestamp: clock(),
              };
              tabState.update(currentTabId, {
                conversation: {
                  ...updatedState.conversation,
                  messages: [...updatedState.conversation.messages, assistantMsg],
                  updatedAt: clock(),
                },
                consecutiveFailures: 0,
              });
            }
          }
        } else {
          if (result.reason === "aborted") {
            // Retain partial content on abort
            send({ type: "streamEnd", fullContent: result.partialContent });
            if (currentTabId !== null) {
              const updatedState = tabState.get(currentTabId);
              if (updatedState && result.partialContent) {
                tabState.update(currentTabId, {
                  conversation: {
                    ...updatedState.conversation,
                    messages: [
                      ...updatedState.conversation.messages,
                      { role: "assistant", content: result.partialContent, timestamp: clock(), isPartial: true },
                    ],
                    updatedAt: clock(),
                  },
                });
              }
            }
          } else {
            incrementFailures();
            const canRetry = getConsecutiveFailures() < MAX_CONSECUTIVE_FAILURES;
            send({
              type: "streamError",
              reason: result.detail,
              partialContent: result.partialContent,
              canRetry,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // abort handler
      // -----------------------------------------------------------------------

      function handleAbort(): void {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
      }

      // -----------------------------------------------------------------------
      // retry handler
      // -----------------------------------------------------------------------

      async function handleRetry(): Promise<void> {
        if (currentTabId === null) return;

        const failures = getConsecutiveFailures();
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          // Retry disabled after 3 consecutive failures
          return;
        }

        if (lastUserMessage !== null) {
          // Re-send the last user message (as a retry, not a new message)
          await doSendMessage(lastUserMessage, true);
        } else {
          // Retry summarization
          const settings = await getSettings();
          if (!settings.ai.baseUrl || !settings.ai.modelId) {
            send({ type: "configError", reason: "AI endpoint not configured. Please set the base URL and model ID in Settings." });
            return;
          }

          await ensureContextContent();
          const articles = buildContextArticles();
          if (articles.length > 0) {
            await streamSummarization(settings, articles);
          } else {
            // Nothing to re-send and nothing to summarize — answer instead of
            // leaving the sidebar waiting (CF-3.3)
            send({
              type: "streamError",
              reason: "Nothing to retry — no page context is loaded.",
              partialContent: "",
              canRetry: false,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // loadSkill handler (adds to library + activates)
      // -----------------------------------------------------------------------

      async function handleLoadSkill(raw: string): Promise<void> {
        const result = parseSkillFile(raw);

        if (!result.ok) {
          send({ type: "skillError", errors: result.errors });
          return;
        }

        await activateNewSkill(result.skill);
      }

      /** Adds a parsed skill to the library, activates it, and notifies the sidebar. */
      async function activateNewSkill(skill: SkillDefinition): Promise<void> {
        const stored = await skillLibrary.addSkill(skill);
        await skillLibrary.activateSkill(stored.id);
        activeSkills = [skill];

        // Clear conversation for current tab
        clearConversation();

        // Persist activation greeting as first message in tab state (if non-empty)
        if (skill.activation && currentTabId !== null) {
          const state = tabState.get(currentTabId);
          if (state) {
            const activationMsg: ConversationMessage = {
              role: "assistant",
              content: skill.activation,
              timestamp: clock(),
            };
            tabState.update(currentTabId, {
              conversation: {
                ...state.conversation,
                messages: [activationMsg],
                updatedAt: clock(),
              },
            });
          }
        }

        send({
          type: "skillLoaded",
          name: skill.name,
          description: skill.description,
          activation: skill.activation || null,
        });
      }

      // -----------------------------------------------------------------------
      // generateSkillFromContext handler — derives a new skill from the
      // knowledge in the current context tabs via the AI endpoint
      // -----------------------------------------------------------------------

      async function handleGenerateSkillFromContext(): Promise<void> {
        if (currentTabId === null) return;

        const settings = await getSettings();
        if (!settings.ai.baseUrl || !settings.ai.modelId) {
          send({ type: "configError", reason: "AI not configured. Set the base URL and model in Settings." });
          return;
        }

        if (contextTabs.size === 0) {
          send({ type: "skillError", errors: ["Add at least one tab to context before creating a skill."] });
          return;
        }

        await ensureContextContent();
        const articles = buildContextArticles();

        if (articles.length === 0) {
          send({ type: "skillError", errors: ["Could not extract content from the context tabs."] });
          return;
        }

        send({ type: "skillGenerationStarted" });

        const secureStore = getSecureStore();
        const apiKey = settings.ai.apiKeyRef
          ? await secureStore.getSecret(settings.ai.apiKeyRef)
          : null;

        const client = createStreamingClient({
          baseUrl: settings.ai.baseUrl,
          apiKey: apiKey ?? "",
        });

        const messages: ChatMessage[] = [
          { role: "system", content: SKILL_GENERATION_SYSTEM_PROMPT },
          { role: "user", content: buildSkillGenerationUserMessage(articles) },
        ];

        const result = await client.streamChatCompletion({
          model: settings.ai.modelId,
          messages,
          signal: new AbortController().signal,
          onToken: () => {
            /* the generated skill file is only used once complete; no token-by-token preview */
          },
        });

        if (!result.ok) {
          send({ type: "skillError", errors: [result.detail] });
          return;
        }

        const parsed = parseSkillFile(result.content.trim());
        if (!parsed.ok) {
          send({ type: "skillError", errors: ["The AI's response wasn't a valid skill file.", ...parsed.errors] });
          return;
        }

        await activateNewSkill(parsed.skill);
      }

      // -----------------------------------------------------------------------
      // Library handlers
      // -----------------------------------------------------------------------

      async function handleGetLibrary(): Promise<void> {
        const library = await skillLibrary.getLibrary();
        const snapshot: SkillLibrarySnapshot = {
          skills: library.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
          personas: library.personas.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            skillNames: p.skillIds.map((sid) => library.skills.find((s) => s.id === sid)?.name ?? "Unknown").filter(Boolean),
          })),
          active: library.active,
        };
        send({ type: "libraryState", library: snapshot });
      }

      async function handleActivateSkill(skillId: string): Promise<void> {
        await handleActivation("skill", skillId);
      }

      async function handleActivatePersona(personaId: string): Promise<void> {
        await handleActivation("persona", personaId);
      }

      async function handleActivation(kind: "skill" | "persona", id: string): Promise<void> {
        try {
          if (kind === "skill") {
            await skillLibrary.activateSkill(id);
          } else {
            await skillLibrary.activatePersona(id);
          }
          activeSkills = await skillLibrary.getActiveSkills();
          clearConversation();

          const activation = activeSkills[0]?.activation || null;
          if (activation && currentTabId !== null) {
            const state = tabState.get(currentTabId);
            if (state) {
              tabState.update(currentTabId, {
                conversation: { ...state.conversation, messages: [{ role: "assistant", content: activation, timestamp: clock() }], updatedAt: clock() },
              });
            }
          }

          const library = await skillLibrary.getLibrary();
          send({ type: "activationChanged", active: library.active, names: activeSkills.map((s) => s.name) });
        } catch {
          send({ type: "skillError", errors: [`${kind === "skill" ? "Skill" : "Persona"} not found in library`] });
        }
      }

      async function handleDeactivate(): Promise<void> {
        await skillLibrary.deactivate();
        activeSkills = [];
        clearConversation();
        send({ type: "skillCleared" });
      }

      // -----------------------------------------------------------------------
      // clearConversation helper
      // -----------------------------------------------------------------------

      function clearConversation(): void {
        if (currentTabId === null) return;

        const state = tabState.get(currentTabId);
        if (state) {
          const now = clock();
          tabState.update(currentTabId, {
            summary: null,
            conversation: {
              ...state.conversation,
              messages: [],
              updatedAt: now,
            },
            consecutiveFailures: 0,
          });
        }

        // Notify sidebar that the conversation is now empty
        send({ type: "conversationRestored", messages: [] });
      }

      // -----------------------------------------------------------------------
      // Helpers
      // -----------------------------------------------------------------------

      function getConsecutiveFailures(): number {
        if (currentTabId === null) return 0;
        const state = tabState.get(currentTabId);
        return state?.consecutiveFailures ?? 0;
      }

      function incrementFailures(): void {
        if (currentTabId === null) return;
        const state = tabState.get(currentTabId);
        if (state) {
          tabState.update(currentTabId, {
            consecutiveFailures: state.consecutiveFailures + 1,
          });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function buildDefaultSystemPrompt(): string {
  return `You are a helpful assistant that summarizes web page content. When summarizing, produce output with three sections:
- **Findings**: Key information and facts from the page
- **Key Points**: The most important takeaways
- **Action Items**: Suggested next steps or actions based on the content

Format your response using Markdown bullet lists.`;
}

const SKILL_GENERATION_SYSTEM_PROMPT = `You turn web page content into a reusable "skill" file for an AI assistant. Output ONLY the skill file itself — no commentary, no code fences, nothing before or after it.

The skill file format is:

---
name: <short, descriptive name for the domain/topic covered by the pages>
description: <one sentence describing what this skill knows>
---

## Personality
<2-4 sentences written in first person establishing the assistant's persona and expertise on this topic>

## Knowledge
<a well-organized synthesis of the key facts, concepts, and details from the provided pages, written so the persona can draw on it as background knowledge in future conversations>

Rules:
- The frontmatter must start on the very first line with "---".
- "name" and "description" are required frontmatter fields.
- The "## Personality" section is required and must not be empty.
- Do not include an "## Activation" section.
- Do not wrap the output in Markdown code fences.`;

function buildSkillGenerationUserMessage(articles: ExtractedArticle[]): string {
  const pages = articles
    .map((a, i) => `## Page ${i + 1}: ${a.title}\nURL: ${a.sourceUrl}\n\n${a.bodyMarkdown}`)
    .join("\n\n---\n\n");
  return `Generate a skill file that captures the knowledge in the following web page(s):\n\n${pages}`;
}

function buildSummarizationUserMessage(articles: ExtractedArticle[]): string {
  if (articles.length === 0) {
    return "Please summarize the provided content.";
  }
  if (articles.length === 1) {
    const a = articles[0];
    return `Please summarize the following web page:\n\nTitle: ${a.title}\nURL: ${a.sourceUrl}\n\nContent:\n${a.bodyMarkdown}`;
  }
  const pagesText = articles
    .map((a, i) => `## Page ${i + 1}: ${a.title}\nURL: ${a.sourceUrl}\n\n${a.bodyMarkdown}`)
    .join("\n\n---\n\n");
  return `Please summarize the following web pages:\n\n${pagesText}`;
}
