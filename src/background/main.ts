/**
 * Background script entry point (persistent page, Firefox MV3).
 *
 * Initializes all background modules and wires up message routing,
 * port connections, tab events, alarms, and the element picker flow.
 *
 * Intended behavior: REQUIREMENTS.md (CF-1, CF-4, CF-5, CF-6, SF-4).
 */

import {
  isMessageOfKind,
  buildMessage,
  sendToTab,
} from "@shared/messages";
import type {
  AnyMessage,
  MessageOf,
  ClipboardResultPayload,
} from "@shared/messages";
import { isAnyMessage } from "@shared/messages";
import {
  isSidebarToControllerMessage,
} from "@shared/port-protocol";
import type {
  SidebarToControllerMessage,
  ControllerToSidebarMessage,
} from "@shared/port-protocol";
import { createSettingsManager } from "@background/settings/manager";
import { createSecureStore } from "@background/secure-store";
import { createTabStateManager } from "@background/tab-state";
import { createChatController } from "@background/chat/controller";
import { createStreamingClient } from "@background/chat/streaming-client";
import { createExportManager } from "@background/export/manager";
import type { ClipboardResult } from "@background/export/manager";
import { createExtractionService } from "@background/extraction";
import { createAutoExportScheduler } from "@background/auto-export/scheduler";
import type { AutoExportScheduler } from "@background/auto-export/scheduler";
import { createAiClient } from "@background/ai/client";
import type { ExtractionResult } from "@content/extractor/extract";
import { createSkillLibraryManager, migrateSkillLibrary } from "@background/skill-library";
import { createApiKeySaver, resolveApiKey } from "@background/credentials";
import type { Runtime, Tabs, Alarms } from "webextension-polyfill";

// ---------------------------------------------------------------------------
// Module Initialization
// ---------------------------------------------------------------------------

const settingsManager = createSettingsManager();
const secureStore = createSecureStore();
const tabState = createTabStateManager();

/**
 * Extraction orchestration (CF-1): privileged-page guard, pattern → selector
 * resolution, content-script round trip with timeout, and stale flagging.
 * Logic lives in @background/extraction; only the browser bindings are here.
 */
const extractionService = createExtractionService({
  getTabUrl: async (tabId: number) => {
    const tab = await browser.tabs.get(tabId);
    return tab.url ?? "";
  },
  sendExtractMessage: (tabId, msg) => browser.tabs.sendMessage(tabId, msg),
  getSettings: () => settingsManager.get(),
  updateSitePatterns: async (patterns) => {
    await settingsManager.update({ sitePatterns: patterns });
  },
});

function extractContent(tabId: number, selector?: string): Promise<ExtractionResult> {
  return extractionService.extractContent(tabId, selector);
}

const skillLibraryManager = createSkillLibraryManager();

const saveApiKey = createApiKeySaver({
  getSettings: () => settingsManager.get(),
  updateSettings: (patch) => settingsManager.update(patch),
  secureStore,
});

// Run migration from old single-skill storage (idempotent)
migrateSkillLibrary();

const chatController = createChatController({
  getSettings: () => settingsManager.get(),
  getSecureStore: () => secureStore,
  extractContent,
  createStreamingClient,
  tabState,
  skillLibrary: skillLibraryManager,
  hasSavedPattern: (url: string) => extractionService.hasSavedPattern(url),
  queryOpenTabs: async () => {
    const tabs = await browser.tabs.query({});
    return tabs
      .filter((t) => t.id != null && t.url && !t.url.startsWith("about:") && !t.url.startsWith("moz-extension:") && !t.url.startsWith("chrome:"))
      .map((t) => ({ tabId: t.id!, title: t.title ?? "", url: t.url! }));
  },
});

// Track active sidebar ports for clipboard and picker flows
const sidebarPorts = new Map<number, Runtime.Port>();

/**
 * Clipboard delivery via sidebar context.
 * Sends clipboardWrite to the sidebar port and waits for clipboardResult.
 */
