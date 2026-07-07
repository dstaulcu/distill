/**
 * In-memory per-tab state manager.
 *
 * Since Firefox's MV3 background script is persistent (not a service worker),
 * state lives in a Map for the lifetime of the extension — no session storage needed.
 */

import type { TabState } from "@shared/types";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TabStateManager {
  get(tabId: number): TabState | undefined;
  set(tabId: number, state: TabState): void;
  update(tabId: number, patch: Partial<TabState>): TabState | undefined;
  remove(tabId: number): void;
  has(tabId: number): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTabStateManager(): TabStateManager {
  const store = new Map<number, TabState>();

  return {
    get(tabId: number): TabState | undefined {
      return store.get(tabId);
    },

    set(tabId: number, state: TabState): void {
      store.set(tabId, state);
    },

    update(tabId: number, patch: Partial<TabState>): TabState | undefined {
      const existing = store.get(tabId);
      if (existing === undefined) {
        return undefined;
      }
      const updated: TabState = { ...existing, ...patch };
      store.set(tabId, updated);
      return updated;
    },

    remove(tabId: number): void {
      store.delete(tabId);
    },

    has(tabId: number): boolean {
      return store.has(tabId);
    },
  };
}
