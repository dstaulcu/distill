/**
 * Active Tab Tracker — sidebar-resident module that determines which tab
 * is active in the sidebar's window.
 *
 * Firefox's sidebar is per-window (shared across all tabs), so we must
 * manually track the active tab by listening to browser.tabs events and
 * filtering to only the sidebar's owning window.
 */

import { isSamePageNavigation } from "@shared/url-utils";

// ---------------------------------------------------------------------------
// Public Interface
// ---------------------------------------------------------------------------

export interface ActiveTabTracker {
  /** Get the currently tracked tab ID, or null if no tab is active. */
  getActiveTabId(): number | null;
  /** Get the currently tracked tab URL, or null. */
  getActiveTabUrl(): string | null;
  /** Register a callback for active tab changes. Returns unsubscribe function. */
  onActiveTabChanged(cb: (tabId: number, url: string) => void): () => void;
  /** Clean up all listeners. */
  destroy(): void;
}

export interface CreateActiveTabTrackerOptions {
  readonly tabs?: typeof browser.tabs;
  readonly windows?: typeof browser.windows;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createActiveTabTracker(
  opts?: CreateActiveTabTrackerOptions,
): Promise<ActiveTabTracker> {
  const tabs = opts?.tabs ?? browser.tabs;
  const windows = opts?.windows ?? browser.windows;

  // Determine the sidebar's owning window
  const currentWindow = await windows.getCurrent();
  const windowId = currentWindow.id!;

  // Internal state
  let activeTabId: number | null = null;
  let activeTabUrl: string | null = null;
  const listeners = new Set<(tabId: number, url: string) => void>();

  // ---------------------------
  // Helpers
  // ---------------------------

  function notifyListeners(tabId: number, url: string): void {
    for (const cb of listeners) {
      cb(tabId, url);
    }
  }

  async function queryActiveTab(): Promise<{ tabId: number; url: string } | null> {
    const results = await tabs.query({ active: true, windowId });
    if (results.length > 0 && results[0].id != null) {
      return { tabId: results[0].id, url: results[0].url ?? "" };
    }
    return null;
  }

  function setActiveTab(tabId: number, url: string): void {
    const changed = tabId !== activeTabId || !isSamePageNavigation(activeTabUrl ?? "", url);
    activeTabId = tabId;
    activeTabUrl = url;
    if (changed) {
      notifyListeners(tabId, url);
    }
  }

  // ---------------------------
  // Event handlers
  // ---------------------------

  function handleActivated(info: { tabId: number; windowId: number }): void {
    if (info.windowId !== windowId) return;
    // Query the tab to get its URL
    tabs.get(info.tabId).then((tab) => {
      setActiveTab(info.tabId, tab.url ?? "");
    });
  }

  function handleUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab: { id?: number; url?: string; windowId?: number },
  ): void {
    if (changeInfo.status !== "complete") return;
    if (tabId !== activeTabId) return;

    const newUrl = tab.url ?? "";
    const oldUrl = activeTabUrl ?? "";

    if (!isSamePageNavigation(oldUrl, newUrl)) {
      activeTabUrl = newUrl;
      notifyListeners(tabId, newUrl);
    } else {
      // Update stored URL even for fragment-only changes (no notification)
      activeTabUrl = newUrl;
    }
  }

  function handleRemoved(removedTabId: number): void {
    if (removedTabId !== activeTabId) return;
    // Active tab was closed — re-query for the new active tab
    activeTabId = null;
    activeTabUrl = null;
    queryActiveTab().then((result) => {
      if (result) {
        activeTabId = result.tabId;
        activeTabUrl = result.url;
        notifyListeners(result.tabId, result.url);
      }
    });
  }

  // ---------------------------
  // Register listeners
  // ---------------------------

  tabs.onActivated.addListener(handleActivated);
  tabs.onUpdated.addListener(handleUpdated);
  tabs.onRemoved.addListener(handleRemoved);

  // ---------------------------
  // Initialize: query current active tab
  // ---------------------------

  const initial = await queryActiveTab();
  if (initial) {
    activeTabId = initial.tabId;
    activeTabUrl = initial.url;
  }

  // ---------------------------
  // Public API
  // ---------------------------

  return {
    getActiveTabId(): number | null {
      return activeTabId;
    },

    getActiveTabUrl(): string | null {
      return activeTabUrl;
    },

    onActiveTabChanged(cb: (tabId: number, url: string) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    destroy(): void {
      tabs.onActivated.removeListener(handleActivated);
      tabs.onUpdated.removeListener(handleUpdated);
      tabs.onRemoved.removeListener(handleRemoved);
      listeners.clear();
    },
  };
}
