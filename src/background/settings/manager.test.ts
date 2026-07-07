import { describe, it, expect, vi } from "vitest";
import { createSettingsManager, validateSettings } from "./manager";
import type { PartialSettings, FieldError } from "./manager";
import type { StorageAdapter, StorageSetResult } from "@shared/storage";
import type { Settings } from "@shared/types";
import { DEFAULT_SETTINGS } from "./defaults";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockStorage(): StorageAdapter & { data: Map<string, unknown> } {
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

function createQuotaExceededStorage(): StorageAdapter & { data: Map<string, unknown> } {
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

function createErrorStorage(): StorageAdapter {
  return {
    async get<T>(_key: string): Promise<T | undefined> {
      return undefined;
    },
    async set<T>(_key: string, _value: T): Promise<StorageSetResult> {
      return { ok: false, reason: "storage-error", detail: "Unknown storage error" };
    },
    async remove(_key: string): Promise<void> {},
    subscribe() {
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-5 SettingsManager", () => {
  describe("get()", () => {
    it("returns default settings when nothing is persisted", async () => {
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      const settings = await manager.get();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("returns persisted settings from sync storage", async () => {
      const syncStorage = createMockStorage();
      const customSettings: Settings = {
        ...DEFAULT_SETTINGS,
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.example.com" },
      };
      syncStorage.data.set("settings", customSettings);

      const manager = createSettingsManager({
        syncStorage,
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      const settings = await manager.get();
      expect(settings.ai.baseUrl).toBe("https://api.example.com");
    });

    it("CF-5.1 falls back to reading local storage when sync has nothing (survives restart after quota fallback)", async () => {
      // Simulates a restart after a quota-exceeded fallback wrote to local:
      // a fresh manager instance (in-memory flag reset) must still find them.
      const localStorage = createMockStorage();
      const savedToLocal: Settings = {
        ...DEFAULT_SETTINGS,
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://saved-to-local.example" },
      };
      localStorage.data.set("settings", savedToLocal);

      const manager = createSettingsManager({
        syncStorage: createMockStorage(), // empty — like a fresh sync store
        localStorage,
        broadcast: () => {},
      });

      const settings = await manager.get();
      expect(settings.ai.baseUrl).toBe("https://saved-to-local.example");
    });
  });

  describe("update()", () => {
    it("merges a partial AI config patch", async () => {
      const syncStorage = createMockStorage();
      const broadcast = vi.fn();
      const manager = createSettingsManager({
        syncStorage,
        localStorage: createMockStorage(),
        broadcast,
      });

      const result = await manager.update({
        ai: { baseUrl: "https://api.openai.com" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.ai.baseUrl).toBe("https://api.openai.com");
        expect(result.settings.ai.modelId).toBe(""); // unchanged
        expect(result.settings.ai.apiKeyRef).toBeNull(); // unchanged
      }
    });

    it("merges a partial export config patch", async () => {
      const syncStorage = createMockStorage();
      const manager = createSettingsManager({
        syncStorage,
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      const result = await manager.update({
        export: { filenamePattern: "DD-MM-YYYY-slugified-title" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.export.filenamePattern).toBe("DD-MM-YYYY-slugified-title");
        expect(result.settings.export.defaultDestination).toEqual({ kind: "download" }); // unchanged
      }
    });

    it("replaces sitePatterns entirely when provided", async () => {
      const syncStorage = createMockStorage();
      const manager = createSettingsManager({
        syncStorage,
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      const newPatterns = [
        { id: "user-1", source: "user" as const, urlMatchPattern: "*://*.example.com/*", contentSelector: ".content" },
      ];

      const result = await manager.update({ sitePatterns: newPatterns });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.sitePatterns).toEqual(newPatterns);
      }
    });

    it("persists to sync storage", async () => {
      const syncStorage = createMockStorage();
      const manager = createSettingsManager({
        syncStorage,
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      const stored = syncStorage.data.get("settings") as Settings;
      expect(stored.ai.baseUrl).toBe("https://api.test.com");
    });

    it("broadcasts settings on successful update", async () => {
      const broadcast = vi.fn();
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast,
      });

      await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ ai: expect.objectContaining({ baseUrl: "https://api.test.com" }) }),
      );
    });

    it("does not broadcast on validation failure", async () => {
      const broadcast = vi.fn();
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast,
      });

      await manager.update({ ai: { baseUrl: "not-a-url" } });

      expect(broadcast).not.toHaveBeenCalled();
    });

    it("notifies onChange listeners on successful update", async () => {
      const listener = vi.fn();
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      manager.onChange(listener);
      await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ ai: expect.objectContaining({ baseUrl: "https://api.test.com" }) }),
      );
    });

    it("does not notify onChange listeners on validation failure", async () => {
      const listener = vi.fn();
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      manager.onChange(listener);
      await manager.update({ ai: { baseUrl: "invalid" } });

      expect(listener).not.toHaveBeenCalled();
    });

    it("allows updating apiKeyRef to null", async () => {
      const syncStorage = createMockStorage();
      const manager = createSettingsManager({
        syncStorage,
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      // First set a ref
      await manager.update({ ai: { apiKeyRef: "ref-123" } });
      let result = await manager.update({ ai: { apiKeyRef: null } });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.ai.apiKeyRef).toBeNull();
      }
    });
  });

  describe("sync/local fallback", () => {
    it("falls back to local storage on quota exceeded", async () => {
      const quotaStorage = createQuotaExceededStorage();
      const localStorage = createMockStorage();
      const manager = createSettingsManager({
        syncStorage: quotaStorage,
        localStorage,
        broadcast: () => {},
      });

      const result = await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(result.ok).toBe(true);
      expect(manager.isSyncing()).toBe(false);
      const stored = localStorage.data.get("settings") as Settings;
      expect(stored.ai.baseUrl).toBe("https://api.test.com");
    });

    it("continues using local storage after fallback", async () => {
      const quotaStorage = createQuotaExceededStorage();
      const localStorage = createMockStorage();
      const manager = createSettingsManager({
        syncStorage: quotaStorage,
        localStorage,
        broadcast: () => {},
      });

      // First update triggers fallback
      await manager.update({ ai: { baseUrl: "https://api.test.com" } });
      expect(manager.isSyncing()).toBe(false);

      // Second update should go directly to local
      await manager.update({ ai: { modelId: "gpt-4" } });
      const stored = localStorage.data.get("settings") as Settings;
      expect(stored.ai.modelId).toBe("gpt-4");
    });

    it("isSyncing() returns true initially", () => {
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      expect(manager.isSyncing()).toBe(true);
    });

    it("returns error when both storages fail", async () => {
      const quotaStorage = createQuotaExceededStorage();
      const errorStorage = createErrorStorage();
      const manager = createSettingsManager({
        syncStorage: quotaStorage,
        localStorage: errorStorage,
        broadcast: () => {},
      });

      const result = await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // A storage failure is not a validation failure — report it honestly
        expect(result.reason).toBe("storage-error");
        expect(result.errors[0].field).toBe("_storage");
      }
    });
  });

  describe("onChange()", () => {
    it("returns an unsubscribe function", async () => {
      const listener = vi.fn();
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      const unsubscribe = manager.onChange(listener);
      await manager.update({ ai: { baseUrl: "https://api.test.com" } });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      await manager.update({ ai: { baseUrl: "https://api2.test.com" } });
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it("supports multiple listeners", async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const manager = createSettingsManager({
        syncStorage: createMockStorage(),
        localStorage: createMockStorage(),
        broadcast: () => {},
      });

      manager.onChange(listener1);
      manager.onChange(listener2);
      await manager.update({ ai: { baseUrl: "https://api.test.com" } });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });
});

describe("CF-5.2 validateSettings", () => {
  describe("ai.baseUrl", () => {
    it("accepts empty string", () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "" } };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "ai.baseUrl")).toHaveLength(0);
    });

    it("accepts http:// URL", () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "http://localhost:8080" } };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "ai.baseUrl")).toHaveLength(0);
    });

    it("accepts https:// URL", () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://api.openai.com" } };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "ai.baseUrl")).toHaveLength(0);
    });

    it("rejects URL without protocol", () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "api.openai.com" } };
      const errors = validateSettings(settings);
      const urlErrors = errors.filter((e) => e.field === "ai.baseUrl");
      expect(urlErrors).toHaveLength(1);
      expect(urlErrors[0].message).toContain("http");
    });

    it("rejects ftp:// URL", () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "ftp://files.example.com" } };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "ai.baseUrl")).toHaveLength(1);
    });
  });

  describe("export.filenamePattern", () => {
    it("accepts non-empty pattern", () => {
      const settings: Settings = { ...DEFAULT_SETTINGS };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "export.filenamePattern")).toHaveLength(0);
    });

    it("rejects empty pattern", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        export: { ...DEFAULT_SETTINGS.export, filenamePattern: "" },
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "export.filenamePattern")).toHaveLength(1);
    });

    it("rejects whitespace-only pattern", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        export: { ...DEFAULT_SETTINGS.export, filenamePattern: "   " },
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "export.filenamePattern")).toHaveLength(1);
    });
  });

  describe("sitePatterns", () => {
    it("accepts up to 50 user-defined patterns", () => {
      const patterns = Array.from({ length: 50 }, (_, i) => ({
        id: `user-${i}`,
        source: "user" as const,
        urlMatchPattern: `*://*.site${i}.com/*`,
        contentSelector: ".content",
      }));
      const settings: Settings = { ...DEFAULT_SETTINGS, sitePatterns: patterns };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "sitePatterns")).toHaveLength(0);
    });

    it("rejects more than 50 user-defined patterns", () => {
      const patterns = Array.from({ length: 51 }, (_, i) => ({
        id: `user-${i}`,
        source: "user" as const,
        urlMatchPattern: `*://*.site${i}.com/*`,
        contentSelector: ".content",
      }));
      const settings: Settings = { ...DEFAULT_SETTINGS, sitePatterns: patterns };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "sitePatterns")).toHaveLength(1);
    });

    it("does not count builtin patterns toward the limit", () => {
      const builtins = Array.from({ length: 100 }, (_, i) => ({
        id: `builtin-${i}`,
        source: "builtin" as const,
        urlMatchPattern: `*://*.site${i}.com/*`,
        contentSelector: ".content",
      }));
      const settings: Settings = { ...DEFAULT_SETTINGS, sitePatterns: builtins };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field === "sitePatterns")).toHaveLength(0);
    });
  });

  describe("autoExportConfigs[].intervalMinutes", () => {
    it("accepts interval of 1", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        autoExportConfigs: [makeAutoExportConfig({ intervalMinutes: 1 })],
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field.includes("intervalMinutes"))).toHaveLength(0);
    });

    it("accepts interval of 120", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        autoExportConfigs: [makeAutoExportConfig({ intervalMinutes: 120 })],
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field.includes("intervalMinutes"))).toHaveLength(0);
    });

    it("rejects interval of 0", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        autoExportConfigs: [makeAutoExportConfig({ intervalMinutes: 0 })],
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field.includes("intervalMinutes"))).toHaveLength(1);
    });

    it("rejects interval of 121", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        autoExportConfigs: [makeAutoExportConfig({ intervalMinutes: 121 })],
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field.includes("intervalMinutes"))).toHaveLength(1);
    });

    it("rejects non-integer interval", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        autoExportConfigs: [makeAutoExportConfig({ intervalMinutes: 5.5 })],
      };
      const errors = validateSettings(settings);
      expect(errors.filter((e) => e.field.includes("intervalMinutes"))).toHaveLength(1);
    });

    it("validates each config independently", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        autoExportConfigs: [
          makeAutoExportConfig({ intervalMinutes: 10 }),
          makeAutoExportConfig({ intervalMinutes: 0 }),
          makeAutoExportConfig({ intervalMinutes: 200 }),
        ],
      };
      const errors = validateSettings(settings);
      const intervalErrors = errors.filter((e) => e.field.includes("intervalMinutes"));
      expect(intervalErrors).toHaveLength(2);
      expect(intervalErrors[0].field).toBe("autoExportConfigs[1].intervalMinutes");
      expect(intervalErrors[1].field).toBe("autoExportConfigs[2].intervalMinutes");
    });
  });

  describe("multiple validation errors", () => {
    it("returns all errors at once", () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "invalid-url" },
        export: { ...DEFAULT_SETTINGS.export, filenamePattern: "" },
        autoExportConfigs: [makeAutoExportConfig({ intervalMinutes: 0 })],
      };
      const errors = validateSettings(settings);
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAutoExportConfig(overrides: Partial<Settings["autoExportConfigs"][number]> = {}): Settings["autoExportConfigs"][number] {
  return {
    origin: "https://example.com",
    enabled: true,
    intervalMinutes: 15,
    destination: { kind: "download" },
    mode: "content-only",
    skipIfUnchanged: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}
