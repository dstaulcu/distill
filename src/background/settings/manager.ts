/**
 * Settings Manager — persists user configuration to browser.storage.sync
 * with automatic fallback to browser.storage.local on quota exceeded.
 *
 * Validates all settings before persisting and broadcasts changes to
 * all extension contexts on successful update.
 */

import type { Settings, AutoExportConfig } from "@shared/types";
import type { StorageAdapter } from "@shared/storage";
import { createSyncStorageAdapter, createLocalStorageAdapter } from "@shared/storage";
import { buildMessage } from "@shared/messages";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "./defaults";

// ---------------------------------------------------------------------------
// Public Interface
// ---------------------------------------------------------------------------

export interface SettingsManager {
  get(): Promise<Settings>;
  update(patch: PartialSettings): Promise<SettingsUpdateResult>;
  onChange(cb: (settings: Settings) => void): () => void;
  isSyncing(): boolean;
}

export type SettingsUpdateResult =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly reason: "validation-failed" | "storage-error"; readonly errors: ReadonlyArray<FieldError> };

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface CreateSettingsManagerOptions {
  readonly syncStorage?: StorageAdapter;
  readonly localStorage?: StorageAdapter;
  readonly broadcast?: (settings: Settings) => void;
}

// ---------------------------------------------------------------------------
// PartialSettings — deep partial of Settings for patch updates
// ---------------------------------------------------------------------------

export type PartialSettings = {
  readonly ai?: Partial<Settings["ai"]>;
  readonly export?: Partial<Settings["export"]>;
  readonly sitePatterns?: Settings["sitePatterns"];
  readonly autoExportConfigs?: Settings["autoExportConfigs"];
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSettingsManager(opts?: CreateSettingsManagerOptions): SettingsManager {
  const syncStorage = opts?.syncStorage ?? getDefaultSyncStorage();
  const localStorage = opts?.localStorage ?? getDefaultLocalStorage();
  const broadcast = opts?.broadcast ?? defaultBroadcast;

  let usingSyncStorage = true;
  const listeners: Array<(settings: Settings) => void> = [];

  function getActiveStorage(): StorageAdapter {
    return usingSyncStorage ? syncStorage : localStorage;
  }

  return {
    async get(): Promise<Settings> {
      // CF-5.1: read sync first, then fall back to local — settings written to
      // local after a quota fallback must survive a restart (the in-memory
      // fallback flag resets with the background page).
      if (usingSyncStorage) {
        const fromSync = await syncStorage.get<Settings>(SETTINGS_STORAGE_KEY);
        if (fromSync) return fromSync;
        const fromLocal = await localStorage.get<Settings>(SETTINGS_STORAGE_KEY);
        if (fromLocal) return fromLocal;
        return DEFAULT_SETTINGS;
      }
      const stored = await localStorage.get<Settings>(SETTINGS_STORAGE_KEY);
      if (stored) return stored;
      return DEFAULT_SETTINGS;
    },

    async update(patch: PartialSettings): Promise<SettingsUpdateResult> {
      // 1. Get current settings
      const current = await this.get();

      // 2. Merge patch into current settings
      const merged = mergeSettings(current, patch);

      // 3. Validate merged settings
      const errors = validateSettings(merged);
      if (errors.length > 0) {
        return { ok: false, reason: "validation-failed", errors };
      }

      // 4. Persist — try sync first, fallback to local on quota exceeded
      if (usingSyncStorage) {
        const syncResult = await syncStorage.set(SETTINGS_STORAGE_KEY, merged);
        if (!syncResult.ok && syncResult.reason === "quota-exceeded") {
          usingSyncStorage = false;
          const localResult = await localStorage.set(SETTINGS_STORAGE_KEY, merged);
          if (!localResult.ok) {
            // Storage error — should not happen in practice
            return { ok: false, reason: "storage-error", errors: [{ field: "_storage", message: localResult.detail }] };
          }
        } else if (!syncResult.ok) {
          return { ok: false, reason: "storage-error", errors: [{ field: "_storage", message: syncResult.detail }] };
        }
      } else {
        const localResult = await localStorage.set(SETTINGS_STORAGE_KEY, merged);
        if (!localResult.ok) {
          return { ok: false, reason: "storage-error", errors: [{ field: "_storage", message: localResult.detail }] };
        }
      }

      // 5. Broadcast to all contexts
      broadcast(merged);

      // 6. Notify local listeners
      for (const cb of listeners) {
        cb(merged);
      }

      return { ok: true, settings: merged };
    },

    onChange(cb: (settings: Settings) => void): () => void {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) {
          listeners.splice(idx, 1);
        }
      };
    },

    isSyncing(): boolean {
      return usingSyncStorage;
    },
  };
}