function createClipboardDelivery(tabId: number): (content: string) => Promise<ClipboardResult> {
  return (content: string): Promise<ClipboardResult> => {
    const port = sidebarPorts.get(tabId);
    if (!port) {
      return Promise.resolve({
        ok: false,
        reason: "clipboard-not-available",
        detail: "No sidebar port connected for clipboard delivery",
      });
    }

    return new Promise<ClipboardResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ ok: false, reason: "clipboard-timeout", detail: "Clipboard operation timed out" });
      }, 5000);

      const listener = (raw: unknown): void => {
        if (isMessageOfKind(raw, "clipboardResult")) {
          clearTimeout(timeout);
          port.onMessage.removeListener(listener);
          const payload = (raw as MessageOf<"clipboardResult">).payload;
          if (payload.ok) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, reason: payload.reason ?? "clipboard-failed", detail: payload.reason ?? "Clipboard write failed" });
          }
        }
      };

      port.onMessage.addListener(listener);
      const msg = buildMessage("clipboardWrite", { content });
      port.postMessage(msg);
    });
  };
}

const exportManager = createExportManager({
  extractContent: (tabId: number) => extractContent(tabId),
  getSettings: () => settingsManager.get(),
  getConversation: (tabId: number) => {
    const state = tabState.get(tabId);
    return state?.conversation ?? null;
  },
  deliverToClipboard: async (content: string): Promise<ClipboardResult> => {
    // Try each connected sidebar until one succeeds
    let lastFailure: ClipboardResult | null = null;
    for (const tabId of sidebarPorts.keys()) {
      const result = await createClipboardDelivery(tabId)(content);
      if (result.ok) return result;
      lastFailure = result;
    }
    return lastFailure ?? { ok: false, reason: "clipboard-not-available", detail: "No sidebar port connected" };
  },
});

const scheduler: AutoExportScheduler = createAutoExportScheduler({
  alarms: browser.alarms,
  extractContent,
  exportContent: async (input) => {
    // For auto-export, use the export manager with appropriate settings
    const result = await exportManager.export({
      tabId: input.tabId,
      includeQA: input.mode === "full",
      destinations: [input.destination],
    });
    if (result.ok) {
      return { ok: true, filename: result.filename };
    }
    return { ok: false, reason: result.reason, detail: result.detail };
  },
  getAutoExportConfig: async (origin: string) => {
    const settings = await settingsManager.get();
    return settings.autoExportConfigs.find((c) => c.origin === origin) ?? null;
  },
});

// ---------------------------------------------------------------------------
// Message Dispatch (browser.runtime.onMessage)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(
  (message: unknown, sender: Runtime.MessageSender): undefined | Promise<unknown> => {
    if (!isAnyMessage(message)) return undefined;

    const msg = message as AnyMessage;

    switch (msg.kind) {
      case "extractRequested":
        return handleExtractRequested(msg as MessageOf<"extractRequested">);

      case "exportRequested":
        return handleExportRequested(msg as MessageOf<"exportRequested">);

      case "connectionTest":
        return handleConnectionTest(msg as MessageOf<"connectionTest">);

      case "patternSave":
        return handlePatternSave(msg as MessageOf<"patternSave">);

      case "settingsChanged":
        return handleSettingsChanged(msg as MessageOf<"settingsChanged">);

      case "autoExportConfigSave":
        return handleAutoExportConfigSave(msg as MessageOf<"autoExportConfigSave">);

      case "autoExportConfigDelete":
        return handleAutoExportConfigDelete(msg as MessageOf<"autoExportConfigDelete">);

      case "autoExportStatusQuery":
        return handleAutoExportStatusQuery(msg as MessageOf<"autoExportStatusQuery">);

      case "pickerActivate":
        return handlePickerActivateMessage(msg as MessageOf<"pickerActivate">);

      case "apiKeySave":
        return handleApiKeySave(msg as MessageOf<"apiKeySave">);

      default:
        return undefined;
    }
  },
);

// ---------------------------------------------------------------------------
// Message Handlers
// ---------------------------------------------------------------------------

async function handleExtractRequested(msg: MessageOf<"extractRequested">): Promise<MessageOf<"extractResult">> {
  const { tabId, selector } = msg.payload;
  const result = await extractContent(tabId, selector);

  if (result.ok) {
    return buildMessage("extractResult", {
      ok: true,
      article: result.article,
      confidence: result.confidence,
    }, msg.requestId);
  }

  return buildMessage("extractResult", {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  }, msg.requestId);
}

async function handleExportRequested(msg: MessageOf<"exportRequested">): Promise<MessageOf<"exportResult">> {
  const { tabId, includeSummary, includeQA, destinations } = msg.payload;

  const result = await exportManager.export({ tabId, includeSummary, includeQA, destinations: [...destinations] });

  if (result.ok) {
    return buildMessage("exportResult", {
      ok: true,
      filename: result.filename,
      outcomes: result.outcomes.map((o) => {
        if (o.ok) return { destination: o.destination, ok: true as const };
        return { destination: o.destination, ok: false as const, reason: o.reason, detail: o.detail };
      }),
    }, msg.requestId);
  }

  return buildMessage("exportResult", {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  }, msg.requestId);
}

