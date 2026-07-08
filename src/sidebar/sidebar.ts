/**
 * Sidebar entry point — vanilla TypeScript UI for the Distill chat interface.
 *
 * State machine: loading → no-page | persona-chat | summarizing → ready → streaming → error → config-error
 * Connects to background via long-lived port ("chat") and exchanges typed port protocol messages.
 */

import { createActiveTabTracker, type ActiveTabTracker } from "./active-tab-tracker";
import { renderMarkdown } from "./markdown";
import {
  type ControllerToSidebarMessage,
  type SidebarToControllerMessage,
  type PortConversationMessage,
  type PortAutoExportStatus,
  type SkillLibrarySnapshot,
  type ActiveSelectionPort,
  isControllerToSidebarMessage,
} from "@shared/port-protocol";
import { isMessageOfKind, buildMessage } from "@shared/messages";

// ─── State Machine ───────────────────────────────────────────────────────────

type SidebarState =
  | { readonly phase: "loading" }
  | { readonly phase: "no-page" }
  | { readonly phase: "persona-chat"; readonly messages: ReadonlyArray<PortConversationMessage> }
  | { readonly phase: "summarizing"; readonly title: string; readonly partialContent: string }
  | { readonly phase: "ready"; readonly messages: ReadonlyArray<PortConversationMessage> }
  | { readonly phase: "streaming"; readonly messages: ReadonlyArray<PortConversationMessage>; readonly partial: string; readonly returnPhase: "ready" | "persona-chat" }
  | {
      readonly phase: "error";
      readonly reason: string;
      readonly canRetry: boolean;
      readonly showPicker: boolean;
      // The conversation stays visible alongside the error (CF-3.3), and a
      // retried stream returns to the phase the failure came from.
      readonly messages: ReadonlyArray<PortConversationMessage>;
      readonly returnPhase: "ready" | "persona-chat";
    }
  | { readonly phase: "config-error"; readonly reason: string };