// ---------------------------------------------------------------------------
// Merge Logic — deep merge patch into current settings
// ---------------------------------------------------------------------------

function mergeSettings(current: Settings, patch: PartialSettings): Settings {
  return {
    schemaVersion: current.schemaVersion,
    ai: patch.ai
      ? {
          baseUrl: patch.ai.baseUrl ?? current.ai.baseUrl,
          modelId: patch.ai.modelId ?? current.ai.modelId,
          apiKeyRef: patch.ai.apiKeyRef !== undefined ? patch.ai.apiKeyRef : current.ai.apiKeyRef,
          systemPrompt: patch.ai.systemPrompt ?? current.ai.systemPrompt,
        }
      : current.ai,
    export: patch.export
      ? {
          filenamePattern: patch.export.filenamePattern ?? current.export.filenamePattern,
          defaultDestination: patch.export.defaultDestination ?? current.export.defaultDestination,
          frontmatterFields: patch.export.frontmatterFields ?? current.export.frontmatterFields,
        }
      : current.export,
    sitePatterns: patch.sitePatterns !== undefined ? patch.sitePatterns : current.sitePatterns,
    autoExportConfigs: patch.autoExportConfigs !== undefined ? patch.autoExportConfigs : current.autoExportConfigs,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSettings(settings: Settings): ReadonlyArray<FieldError> {
  const errors: FieldError[] = [];

  // AI base URL: must start with http:// or https:// when non-empty
  if (settings.ai.baseUrl !== "" && !/^https?:\/\//.test(settings.ai.baseUrl)) {
    errors.push({
      field: "ai.baseUrl",
      message: "Base URL must start with http:// or https://",
    });
  }

  // Filename pattern: must be non-empty
  if (settings.export.filenamePattern.trim() === "") {
    errors.push({
      field: "export.filenamePattern",
      message: "Filename pattern must not be empty",
    });
  }

  // Site patterns: max 50 user-defined
  const userPatterns = settings.sitePatterns.filter((p) => p.source === "user");
  if (userPatterns.length > 50) {
    errors.push({
      field: "sitePatterns",
      message: "Maximum of 50 user-defined site patterns allowed",
    });
  }

  // Auto-export configs: validate interval for each config
  for (let i = 0; i < settings.autoExportConfigs.length; i++) {
    const config = settings.autoExportConfigs[i];
    const interval = config.intervalMinutes;
    if (!Number.isInteger(interval) || interval < 1 || interval > 120) {
      errors.push({
        field: `autoExportConfigs[${i}].intervalMinutes`,
        message: "Auto-export interval must be an integer between 1 and 120 minutes",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Default implementations (production)
// ---------------------------------------------------------------------------

function getDefaultSyncStorage(): StorageAdapter {
  return createSyncStorageAdapter();
}

function getDefaultLocalStorage(): StorageAdapter {
  return createLocalStorageAdapter();
}

function defaultBroadcast(settings: Settings): void {
  const msg = buildMessage("settingsChanged", settings);
  browser.runtime.sendMessage(msg).catch(() => {
    // Ignore errors when no listeners are available
  });
}