async function handleApiKeySave(msg: MessageOf<"apiKeySave">): Promise<MessageOf<"apiKeySaveResult">> {
  const result = await saveApiKey(msg.payload.apiKey);
  if (result.ok) {
    return buildMessage("apiKeySaveResult", { ok: true, ref: result.ref }, msg.requestId);
  }
  return buildMessage("apiKeySaveResult", { ok: false, reason: result.reason, detail: result.detail }, msg.requestId);
}

async function handleConnectionTest(msg: MessageOf<"connectionTest">): Promise<MessageOf<"connectionTestResult">> {
  const { baseUrl, apiKey, modelId } = msg.payload;

  // A key typed into the form wins; otherwise fall back to the stored secret
  const settings = await settingsManager.get();
  const effectiveKey = await resolveApiKey({ settings, secureStore, override: apiKey });

  const client = createAiClient({ baseUrl, apiKey: effectiveKey ?? "", model: modelId });
  const result = await client.testConnection();

  if (result.ok) {
    return buildMessage("connectionTestResult", { ok: true }, msg.requestId);
  }

  return buildMessage("connectionTestResult", {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  }, msg.requestId);
}

async function handlePatternSave(msg: MessageOf<"patternSave">): Promise<MessageOf<"patternSaveResult">> {
  const { origin, urlMatchPattern, contentSelector } = msg.payload;

  const settings = await settingsManager.get();
  const existingPatterns = [...settings.sitePatterns];

  // Find existing user pattern for this origin or create new one
  const existingIndex = existingPatterns.findIndex(
    (p) => p.source === "user" && p.urlMatchPattern === urlMatchPattern,
  );

  const newPattern = {
    id: `user-${origin}-${Date.now()}`,
    source: "user" as const,
    urlMatchPattern,
    contentSelector,
  };

  if (existingIndex >= 0) {
    existingPatterns[existingIndex] = newPattern;
  } else {
    existingPatterns.push(newPattern);
  }

  const updateResult = await settingsManager.update({ sitePatterns: existingPatterns });

  if (updateResult.ok) {
    return buildMessage("patternSaveResult", { ok: true }, msg.requestId);
  }

  return buildMessage("patternSaveResult", {
    ok: false,
    reason: "validation-failed",
    detail: updateResult.errors.map((e) => e.message).join("; "),
  }, msg.requestId);
}

async function handleSettingsChanged(msg: MessageOf<"settingsChanged">): Promise<MessageOf<"settingsSaveResult">> {
  // Settings update received from options page — apply via settings manager
  // (validation, quota fallback, and change broadcast all live there)
  const payload = msg.payload;
  const result = await settingsManager.update({
    ai: payload.ai,
    export: payload.export,
    sitePatterns: [...payload.sitePatterns],
    autoExportConfigs: [...payload.autoExportConfigs],
  });

  if (result.ok) {
    return buildMessage("settingsSaveResult", { ok: true }, msg.requestId);
  }
  return buildMessage("settingsSaveResult", { ok: false, errors: result.errors }, msg.requestId);
}

async function handleAutoExportConfigSave(msg: MessageOf<"autoExportConfigSave">): Promise<MessageOf<"patternSaveResult">> {
  const { origin, enabled, intervalMinutes, destination, mode, skipIfUnchanged } = msg.payload;

  const settings = await settingsManager.get();
  const configs = [...settings.autoExportConfigs];
  const now = new Date().toISOString();

  const existingIndex = configs.findIndex((c) => c.origin === origin);

  const newConfig = {
    origin,
    enabled,
    intervalMinutes,
    destination,
    mode,
    skipIfUnchanged,
    createdAt: existingIndex >= 0 ? configs[existingIndex].createdAt : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    configs[existingIndex] = newConfig;
  } else {
    configs.push(newConfig);
  }

  const updateResult = await settingsManager.update({ autoExportConfigs: configs });

  if (updateResult.ok) {
    return buildMessage("patternSaveResult", { ok: true }, msg.requestId);
  }

  return buildMessage("patternSaveResult", {
    ok: false,
    reason: "validation-failed",
    detail: updateResult.errors.map((e) => e.message).join("; "),
  }, msg.requestId);
}