// Display info for context tabs (subset of what the controller tracks)
interface ContextTabInfo {
  tabId: number;
  url: string;
  title: string;
  confidence: "high" | "medium" | "low" | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MESSAGE_CHAR_LIMIT = 2000;
const EXTENSION_VERSION = browser.runtime.getManifest().version;

// ─── Module State ────────────────────────────────────────────────────────────

let state: SidebarState = { phase: "loading" };
let autoExportStatus: PortAutoExportStatus | null = null;
let port: ReturnType<typeof browser.runtime.connect> | null = null;
let tracker: ActiveTabTracker | null = null;
let currentTabId: number | null = null;
let hasSavedPattern = false; // Whether the current site has a saved selector
let lowConfidence = false; // Whether extraction had low confidence
let pageWordCount: number | null = null; // Word count of extracted content (for reading-time estimate)
let configWarning: string | null = null; // Non-blocking AI config warning
let botAvatarDataUri: string | null = null; // Bot avatar data URI (independent of skill)
let avatarError: string | null = null; // Avatar validation error message
let showHelpMenu = false;

// ─── Context Tab State ───────────────────────────────────────────────────────

let contextTabs: ContextTabInfo[] = [];
let openTabsList: { tabId: number; title: string; url: string }[] = [];
let showTabPicker = false;

// ─── Skill State ─────────────────────────────────────────────────────────────

let activeSkillName: string | null = null;
let activeSkillDescription: string | null = null;
let skillError: string | null = null;
let skillErrorTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── Library State ──────────────────────────────────────────────────────────

let librarySnapshot: SkillLibrarySnapshot | null = null;

// ─── DOM References ──────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

// ─── Port Communication ──────────────────────────────────────────────────────

function connectPort(): void {
  port = browser.runtime.connect({ name: "chat" });

  port.onMessage.addListener((raw: unknown) => {
    // Clipboard delivery request from the export pipeline (CF-4.4): the
    // background can only reach the clipboard through a document context.
    if (isMessageOfKind(raw, "clipboardWrite")) {
      void handleClipboardWrite(raw.payload.content);
      return;
    }
    if (!isControllerToSidebarMessage(raw)) return;
    handleControllerMessage(raw);
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });
}

async function handleClipboardWrite(content: string): Promise<void> {
  const ok = await writeToClipboard(content);
  if (port) {
    port.postMessage(buildMessage("clipboardResult", ok ? { ok: true } : { ok: false, reason: "clipboard-write-failed" }));
  }
}

async function writeToClipboard(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // Fall back to execCommand for contexts where the async API is unavailable
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function sendToController(msg: SidebarToControllerMessage): void {
  if (port) {
    port.postMessage(msg);
  }
}

function handleControllerMessage(msg: ControllerToSidebarMessage): void {
  switch (msg.type) {
    case "personaModeReady":
      // about:blank or similar — enter persona chat mode with no page context
      contextTabs = [];
      state = { phase: "persona-chat", messages: msg.messages ? [...msg.messages] : [] };
      configWarning = null;
      render();
      break;

    case "contextLoaded":
      // Content extracted — go to ready state (user can click Summarize)
      contextTabs = [{ tabId: currentTabId!, url: msg.url, title: msg.title, confidence: msg.confidence }];
      state = { phase: "ready", messages: [] };
      configWarning = null;
      lowConfidence = msg.confidence === "low";
      hasSavedPattern = msg.hasSavedPattern;
      pageWordCount = msg.wordCount;
      render();
      break;

    case "contextTabAdded":
      // A tab was added to the conversation context
      if (!contextTabs.some((t) => t.tabId === msg.tabId)) {
        contextTabs = [...contextTabs, { tabId: msg.tabId, url: msg.url, title: msg.title, confidence: msg.confidence }];
      }
      // Close the tab picker after adding
      showTabPicker = false;
      render();
      break;

    case "contextTabFailed":
      // Tab extraction failed — close picker but don't add to context
      showTabPicker = false;
      render();
      break;

    case "contextTabRemoved":
      contextTabs = contextTabs.filter((t) => t.tabId !== msg.tabId);
      render();
      break;

    case "openTabs":
      openTabsList = [...msg.tabs];
      showTabPicker = true;
      render();
      break;

    case "contextError":
      // If the error is about page type (about:, moz-extension:, etc.), show a
      // friendly "no page" state instead of a scary error
      if (msg.reason.includes("Cannot extract content from this page type") ||
          msg.reason.includes("Tab not accessible")) {
        state = { phase: "no-page" };
      } else {
        state = {
          phase: "error",
          reason: msg.reason,
          canRetry: msg.canRetry,
          showPicker: true,
          messages: [],
          returnPhase: "ready",
        };
      }
      render();
      break;

    case "conversationRestored":
      state = { phase: "ready", messages: msg.messages };
      render();
      break;

    case "streamStart":
      if (state.phase === "summarizing") {
        // Stay in summarizing, streaming will come via tokens
      } else if (state.phase === "ready") {
        state = { phase: "streaming", messages: state.messages, partial: "", returnPhase: "ready" };
      } else if (state.phase === "persona-chat") {
        state = { phase: "streaming", messages: state.messages, partial: "", returnPhase: "persona-chat" };
      } else if (state.phase === "error") {
        // Retried stream — render it exactly like a first attempt (CF-3.3)
        state = { phase: "streaming", messages: state.messages, partial: "", returnPhase: state.returnPhase };
      } else if (state.phase === "loading") {
        state = { phase: "streaming", messages: [], partial: "", returnPhase: "ready" };
      }
      render();
      break;

    case "streamToken": {
      if (state.phase === "summarizing") {
        state = { ...state, partialContent: state.partialContent + msg.token };
        const partialEl = app.querySelector<HTMLElement>(".partial-content");
        if (partialEl) {
          partialEl.innerHTML = renderMarkdown(state.partialContent);
          break; // skip full render — patch only
        }
      } else if (state.phase === "streaming") {
        state = { ...state, partial: state.partial + msg.token };
        const partialEl = app.querySelector<HTMLElement>(".message-partial .message-content");
        if (partialEl) {
          partialEl.innerHTML = renderMarkdown(state.partial);
          const list = app.querySelector(".messages-list");
          if (list) list.scrollTop = list.scrollHeight;
          break; // skip full render — patch only
        }
      }
      render(); // first token (element doesn't exist yet) — do full render to create it
      break;
    }

    case "streamEnd": {
      // An empty fullContent means an aborted stream with nothing received —
      // don't append an empty assistant message.
      const hasContent = msg.fullContent.trim().length > 0;
      const endMsg: PortConversationMessage = {
        role: "assistant",
        content: msg.fullContent,
        timestamp: new Date().toISOString(),
      };
      if (state.phase === "summarizing") {
        state = { phase: "ready", messages: hasContent ? [endMsg] : [] };
      } else if (state.phase === "streaming") {
        const returnPhase = state.returnPhase;
        const newMessages = hasContent ? [...state.messages, endMsg] : [...state.messages];
        if (returnPhase === "persona-chat") {
          state = { phase: "persona-chat", messages: newMessages };
        } else {
          state = { phase: "ready", messages: newMessages };
        }
      }
      render();
      break;
    }

    case "streamError": {
      // Keep the conversation visible alongside the error; the controller is
      // the single source of truth for whether retry is still allowed (CF-3.3).
      const prior: { messages: ReadonlyArray<PortConversationMessage>; returnPhase: "ready" | "persona-chat" } =
        state.phase === "streaming"
          ? { messages: state.messages, returnPhase: state.returnPhase }
          : state.phase === "persona-chat"
            ? { messages: state.messages, returnPhase: "persona-chat" }
            : state.phase === "ready"
              ? { messages: state.messages, returnPhase: "ready" }
              : { messages: [], returnPhase: "ready" };
      state = {
        phase: "error",
        reason: msg.reason,
        canRetry: msg.canRetry,
        showPicker: false,
        messages: prior.messages,
        returnPhase: prior.returnPhase,
      };
      render();
      break;
    }

    case "configError":
      if (state.phase === "ready" || state.phase === "summarizing" || state.phase === "persona-chat") {
        configWarning = msg.reason;
        // summarizing can't stay mid-stream without AI; clear to ready (persona-chat preserved)
        if (state.phase === "summarizing") state = { phase: "ready", messages: [] };
      } else {
        state = { phase: "config-error", reason: msg.reason };
      }
      render();
      break;

    case "autoExportStatus":
      autoExportStatus = msg.status;
      render();
      break;

    case "skillLoaded":
      activeSkillName = msg.name;
      activeSkillDescription = msg.description;
      skillError = null;
      if (skillErrorTimeout) {
        clearTimeout(skillErrorTimeout);
        skillErrorTimeout = null;
      }
      if (msg.activation) {
        const greetingMsg: PortConversationMessage = {
          role: "assistant",
          content: msg.activation,
          timestamp: new Date().toISOString(),
        };
        setReadyPhase([greetingMsg]);
      } else {
        setReadyPhase();
      }
      render();
      break;

    case "skillCleared":
      activeSkillName = null;
      activeSkillDescription = null;
      render();
      break;

    case "skillError":
      skillError = msg.errors.join(", ");
      if (skillErrorTimeout) {
        clearTimeout(skillErrorTimeout);
      }
      skillErrorTimeout = setTimeout(() => {
        skillError = null;
        skillErrorTimeout = null;
        render();
      }, 5000);
      render();
      break;

    case "libraryState":
      librarySnapshot = msg.library;
      render();
      break;

    case "activationChanged":
      if (msg.names.length > 0) {
        activeSkillName = msg.names.join(" + ");
        activeSkillDescription = msg.active.kind === "persona" ? `Persona with ${msg.names.length} skills` : null;
      } else {
        activeSkillName = null;
        activeSkillDescription = null;
      }
      // Update library snapshot active state
      if (librarySnapshot) {
        librarySnapshot = { ...librarySnapshot, active: msg.active };
      }
      setReadyPhase();
      render();
      break;
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function render(): void {
  app.innerHTML = "";

  const container = el("div", "sidebar-container");

  // Header
  container.appendChild(renderHeader());

  // Main content area based on state
  const content = el("div", "sidebar-content");
  switch (state.phase) {
    case "loading":
      content.appendChild(renderLoading());
      break;
    case "no-page":
      content.appendChild(renderNoPage());
      break;
    case "persona-chat":
      content.appendChild(renderPersonaChat());
      break;
    case "summarizing":
      content.appendChild(renderSummarizing());
      break;
    case "ready":
      if (state.messages.length === 0) {
        content.appendChild(renderReadyNoSummary());
      } else {
        content.appendChild(renderContextSection());
        content.appendChild(renderMessages(state.messages));
        if (pageWordCount !== null && pageWordCount > 0) {
          const mins = Math.max(1, Math.ceil(pageWordCount / 200));
          const hint = el("div", "time-saved-hint");
          hint.textContent = `✓ ~${mins} min saved`;
          content.appendChild(hint);
        }
      }
      if (configWarning) {
        content.appendChild(renderConfigWarningBanner());
      }
      if (lowConfidence) {
        content.appendChild(renderLowConfidenceHint());
      }
      if (state.messages.length > 0) {
        content.appendChild(renderInputArea());
      }
      break;
    case "streaming":
      content.appendChild(renderMessages(state.messages, state.partial));
      content.appendChild(renderStreamingControls());
      break;
    case "error":
      content.appendChild(renderError());
      break;
    case "config-error":
      content.appendChild(renderConfigError());
      break;
  }

  container.appendChild(content);

  // Footer with export controls (visible when content is available)
  if (state.phase === "ready" || state.phase === "streaming" || state.phase === "summarizing" || state.phase === "persona-chat" || (state.phase === "config-error" && currentTabId != null)) {
    container.appendChild(renderFooter());
  }

  app.appendChild(container);

  // Auto-scroll to bottom of messages
  const messagesEl = app.querySelector(".messages-list");
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function renderHeader(): HTMLElement {
  const header = el("header", "sidebar-header");

  // Bot avatar (circular, displayed before title when set)
  if (botAvatarDataUri) {
    const avatar = document.createElement("img") as HTMLImageElement;
    avatar.className = "bot-avatar";
    avatar.src = botAvatarDataUri;
    avatar.alt = "Bot avatar";
    header.appendChild(avatar);
  }

  const title = el("h1", "sidebar-title");
  if (activeSkillName) {
    title.className = "sidebar-title skill-indicator";
    title.textContent = activeSkillName;
    if (activeSkillDescription) {
      title.title = activeSkillDescription;
    }
  } else {
    title.textContent = "Distill";
  }
  header.appendChild(title);

  const headerControls = el("div", "header-controls");

  // Reset button — visible when we have content loaded
  if (state.phase === "ready" || state.phase === "streaming" || state.phase === "summarizing") {
    const resetBtn = el("button", "btn-reset") as HTMLButtonElement;
    resetBtn.textContent = "↻ Reset";
    resetBtn.title = "Reset — re-extract current page";
    resetBtn.setAttribute("aria-label", "Reset — re-extract current page");
    resetBtn.addEventListener("click", () => {
      if (currentTabId == null) return;
      resetLocalNav();
      render();
      sendToController({ type: "abort" });
      sendToController({ type: "init", tabId: currentTabId });
    });
    headerControls.appendChild(resetBtn);
  }

  // New chat button — visible in page-context states; drops page context and enters persona-chat
  if (state.phase === "ready" || state.phase === "streaming" || state.phase === "summarizing") {
    const newChatBtn = el("button", "btn-new-chat") as HTMLButtonElement;
    newChatBtn.textContent = "✦ New chat";
    newChatBtn.title = "New chat — clear page context and chat with persona";
    newChatBtn.setAttribute("aria-label", "New chat — clear page context and chat with persona");
    newChatBtn.addEventListener("click", () => {
      if (currentTabId == null) return;
      resetLocalNav();
      render();
      sendToController({ type: "abort" });
      sendToController({ type: "init", tabId: currentTabId, url: "about:blank" });
    });
    headerControls.appendChild(newChatBtn);
  }

  // Help button — always visible, regardless of phase
  const helpWrapper = el("div", "help-menu");
  const helpBtn = el("button", "btn-help") as HTMLButtonElement;
  helpBtn.textContent = "❓ Help";
  helpBtn.title = "Help — version info and links";
  helpBtn.setAttribute("aria-label", "Help — version info and links");
  helpBtn.addEventListener("click", () => {
    showHelpMenu = !showHelpMenu;
    render();
  });
  helpWrapper.appendChild(helpBtn);

  if (showHelpMenu) {
    const helpDropdown = el("div", "help-menu-dropdown");

    const version = el("div", "help-menu-version");
    version.textContent = `Distill v${EXTENSION_VERSION}`;
    helpDropdown.appendChild(version);

    const settingsLink = el("a", "help-menu-link help-menu-settings") as HTMLAnchorElement;
    settingsLink.href = "#";
    settingsLink.textContent = "⚙️ Settings";
    settingsLink.addEventListener("click", (e) => {
      e.preventDefault();
      showHelpMenu = false;
      browser.runtime.openOptionsPage();
      render();
    });
    helpDropdown.appendChild(settingsLink);

    const issuesLink = el("a", "help-menu-link help-menu-external") as HTMLAnchorElement;
    issuesLink.href = "https://github.com/dstaulcu/distill/issues";
    issuesLink.target = "_blank";
    issuesLink.rel = "noopener";
    issuesLink.textContent = "Report an issue";
    helpDropdown.appendChild(issuesLink);

    const releasesLink = el("a", "help-menu-link help-menu-external") as HTMLAnchorElement;
    releasesLink.href = "https://github.com/dstaulcu/distill/releases";
    releasesLink.target = "_blank";
    releasesLink.rel = "noopener";
    releasesLink.textContent = "Releases";
    helpDropdown.appendChild(releasesLink);

    const closeBtn = el("button", "help-menu-close") as HTMLButtonElement;
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", () => {
      showHelpMenu = false;
      render();
    });
    helpDropdown.appendChild(closeBtn);

    helpWrapper.appendChild(helpDropdown);
  }

  headerControls.appendChild(helpWrapper);

  header.appendChild(headerControls);

  return header;
}

function renderLoading(): HTMLElement {
  const wrapper = el("div", "state-loading");
  const spinner = el("div", "spinner");
  const text = el("p", "loading-text");
  text.textContent = "Loading…";
  wrapper.appendChild(spinner);
  wrapper.appendChild(text);
  return wrapper;
}

function renderNoPage(): HTMLElement {
  const wrapper = el("div", "state-no-page");
  const text = el("p", "no-page-text");
  text.textContent = "Navigate to a web page to get started. Distill can't extract content from browser internal pages.";
  wrapper.appendChild(text);
  return wrapper;
}

function renderPersonaChat(): HTMLElement {
  const wrapper = el("div", "state-persona-chat");
  const personaState = state as { phase: "persona-chat"; messages: ReadonlyArray<PortConversationMessage> };

  // Context section (prominent — it's the main action here)
  wrapper.appendChild(renderContextSection());

  if (configWarning) {
    wrapper.appendChild(renderConfigWarningBanner());
  }

  // Chat messages (if any)
  if (personaState.messages.length > 0) {
    wrapper.appendChild(renderMessages(personaState.messages));
  } else if (contextTabs.length === 0) {
    // Empty state hint
    const hint = el("p", "persona-chat-hint");
    hint.textContent = "Add page context above, select a persona, then start chatting.";
    wrapper.appendChild(hint);
  }

  // Chat input — always visible in persona-chat mode
  wrapper.appendChild(renderInputArea());

  return wrapper;
}

function renderReadyNoSummary(): HTMLElement {
  const wrapper = el("div", "state-ready-no-summary");

  wrapper.appendChild(renderContextSection());

  const pageInfo = el("div", "page-info");

  const primaryTab = contextTabs[0];
  if (primaryTab?.title) {
    const titleEl = el("p", "page-info-title");
    titleEl.textContent = primaryTab.title;
    titleEl.title = primaryTab.url;
    pageInfo.appendChild(titleEl);
  }

  if (pageWordCount !== null && pageWordCount > 0) {
    const mins = Math.max(1, Math.ceil(pageWordCount / 200));
    const badge = el("span", "page-info-reading-time");
    badge.textContent = `~${mins} min read`;
    pageInfo.appendChild(badge);
  }

  wrapper.appendChild(pageInfo);

  const actions = el("div", "ready-actions");

  const summarizeBtn = el("button", "btn btn-summarize") as HTMLButtonElement;
  summarizeBtn.textContent = "Summarize";
  summarizeBtn.addEventListener("click", () => {
    sendToController({ type: "summarize" });
    state = { phase: "summarizing", title: "", partialContent: "" };
    render();
  });
  actions.appendChild(summarizeBtn);

  wrapper.appendChild(actions);
  return wrapper;
}

// ─── Context Section ─────────────────────────────────────────────────────────

function renderContextSection(): HTMLElement {
  const strip = el("div", "context-strip");

  for (const tab of contextTabs) {
    const chip = el("div", "context-chip");

    const titleSpan = el("span", "context-chip-title");
    titleSpan.textContent = truncate(tab.title || tab.url, 22);
    titleSpan.title = `${tab.title}\n${tab.url}`;
    chip.appendChild(titleSpan);

    const removeBtn = el("button", "context-chip-remove") as HTMLButtonElement;
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${tab.title} from context`;
    removeBtn.setAttribute("aria-label", `Remove ${tab.title} from context`);
    const tabId = tab.tabId;
    removeBtn.addEventListener("click", () => {
      sendToController({ type: "removeContextTab", tabId });
    });
    chip.appendChild(removeBtn);

    strip.appendChild(chip);
  }

  // "+" chip — opens/closes the tab picker
  const addBtn = el("button", "context-chip context-chip-add") as HTMLButtonElement;
  addBtn.textContent = "＋ Add tab";
  addBtn.title = "Add an open tab to this conversation's context";
  addBtn.setAttribute("aria-label", "Add an open tab to this conversation's context");
  addBtn.addEventListener("click", () => {
    if (showTabPicker) {
      showTabPicker = false;
      render();
    } else {
      sendToController({ type: "getOpenTabs" });
    }
  });
  strip.appendChild(addBtn);

  if (showTabPicker) {
    const picker = el("div", "tab-picker-dropdown");

    const contextTabIds = new Set(contextTabs.map((t) => t.tabId));
    const available = openTabsList.filter((t) => !contextTabIds.has(t.tabId));

    if (available.length === 0) {
      const empty = el("div", "tab-picker-empty");
      empty.textContent = openTabsList.length > 0
        ? "All open tabs are already in context."
        : "No open tabs available.";
      picker.appendChild(empty);
    } else {
      for (const tab of available) {
        const item = el("button", "tab-picker-item") as HTMLButtonElement;
        item.textContent = truncate(tab.title || tab.url, 45);
        item.title = `${tab.title}\n${tab.url}`;
        const tabId = tab.tabId;
        item.addEventListener("click", () => {
          sendToController({ type: "addContextTab", tabId });
          showTabPicker = false;
          render();
        });
        picker.appendChild(item);
      }
    }

    const closeBtn = el("button", "tab-picker-close") as HTMLButtonElement;
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", () => {
      showTabPicker = false;
      render();
    });
    picker.appendChild(closeBtn);

    strip.appendChild(picker);
  }

  return strip;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

function renderSummarizing(): HTMLElement {
  const wrapper = el("div", "state-summarizing");

  const titleEl = el("p", "summarizing-title");
  titleEl.textContent = `Summarizing: ${(state as { title: string }).title}`;
  wrapper.appendChild(titleEl);

  const partial = (state as { partialContent: string }).partialContent;
  if (partial) {
    const contentEl = el("div", "partial-content");
    contentEl.innerHTML = renderMarkdown(partial);
    wrapper.appendChild(contentEl);
  }

  const spinner = el("div", "spinner");
  wrapper.appendChild(spinner);

  // Abort button during summarization. The controller answers the abort with
  // a streamEnd carrying the partial content, which stays visible (CF-2.5) —
  // so don't reset the view here.
  const abortBtn = el("button", "btn btn-abort") as HTMLButtonElement;
  abortBtn.textContent = "Cancel";
  abortBtn.addEventListener("click", () => {
    sendToController({ type: "abort" });
    abortBtn.disabled = true;
    abortBtn.textContent = "Cancelling…";
  });
  wrapper.appendChild(abortBtn);

  return wrapper;
}

function renderMessages(messages: ReadonlyArray<PortConversationMessage>, partial?: string): HTMLElement {
  const wrapper = el("div", "messages-list");

  for (const msg of messages) {
    const msgEl = el("div", `message message-${msg.role}`);
    const roleLabel = el("span", "message-role");
    roleLabel.textContent = msg.role === "user" ? "You" : "Distill";
    msgEl.appendChild(roleLabel);

    const contentEl = el("div", "message-content");
    contentEl.innerHTML = renderMarkdown(msg.content);
    msgEl.appendChild(contentEl);

    wrapper.appendChild(msgEl);
  }

  // Partial streaming content or waiting indicator
  if (partial !== undefined) {
    const partialEl = el("div", "message message-assistant message-partial");
    const roleLabel = el("span", "message-role");
    roleLabel.textContent = "Distill";
    partialEl.appendChild(roleLabel);

    if (partial) {
      const contentEl = el("div", "message-content");
      contentEl.innerHTML = renderMarkdown(partial);
      partialEl.appendChild(contentEl);
    } else {
      const spinner = el("div", "spinner spinner-inline");
      partialEl.appendChild(spinner);
    }

    wrapper.appendChild(partialEl);
  }

  return wrapper;
}

function renderLowConfidenceHint(): HTMLElement {
  const wrapper = el("div", "low-confidence-hint");
  const link = el("a", "picker-link") as HTMLAnchorElement;
  link.href = "#";
  link.textContent = hasSavedPattern ? "Update selector" : "Wrong content? Pick the right area";
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    const original = link.textContent!;
    await activatePicker(
      () => { link.textContent = "Selecting…"; },
      () => { link.textContent = original; }
    );
  });
  wrapper.appendChild(link);
  return wrapper;
}

function renderConfigWarningBanner(): HTMLElement {
  const wrapper = el("div", "config-warning-banner");

  const icon = el("span", "config-warning-icon");
  icon.textContent = "⚙️";
  wrapper.appendChild(icon);

  const text = el("span", "config-warning-text");
  text.textContent = configWarning ?? "AI not configured";
  wrapper.appendChild(text);

  const link = el("a", "settings-link-inline") as HTMLAnchorElement;
  link.textContent = "Settings";
  link.href = "#";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
  wrapper.appendChild(link);

  return wrapper;
}

function renderInputArea(): HTMLElement {
  const wrapper = el("div", "input-area");

  const textarea = document.createElement("textarea");
  textarea.className = "message-input";
  textarea.placeholder = "Ask a follow-up question…";
  textarea.maxLength = MESSAGE_CHAR_LIMIT;
  textarea.rows = 3;
  textarea.setAttribute("aria-label", "Message input");

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage(textarea.value);
    }
  });

  const sendBtn = el("button", "btn btn-send") as HTMLButtonElement;
  sendBtn.textContent = "Send";
  sendBtn.addEventListener("click", () => {
    submitMessage(textarea.value);
  });

  wrapper.appendChild(textarea);

  const controls = el("div", "input-controls");
  controls.appendChild(sendBtn);
  wrapper.appendChild(controls);

  return wrapper;
}

function renderStreamingControls(): HTMLElement {
  const wrapper = el("div", "streaming-controls");

  const abortBtn = el("button", "btn btn-abort") as HTMLButtonElement;
  abortBtn.textContent = "Stop";
  abortBtn.setAttribute("aria-label", "Stop streaming");
  abortBtn.addEventListener("click", () => {
    sendToController({ type: "abort" });
  });
  wrapper.appendChild(abortBtn);

  return wrapper;
}

function renderError(): HTMLElement {
  const wrapper = el("div", "state-error");
  const errorState = state as {
    reason: string;
    canRetry: boolean;
    showPicker: boolean;
    messages: ReadonlyArray<PortConversationMessage>;
    returnPhase: "ready" | "persona-chat";
  };

  // The conversation stays visible; the error renders alongside it (CF-3.3)
  if (errorState.messages.length > 0) {
    wrapper.appendChild(renderMessages(errorState.messages));
  }

  const icon = el("div", "error-icon");
  icon.textContent = "⚠️";
  wrapper.appendChild(icon);

  const reason = el("p", "error-reason");
  reason.textContent = errorState.reason;
  wrapper.appendChild(reason);

  const actions = el("div", "error-actions");

  if (errorState.canRetry) {
    const retryBtn = el("button", "btn btn-retry") as HTMLButtonElement;
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      if (errorState.showPicker) {
        // Context/extraction error — the fix is a fresh init, not a re-send
        if (currentTabId == null) return;
        resetLocalNav();
        render();
        sendToController({ type: "init", tabId: currentTabId });
        return;
      }
      // Enter streaming immediately so the retried stream renders like a
      // first attempt instead of leaving the view on a spinner (CF-3.3)
      state = { phase: "streaming", messages: errorState.messages, partial: "", returnPhase: errorState.returnPhase };
      render();
      sendToController({ type: "retry" });
    });
    actions.appendChild(retryBtn);
  }

  if (errorState.showPicker) {
    const pickerBtn = el("button", "btn btn-picker") as HTMLButtonElement;
    pickerBtn.textContent = hasSavedPattern ? "Update selector" : "Select content area";
    pickerBtn.addEventListener("click", async () => {
      const original = pickerBtn.textContent!;
      await activatePicker(
        () => { pickerBtn.disabled = true; pickerBtn.textContent = "Selecting…"; },
        () => { pickerBtn.disabled = false; pickerBtn.textContent = original; }
      );
    });
    actions.appendChild(pickerBtn);
  }

  wrapper.appendChild(actions);
  return wrapper;
}

function renderConfigError(): HTMLElement {
  const wrapper = el("div", "state-config-error");
  const configState = state as { reason: string };

  const icon = el("div", "error-icon");
  icon.textContent = "⚙️";
  wrapper.appendChild(icon);

  const reason = el("p", "config-error-reason");
  reason.textContent = configState.reason;
  wrapper.appendChild(reason);

  const link = el("a", "settings-link") as HTMLAnchorElement;
  link.textContent = "Open Settings";
  link.href = "#";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
  wrapper.appendChild(link);

  return wrapper;
}

function renderSkillSection(): HTMLElement {
  const section = el("div", "skill-section");

  // Library picker (select)
  if (librarySnapshot && (librarySnapshot.skills.length > 0 || librarySnapshot.personas.length > 0)) {
    const picker = document.createElement("select") as HTMLSelectElement;
    picker.className = "skill-picker";
    picker.setAttribute("aria-label", "Active skill or persona");

    // None option
    const noneOpt = document.createElement("option");
    noneOpt.value = "none";
    noneOpt.textContent = "— None —";
    if (librarySnapshot.active.kind === "none") noneOpt.selected = true;
    picker.appendChild(noneOpt);

    // Skills optgroup
    if (librarySnapshot.skills.length > 0) {
      const skillGroup = document.createElement("optgroup");
      skillGroup.label = "Skills";
      for (const s of librarySnapshot.skills) {
        const opt = document.createElement("option");
        opt.value = `skill:${s.id}`;
        opt.textContent = s.name;
        if (librarySnapshot.active.kind === "skill" && librarySnapshot.active.skillId === s.id) opt.selected = true;
        skillGroup.appendChild(opt);
      }
      picker.appendChild(skillGroup);
    }

    // Personas optgroup
    if (librarySnapshot.personas.length > 0) {
      const personaGroup = document.createElement("optgroup");
      personaGroup.label = "Personas";
      for (const p of librarySnapshot.personas) {
        const opt = document.createElement("option");
        opt.value = `persona:${p.id}`;
        opt.textContent = `${p.name} (${p.skillNames.length} skills)`;
        if (librarySnapshot.active.kind === "persona" && librarySnapshot.active.personaId === p.id) opt.selected = true;
        personaGroup.appendChild(opt);
      }
      picker.appendChild(personaGroup);
    }

    picker.addEventListener("change", () => {
      const val = picker.value;
      if (val === "none") {
        sendToController({ type: "deactivate" });
      } else if (val.startsWith("skill:")) {
        sendToController({ type: "activateSkill", skillId: val.slice(6) });
      } else if (val.startsWith("persona:")) {
        sendToController({ type: "activatePersona", personaId: val.slice(8) });
      }
    });

    section.appendChild(picker);
  }

  // Upload controls
  const controls = el("div", "skill-controls");

  const fileInput = document.createElement("input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".md";
  fileInput.style.display = "none";
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleSkillFile(fileInput.files[0]);
      fileInput.value = "";
    }
  });

  const chooseBtn = el("button", "btn-choose-skill") as HTMLButtonElement;
  chooseBtn.textContent = "Add Skill";
  chooseBtn.addEventListener("click", () => {
    fileInput.click();
  });

  controls.appendChild(fileInput);
  controls.appendChild(chooseBtn);

  if (activeSkillName) {
    const clearBtn = el("button", "btn-clear-skill") as HTMLButtonElement;
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      sendToController({ type: "deactivate" });
    });
    controls.appendChild(clearBtn);
  }

  section.appendChild(controls);

  // Error display
  if (skillError) {
    const errorEl = el("div", "skill-error");
    errorEl.textContent = skillError;
    section.appendChild(errorEl);
  }

  // ─── Bot Avatar Controls ───────────────────────────────────────────────────
  const avatarControls = el("div", "avatar-controls");

  const avatarFileInput = document.createElement("input") as HTMLInputElement;
  avatarFileInput.type = "file";
  avatarFileInput.accept = "image/*";
  avatarFileInput.style.display = "none";
  avatarFileInput.addEventListener("change", () => {
    if (avatarFileInput.files && avatarFileInput.files.length > 0) {
      handleAvatarFile(avatarFileInput.files[0]);
      avatarFileInput.value = "";
    }
  });

  const chooseAvatarBtn = el("button", "btn-choose-avatar") as HTMLButtonElement;
  chooseAvatarBtn.textContent = "Choose Bot Avatar";
  chooseAvatarBtn.addEventListener("click", () => {
    avatarFileInput.click();
  });

  avatarControls.appendChild(avatarFileInput);
  avatarControls.appendChild(chooseAvatarBtn);

  // Remove avatar button (only when avatar is set)
  if (botAvatarDataUri) {
    const removeAvatarBtn = el("button", "btn-remove-avatar") as HTMLButtonElement;
    removeAvatarBtn.textContent = "Remove";
    removeAvatarBtn.addEventListener("click", () => {
      botAvatarDataUri = null;
      browser.storage.local.remove("distill_bot_avatar");
      render();
    });
    avatarControls.appendChild(removeAvatarBtn);
  }

  section.appendChild(avatarControls);

  // Avatar error display
  if (avatarError) {
    const avatarErrorEl = el("div", "avatar-error");
    avatarErrorEl.textContent = avatarError;
    section.appendChild(avatarErrorEl);
  }

  return section;
}

const SKILL_MAX_SIZE = 512 * 1024; // 512 KB

function handleSkillFile(file: File): void {
  // Validate extension
  if (!file.name.endsWith(".md")) {
    skillError = "Only .md files are accepted";
    render();
    return;
  }

  // Validate size
  if (file.size > SKILL_MAX_SIZE) {
    skillError = "Skill file too large (max 512 KB)";
    render();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const content = reader.result as string;
    skillError = null;
    sendToController({ type: "loadSkill", raw: content });
  };
  reader.onerror = () => {
    skillError = "Failed to read file";
    render();
  };
  reader.readAsText(file);
}

const AVATAR_MAX_SIZE = 1024 * 1024; // 1 MB

function handleAvatarFile(file: File): void {
  // Validate type
  if (!file.type.startsWith("image/")) {
    avatarError = "Avatar must be an image file";
    render();
    return;
  }

  // Validate size
  if (file.size > AVATAR_MAX_SIZE) {
    avatarError = "Avatar image too large (max 1 MB)";
    render();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUri = reader.result as string;
    avatarError = null;
    botAvatarDataUri = dataUri;
    browser.storage.local.set({ distill_bot_avatar: dataUri });
    render();
  };
  reader.onerror = () => {
    avatarError = "Failed to read image file";
    render();
  };
  reader.readAsDataURL(file);
}

function renderFooter(): HTMLElement {
  const footer = el("footer", "sidebar-footer");

  // Export controls — only shown when there's page context (not in pure persona mode with no tabs)
  if (state.phase !== "persona-chat" || contextTabs.length > 0) {
    const exportSection = el("div", "export-section");

    const exportCheckboxes = el("div", "export-checkboxes");

    // Include Summary checkbox
    const summaryLabel = el("label", "export-checkbox-label");
    const summaryCheckbox = document.createElement("input") as HTMLInputElement;
    summaryCheckbox.type = "checkbox";
    summaryCheckbox.className = "export-checkbox";
    summaryCheckbox.checked = true;
    summaryCheckbox.setAttribute("aria-label", "Include AI summary in export");
    const summaryText = document.createTextNode(" Summary");
    summaryLabel.appendChild(summaryCheckbox);
    summaryLabel.appendChild(summaryText);
    exportCheckboxes.appendChild(summaryLabel);

    // Include Q&A checkbox
    const qaLabel = el("label", "export-checkbox-label");
    const qaCheckbox = document.createElement("input") as HTMLInputElement;
    qaCheckbox.type = "checkbox";
    qaCheckbox.className = "export-checkbox";
    qaCheckbox.checked = false;
    qaCheckbox.setAttribute("aria-label", "Include Q&A in export");
    const qaText = document.createTextNode(" Q&A");
    qaLabel.appendChild(qaCheckbox);
    qaLabel.appendChild(qaText);
    exportCheckboxes.appendChild(qaLabel);

    exportSection.appendChild(exportCheckboxes);

    // Export button
    const exportBtn = el("button", "btn btn-export") as HTMLButtonElement;
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", async () => {
      if (currentTabId == null) return;
      exportBtn.disabled = true;
      exportBtn.textContent = "Exporting...";
      try {
        const destination = await getDefaultExportDestination();
        const response = await browser.runtime.sendMessage({
          kind: "exportRequested",
          payload: {
            tabId: currentTabId,
            includeSummary: summaryCheckbox.checked,
            includeQA: qaCheckbox.checked,
            destinations: [destination],
          },
        });
        if (response && typeof response === "object") {
          const result = response as { ok?: boolean; payload?: { ok?: boolean; filename?: string; detail?: string } };
          const payload = result.payload ?? result;
          if (payload.ok) {
            exportBtn.textContent = "✓ Exported";
            setTimeout(() => { exportBtn.textContent = "Export"; }, 2000);
          } else {
            exportBtn.textContent = "✗ Failed";
            setTimeout(() => { exportBtn.textContent = "Export"; }, 3000);
          }
        } else {
          exportBtn.textContent = "✗ No response";
          setTimeout(() => { exportBtn.textContent = "Export"; }, 3000);
        }
      } catch (err) {
        exportBtn.textContent = "✗ Error";
        setTimeout(() => { exportBtn.textContent = "Export"; }, 3000);
      } finally {
        exportBtn.disabled = false;
      }
    });
    exportSection.appendChild(exportBtn);

    footer.appendChild(exportSection);

    // Auto-export toggle
    const autoExportSection = el("div", "auto-export-section");

    const autoExportLabel = el("label", "auto-export-label");
    const autoExportToggle = document.createElement("input") as HTMLInputElement;
    autoExportToggle.type = "checkbox";
    autoExportToggle.className = "auto-export-toggle";
    autoExportToggle.checked = autoExportStatus !== null;
    autoExportToggle.setAttribute("aria-label", "Auto-export for current site");
    const autoExportText = document.createTextNode(" Auto-export");
    autoExportLabel.appendChild(autoExportToggle);
    autoExportLabel.appendChild(autoExportText);

    autoExportToggle.addEventListener("change", () => {
      if (autoExportToggle.checked) {
        const origin = tracker?.getActiveTabUrl() ? new URL(tracker.getActiveTabUrl()!).origin : "";
        if (origin && currentTabId != null) {
          sendToController({
            type: "autoExportEnable",
            config: {
              origin,
              intervalMinutes: 15,
              destination: { kind: "download" },
              mode: "content-only",
              skipIfUnchanged: true,
            },
          });
        }
      } else {
        const origin = tracker?.getActiveTabUrl() ? new URL(tracker.getActiveTabUrl()!).origin : "";
        if (origin) {
          sendToController({ type: "autoExportDisable", origin });
        }
      }
    });

    autoExportSection.appendChild(autoExportLabel);

    // Auto-export status indicator
    if (autoExportStatus) {
      const statusEl = el("div", "auto-export-status");
      const lastCapture = autoExportStatus.lastCaptureTime
        ? `Last: ${formatRelativeTime(autoExportStatus.lastCaptureTime)}`
        : "No captures yet";
      const nextFire = `Next: ${formatRelativeTime(new Date(autoExportStatus.nextFireTime).toISOString())}`;
      statusEl.textContent = `${lastCapture} · ${nextFire}`;
      autoExportSection.appendChild(statusEl);
    }

    footer.appendChild(autoExportSection);
  }

  // Skill upload section (always shown)
  footer.appendChild(renderSkillSection());

  return footer;
}

/**
 * Reads the configured default export destination (CF-4.4). Mirrors the
 * settings manager's read order: sync first, then local, then the default.
 */
async function getDefaultExportDestination(): Promise<{ kind: "download" } | { kind: "clipboard" }> {
  try {
    interface StoredExportSettings {
      export?: { defaultDestination?: { kind?: string } };
    }
    const stored = await browser.storage.sync.get("settings");
    let settings = stored?.settings as StoredExportSettings | undefined;
    if (!settings) {
      const local = await browser.storage.local.get("settings");
      settings = local?.settings as StoredExportSettings | undefined;
    }
    return settings?.export?.defaultDestination?.kind === "clipboard"
      ? { kind: "clipboard" }
      : { kind: "download" };
  } catch {
    return { kind: "download" };
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function submitMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MESSAGE_CHAR_LIMIT) return;

  // Add user message to current messages
  const userMsg: PortConversationMessage = {
    role: "user",
    content: trimmed,
    timestamp: new Date().toISOString(),
  };

  if (state.phase === "ready") {
    state = { phase: "streaming", messages: [...state.messages, userMsg], partial: "", returnPhase: "ready" };
  } else if (state.phase === "persona-chat") {
    state = { phase: "streaming", messages: [...state.messages, userMsg], partial: "", returnPhase: "persona-chat" };
  }

  sendToController({ type: "sendMessage", text: trimmed });
  render();
}

// ─── Utilities ───────────────────────────────────────────────────────────────

// Resets navigation-local state when leaving the current page session.
// Called from header buttons and the active-tab-change handler.
function resetLocalNav(): void {
  configWarning = null;
  contextTabs = [];
  showTabPicker = false;
  pageWordCount = null;
  state = { phase: "loading" };
}

// Sets state to "ready" or keeps "persona-chat" (preserving the phase) and
// replaces messages. Eliminates the repeated if/else branching across handlers.
function setReadyPhase(msgs: ReadonlyArray<PortConversationMessage> = []): void {
  state = state.phase === "persona-chat"
    ? { phase: "persona-chat", messages: msgs }
    : { phase: "ready", messages: msgs };
}

// Fires the element-picker flow and re-inits on success.
// onPending / onCancel update the calling button's visual state.
async function activatePicker(onPending: () => void, onCancel: () => void): Promise<void> {
  if (currentTabId == null) return;
  onPending();
  try {
    const response = await browser.runtime.sendMessage({
      kind: "pickerActivate",
      payload: { tabId: currentTabId },
    });
    const payload = response && typeof response === "object" && "payload" in response
      ? (response as { payload: { ok: boolean } }).payload
      : null;
    if (payload?.ok) {
      state = { phase: "loading" };
      contextTabs = [];
      render();
      sendToController({ type: "init", tabId: currentTabId });
    } else {
      onCancel();
    }
  } catch {
    onCancel();
  }
}

function el(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  return element;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) {
    // Future time
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return "< 1 min";
    if (absDiff < 3_600_000) return `in ${Math.round(absDiff / 60_000)} min`;
    return `in ${Math.round(absDiff / 3_600_000)} hr`;
  }

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`;
  return `${Math.round(diffMs / 3_600_000)} hr ago`;
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Render initial loading state immediately
  render();

  // Restore persisted UI settings
  const avatarResult = await browser.storage.local.get("distill_bot_avatar");
  if (avatarResult.distill_bot_avatar && typeof avatarResult.distill_bot_avatar === "string") {
    botAvatarDataUri = avatarResult.distill_bot_avatar;
  }
  render();

  // Connect to background
  connectPort();

  // Request library state for picker
  sendToController({ type: "getLibrary" });

  // Initialize active tab tracker
  try {
    tracker = await createActiveTabTracker();
    const tabId = tracker.getActiveTabId();

    if (tabId == null) {
      state = { phase: "no-page" };
      render();
    } else {
      currentTabId = tabId;
      sendToController({ type: "init", tabId, url: tracker.getActiveTabUrl() ?? undefined });
      // Also request auto-export status
      sendToController({ type: "autoExportStatusRequest", tabId });
    }

    // Listen for tab changes
    tracker.onActiveTabChanged((newTabId: number, newUrl: string) => {
      currentTabId = newTabId;
      resetLocalNav();
      render();

      // Reconnect port if disconnected
      if (!port) {
        connectPort();
      }

      sendToController({ type: "init", tabId: newTabId, url: newUrl });
      sendToController({ type: "autoExportStatusRequest", tabId: newTabId });
    });
  } catch {
    state = { phase: "no-page" };
    render();
  }
}

// Start the sidebar
init();
