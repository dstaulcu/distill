/**
 * Storage adapters wrapping browser.storage APIs with typed get/set/remove
 * and change subscription support.
 *
 * Used by SettingsManager and SecureStore as injectable dependencies.
 */

import type { Storage } from "webextension-polyfill";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorageSetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "quota-exceeded" | "storage-error"; readonly detail: string };

export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<StorageSetResult>;
  remove(key: string): Promise<void>;
  subscribe<T>(key: string, cb: (newValue: T | undefined) => void): () => void;
}

// ---------------------------------------------------------------------------
// Factory: browser.storage.sync adapter
// ---------------------------------------------------------------------------

export function createSyncStorageAdapter(): StorageAdapter {
  return createBrowserStorageAdapter(browser.storage.sync);
}

// ---------------------------------------------------------------------------
// Factory: browser.storage.local adapter
// ---------------------------------------------------------------------------

export function createLocalStorageAdapter(): StorageAdapter {
  return createBrowserStorageAdapter(browser.storage.local);
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function createBrowserStorageAdapter(
  area: Storage.StorageArea,
): StorageAdapter {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await area.get(key);
      return result[key] as T | undefined;
    },

    async set<T>(key: string, value: T): Promise<StorageSetResult> {
      try {
        await area.set({ [key]: value });
        return { ok: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("QUOTA_BYTES") || message.includes("quota")) {
          return { ok: false, reason: "quota-exceeded", detail: message.slice(0, 200) };
        }
        return { ok: false, reason: "storage-error", detail: message.slice(0, 200) };
      }
    },

    async remove(key: string): Promise<void> {
      await area.remove(key);
    },

    subscribe<T>(key: string, cb: (newValue: T | undefined) => void): () => void {
      const listener = (
        changes: Record<string, Storage.StorageChange>,
        _areaName: string,
      ) => {
        // Only fire for the matching area and key
        if (key in changes) {
          cb(changes[key].newValue as T | undefined);
        }
      };

      browser.storage.onChanged.addListener(listener);

      return () => {
        browser.storage.onChanged.removeListener(listener);
      };
    },
  };
}