async function handleAutoExportConfigDelete(msg: MessageOf<"autoExportConfigDelete">): Promise<MessageOf<"patternSaveResult">> {
  const { origin } = msg.payload;

  const settings = await settingsManager.get();
  const configs = settings.autoExportConfigs.filter((c) => c.origin !== origin);

  const updateResult = await settingsManager.update({ autoExportConfigs: configs });

  // Cancel any active alarms for tabs on this origin
  // We don't have a direct tab→origin lookup, so we rely on the scheduler's internal state
  // The scheduler will handle cleanup when it next checks the config

  if (updateResult.ok) {
    return buildMessage("patternSaveResult", { ok: true }, msg.requestId);
  }

  return buildMessage("patternSaveResult", {
    ok: false,
    reason: "validation-failed",
    detail: updateResult.errors.map((e) => e.message).join("; "),
  }, msg.requestId);
}

async function handleAutoExportStatusQuery(msg: MessageOf<"autoExportStatusQuery">): Promise<MessageOf<"autoExportStatusResult">> {
  const { tabId } = msg.payload;
  const status = scheduler.getStatus(tabId);

  return buildMessage("autoExportStatusResult", { status }, msg.requestId);
}

async function handlePickerActivateMessage(msg: MessageOf<"pickerActivate">): Promise<MessageOf<"pickerResult">> {
  const { tabId } = msg.payload;

  // Forward pickerActivate to the content script and await its response
  const response = await sendToTab(tabId, "pickerActivate", { tabId }, msg.requestId);

  if (!response || typeof response !== "object" || !("payload" in (response as object))) {
    return buildMessage("pickerResult", { ok: false, reason: "No response from content script" }, msg.requestId);
  }

  const result = (response as MessageOf<"pickerResult">).payload;
  if (!result.ok || !result.selector) {
    return buildMessage("pickerResult", { ok: false, reason: result.reason ?? "Selection cancelled" }, msg.requestId);
  }

  // Save the selected element as a site pattern for this hostname
  const tab = await browser.tabs.get(tabId);
  if (tab.url) {
    try {
      const parsedUrl = new URL(tab.url);
      const urlMatchPattern = `*://${parsedUrl.hostname}/*`;
      await handlePatternSave(buildMessage("patternSave", {
        origin: parsedUrl.origin,
        urlMatchPattern,
        contentSelector: result.selector,
      }));
    } catch {
      // URL parse failure — pattern not saved, but extraction still proceeds
    }
  }

  return buildMessage("pickerResult", { ok: true, selector: result.selector, previewText: result.previewText }, msg.requestId);
}

// ---------------------------------------------------------------------------
// Port Connections (browser.runtime.onConnect)
// ---------------------------------------------------------------------------

browser.runtime.onConnect.addListener((port: Runtime.Port) => {
  if (port.name !== "chat") return;

  // Track the port for clipboard/picker flows
  let connectedTabId: number | null = null;

  const portMessageListener = (raw: unknown): void => {
    // Intercept auto-export messages before passing to chat controller
    if (isSidebarToControllerMessage(raw)) {
      const msg = raw as SidebarToControllerMessage;

      switch (msg.type) {
        case "init": {
          connectedTabId = msg.tabId;
          sidebarPorts.set(msg.tabId, port);
          break;
        }
        case "autoExportEnable": {
          handleAutoExportEnable(msg.config, connectedTabId);
          return; // Don't pass to chat controller
        }
        case "autoExportDisable": {
          handleAutoExportDisable(msg.origin, connectedTabId);
          return;
        }
        case "autoExportStatusRequest": {
          handleAutoExportStatusRequest(msg.tabId, port);
          return;
        }
        default:
          break;
      }
    }

    // Handle clipboardResult from sidebar
    if (isMessageOfKind(raw, "clipboardResult")) {
      // Already handled by the clipboard delivery promise listener
      return;
    }
  };

  // Add our interceptor first
  port.onMessage.addListener(portMessageListener);

  // Delegate to chat controller for chat-related messages
  chatController.handleConnect(port);

  port.onDisconnect.addListener(() => {
    if (connectedTabId !== null) {
      sidebarPorts.delete(connectedTabId);
    }
    port.onMessage.removeListener(portMessageListener);
  });
});

// ---------------------------------------------------------------------------
// Auto-Export Port Message Handlers
// ---------------------------------------------------------------------------

