/**
 * Integration tests for Settings Manager persistence.
 *
 * Validates end-to-end behavior of the settings manager including:
 * - Sync storage persistence by default
 * - Fallback to local storage on quota exceeded
 * - Validation rejection with field-level errors (no state mutation)
 * - Broadcast of settingsChanged message on successful update
 *
 * Validates: Requirements 8.3, 8.4, 8.6, 8.7
 */

import { describe, it, expect, vi } from "vitest";
import { createSettingsManager } from "./manager";
import type { PartialSettings } from "./manager";
import type { StorageAdapter, StorageSetResult } from "@shared/storage";
import type { Settings } from "@shared/types";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "./defaults";

// ---------------------------------------------------------------------------
// Test Helpers — Storage Adapters
// ---------------------------------------------------------------------------

function createMockSyncStorage(): StorageAdapter & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<StorageSetResult> {
      data.set(key, value);
      return { ok: true };
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
    subscribe() {
      return () => {};
    },
  };
}

function createMockLocalStorage(): StorageAdapter & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<StorageSetResult> {
      data.set(key, value);
      return { ok: true };
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
    subscribe() {
      return () => {};
    },
  };
}

function createQuotaExceededSyncStorage(): StorageAdapter & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(_key: string, _value: T): Promise<StorageSetResult> {
      return { ok: false, reason: "quota-exceeded", detail: "QUOTA_BYTES exceeded" };
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
    subscribe() {
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("CF-5 Settings Manager Integration: Persistence", () => {
  describe("Requirement 8.3: Sync storage persistence by default", () => {
    it("persists settings to sync storage on update", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      const result = await manager.update({
        ai: { baseUrl: "https://api.openai.com", modelId: "gpt-4" },
      });

      expect(result.ok).toBe(true);
      // Verify data is in sync storage
      const stored = syncStorage.data.get(SETTINGS_STORAGE_KEY) as Settings;
      expect(stored).toBeDefined();
      expect(stored.ai.baseUrl).toBe("https://api.openai.com");
      expect(stored.ai.modelId).toBe("gpt-4");
      // Verify local storage is NOT used
      expect(localStorage.data.has(SETTINGS_STORAGE_KEY)).toBe(false);
    });

    it("reads back persisted settings from sync storage", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      // Update settings
      await manager.update({
        ai: { baseUrl: "https://api.example.com" },
        export: { filenamePattern: "DD-MM-YYYY-slugified-title" },
      });

      // Read back
      const settings = await manager.get();
      expect(settings.ai.baseUrl).toBe("https://api.example.com");
      expect(settings.export.filenamePattern).toBe("DD-MM-YYYY-slugified-title");
    });

    it("reports isSyncing() as true when using sync storage", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });

      expect(manager.isSyncing()).toBe(true);

      // After a successful sync update, still syncing
      await manager.update({ ai: { baseUrl: "https://api.test.com" } });
      expect(manager.isSyncing()).toBe(true);
    });

    it("persists multiple sequential updates to sync storage", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });

      await manager.update({ ai: { baseUrl: "https://first.com" } });
      await manager.update({ ai: { modelId: "gpt-4o" } });
      await manager.update({ export: { filenamePattern: "YYYY-slugified-title" } });

      const settings = await manager.get();
      expect(settings.ai.baseUrl).toBe("https://first.com");
      expect(settings.ai.modelId).toBe("gpt-4o");
      expect(settings.export.filenamePattern).toBe("YYYY-slugified-title");
    });
  });

  describe("Requirement 8.4: Fallback to local storage on quota exceeded", () => {
    it("falls back to local storage when sync quota is exceeded", async () => {
      const syncStorage = createQuotaExceededSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      const result = await manager.update({
        ai: { baseUrl: "https://api.openai.com" },
      });

      expect(result.ok).toBe(true);
      // Verify data landed in local storage
      const stored = localStorage.data.get(SETTINGS_STORAGE_KEY) as Settings;
      expect(stored).toBeDefined();
      expect(stored.ai.baseUrl).toBe("https://api.openai.com");
      // Verify sync storage was NOT written to
      expect(syncStorage.data.has(SETTINGS_STORAGE_KEY)).toBe(false);
    });

    it("reports isSyncing() as false after fallback", async () => {
      const syncStorage = createQuotaExceededSyncStorage();
      const localStorage = createMockLocalStorage();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });

      expect(manager.isSyncing()).toBe(true);
      await manager.update({ ai: { baseUrl: "https://api.test.com" } });
      expect(manager.isSyncing()).toBe(false);
    });

    it("continues using local storage for subsequent updates after fallback", async () => {
      const syncStorage = createQuotaExceededSyncStorage();
      const localStorage = createMockLocalStorage();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });

      // First update triggers fallback
      await manager.update({ ai: { baseUrl: "https://api.first.com" } });
      expect(manager.isSyncing()).toBe(false);

      // Second update goes directly to local
      const result = await manager.update({ ai: { modelId: "gpt-4" } });
      expect(result.ok).toBe(true);

      const stored = localStorage.data.get(SETTINGS_STORAGE_KEY) as Settings;
      expect(stored.ai.baseUrl).toBe("https://api.first.com");
      expect(stored.ai.modelId).toBe("gpt-4");
    });

    it("still broadcasts on successful fallback update", async () => {
      const syncStorage = createQuotaExceededSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: expect.objectContaining({ baseUrl: "https://api.test.com" }),
        }),
      );
    });
  });

  describe("Requirement 8.7: Validation rejection with field-level errors", () => {
    it("rejects invalid AI base URL without modifying persisted settings", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      // First, set valid settings
      await manager.update({ ai: { baseUrl: "https://api.valid.com" } });
      broadcast.mockClear();

      // Attempt invalid update
      const result = await manager.update({ ai: { baseUrl: "not-a-valid-url" } });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("validation-failed");
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((e) => e.field === "ai.baseUrl")).toBe(true);
      }

      // Verify persisted settings are unchanged
      const settings = await manager.get();
      expect(settings.ai.baseUrl).toBe("https://api.valid.com");

      // Verify no broadcast occurred
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("rejects empty filename pattern without modifying persisted settings", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      // Set valid settings first
      await manager.update({ export: { filenamePattern: "YYYY-MM-DD-slugified-title" } });
      broadcast.mockClear();

      // Attempt invalid update
      const result = await manager.update({ export: { filenamePattern: "   " } });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field === "export.filenamePattern")).toBe(true);
      }

      // Verify persisted settings are unchanged
      const settings = await manager.get();
      expect(settings.export.filenamePattern).toBe("YYYY-MM-DD-slugified-title");
    });

    it("rejects more than 50 user-defined site patterns without modifying persisted settings", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      // Set valid patterns first
      const validPatterns = [
        { id: "user-1", source: "user" as const, urlMatchPattern: "*://*.example.com/*", contentSelector: ".content" },
      ];
      await manager.update({ sitePatterns: validPatterns });
      broadcast.mockClear();

      // Attempt to set 51 user patterns
      const tooManyPatterns = Array.from({ length: 51 }, (_, i) => ({
        id: `user-${i}`,
        source: "user" as const,
        urlMatchPattern: `*://*.site${i}.com/*`,
        contentSelector: ".content",
      }));

      const result = await manager.update({ sitePatterns: tooManyPatterns });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field === "sitePatterns")).toBe(true);
      }

      // Verify persisted settings are unchanged
      const settings = await manager.get();
      expect(settings.sitePatterns).toEqual(validPatterns);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("rejects invalid auto-export interval without modifying persisted settings", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      // Set valid config first
      const validConfigs = [{
        origin: "https://example.com",
        enabled: true,
        intervalMinutes: 15,
        destination: { kind: "download" as const },
        mode: "content-only" as const,
        skipIfUnchanged: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }];
      await manager.update({ autoExportConfigs: validConfigs });
      broadcast.mockClear();

      // Attempt invalid interval (0 is out of [1, 120] range)
      const invalidConfigs = [{
        ...validConfigs[0],
        intervalMinutes: 0,
      }];

      const result = await manager.update({ autoExportConfigs: invalidConfigs });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field.includes("intervalMinutes"))).toBe(true);
      }

      // Verify persisted settings are unchanged
      const settings = await manager.get();
      expect(settings.autoExportConfigs[0].intervalMinutes).toBe(15);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("returns multiple field-level errors for multiple invalid fields", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });

      const result = await manager.update({
        ai: { baseUrl: "ftp://invalid" },
        export: { filenamePattern: "" },
        autoExportConfigs: [{
          origin: "https://example.com",
          enabled: true,
          intervalMinutes: 200,
          destination: { kind: "download" },
          mode: "content-only",
          skipIfUnchanged: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(3);
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain("ai.baseUrl");
        expect(fields).toContain("export.filenamePattern");
        expect(fields.some((f) => f.includes("intervalMinutes"))).toBe(true);
      }
    });
  });

  describe("Requirement 8.6: Broadcast settingsChanged on successful update", () => {
    it("broadcasts settings to all contexts on successful update", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      await manager.update({ ai: { baseUrl: "https://api.openai.com", modelId: "gpt-4" } });

      expect(broadcast).toHaveBeenCalledTimes(1);
      const broadcastedSettings = broadcast.mock.calls[0][0] as Settings;
      expect(broadcastedSettings.ai.baseUrl).toBe("https://api.openai.com");
      expect(broadcastedSettings.ai.modelId).toBe("gpt-4");
    });

    it("does not broadcast on validation failure", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      await manager.update({ ai: { baseUrl: "invalid-url" } });

      expect(broadcast).not.toHaveBeenCalled();
    });

    it("broadcasts after each successful update", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      await manager.update({ ai: { baseUrl: "https://first.com" } });
      await manager.update({ ai: { modelId: "gpt-4o" } });

      expect(broadcast).toHaveBeenCalledTimes(2);
      // Second broadcast should include both updates merged
      const secondBroadcast = broadcast.mock.calls[1][0] as Settings;
      expect(secondBroadcast.ai.baseUrl).toBe("https://first.com");
      expect(secondBroadcast.ai.modelId).toBe("gpt-4o");
    });

    it("notifies local onChange listeners on successful update", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const listener = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });
      manager.onChange(listener);

      await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(listener).toHaveBeenCalledTimes(1);
      const notifiedSettings = listener.mock.calls[0][0] as Settings;
      expect(notifiedSettings.ai.baseUrl).toBe("https://api.test.com");
    });

    it("does not notify local onChange listeners on validation failure", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const listener = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast: () => {} });
      manager.onChange(listener);

      await manager.update({ ai: { baseUrl: "bad-url" } });

      expect(listener).not.toHaveBeenCalled();
    });

    it("broadcasts the complete merged settings object", async () => {
      const syncStorage = createMockSyncStorage();
      const localStorage = createMockLocalStorage();
      const broadcast = vi.fn();

      const manager = createSettingsManager({ syncStorage, localStorage, broadcast });

      // Only update one field
      await manager.update({ ai: { baseUrl: "https://api.openai.com" } });

      const broadcastedSettings = broadcast.mock.calls[0][0] as Settings;
      // Should contain the full settings object with defaults for other fields
      expect(broadcastedSettings.schemaVersion).toBe(1);
      expect(broadcastedSettings.ai.baseUrl).toBe("https://api.openai.com");
      expect(broadcastedSettings.ai.modelId).toBe(""); // default
      expect(broadcastedSettings.export.filenamePattern).toBe(DEFAULT_SETTINGS.export.filenamePattern);
      expect(broadcastedSettings.sitePatterns).toEqual(DEFAULT_SETTINGS.sitePatterns);
    });
  });
});