async function handleAutoExportEnable(
  config: { origin: string; intervalMinutes: number; destination: { kind: "download" } | { kind: "clipboard" }; mode: "content-only" | "full"; skipIfUnchanged: boolean },
  tabId: number | null,
): Promise<void> {
  // Save the config
  const settings = await settingsManager.get();
  const configs = [...settings.autoExportConfigs];
  const now = new Date().toISOString();

  const existingIndex = configs.findIndex((c) => c.origin === config.origin);
  const newConfig = {
    origin: config.origin,
    enabled: true,
    intervalMinutes: config.intervalMinutes,
    destination: config.destination,
    mode: config.mode,
    skipIfUnchanged: config.skipIfUnchanged,
    createdAt: existingIndex >= 0 ? configs[existingIndex].createdAt : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    configs[existingIndex] = newConfig;
  } else {
    configs.push(newConfig);
  }

  await settingsManager.update({ autoExportConfigs: configs });

  // Schedule for the current tab
  if (tabId !== null) {
    await scheduler.scheduleForTab(tabId, config.origin);
  }

  // Send status back to sidebar
  if (tabId !== null) {
    const port = sidebarPorts.get(tabId);
    if (port) {
      const status = scheduler.getStatus(tabId);
      const statusMsg: ControllerToSidebarMessage = { type: "autoExportStatus", status };
      port.postMessage(statusMsg);
    }
  }
}

async function handleAutoExportDisable(origin: string, tabId: number | null): Promise<void> {
  // Cancel alarm for current tab
  if (tabId !== null) {
    await scheduler.cancelForTab(tabId);
  }

  // Remove the config
  const settings = await settingsManager.get();
  const configs = settings.autoExportConfigs.filter((c) => c.origin !== origin);
  await settingsManager.update({ autoExportConfigs: configs });

  // Send status back to sidebar
  if (tabId !== null) {
    const port = sidebarPorts.get(tabId);
    if (port) {
      const statusMsg: ControllerToSidebarMessage = { type: "autoExportStatus", status: null };
      port.postMessage(statusMsg);
    }
  }
}

async function handleAutoExportStatusRequest(tabId: number, port: Runtime.Port): Promise<void> {
  const status = scheduler.getStatus(tabId);
  const statusMsg: ControllerToSidebarMessage = { type: "autoExportStatus", status };
  port.postMessage(statusMsg);
}

// ---------------------------------------------------------------------------
// Tab Events
// ---------------------------------------------------------------------------

/**
 * Clean up tab state and cancel auto-export alarms when a tab is closed.
 * REQUIREMENTS.md: SF-4
 */
browser.tabs.onRemoved.addListener((tabId: number) => {
  tabState.remove(tabId);
  scheduler.cancelForTab(tabId);
  sidebarPorts.delete(tabId);
});

/**
 * When a tab finishes loading, check if its origin has an Auto_Export_Config.
 * Schedule or cancel auto-export accordingly.
 * REQUIREMENTS.md: SF-4
 */
browser.tabs.onUpdated.addListener(
  async (tabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType, tab: Tabs.Tab) => {
    if (changeInfo.status !== "complete") return;

    const url = tab.url;
    if (!url) return;

    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }

    // Check if origin has changed for an active auto-export tab
    if (scheduler.isActiveForTab(tabId)) {
      const status = scheduler.getStatus(tabId);
      if (status && status.origin !== origin) {
        // Origin changed — cancel the alarm for this tab
        await scheduler.cancelForTab(tabId);
      }
    }

    // Check if the new origin has an Auto_Export_Config
    const settings = await settingsManager.get();
    const config = settings.autoExportConfigs.find((c) => c.origin === origin && c.enabled);

    if (config && !scheduler.isActiveForTab(tabId)) {
      await scheduler.scheduleForTab(tabId, origin);
    }
  },
);

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

/**
 * Delegate alarm events to the Auto Export Scheduler.
 * REQUIREMENTS.md: SF-4
 */
browser.alarms.onAlarm.addListener((alarm: Alarms.Alarm) => {
  scheduler.handleAlarm(alarm);
});

// ---------------------------------------------------------------------------
// Browser Action (Toggle Sidebar)
// ---------------------------------------------------------------------------

/**
 * Toggle sidebar when the extension action icon is clicked.
 * REQUIREMENTS.md: §1 Extension Structure
 */
browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

// ---------------------------------------------------------------------------
// Element Picker Flow
// ---------------------------------------------------------------------------

// Export for testing
export { extractContent };
