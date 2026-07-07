/**
 * Integration tests for auto-export config persistence.
 *
 * Verifies end-to-end flow of saving, editing, deleting, and validating
 * auto-export configurations through the SettingsManager and AutoExportScheduler.
 *
 * Requirements: 14.2, 14.3, 14.12, 14.13
 */

import { describe, it, expect, vi } from "vitest";
import { createSettingsManager } from "@background/settings/manager";
import type { SettingsManager } from "@background/settings/manager";
import { createAutoExportScheduler } from "./scheduler";
import type { AutoExportScheduler, AlarmsApi, CreateAutoExportSchedulerOptions } from "./scheduler";
import type { StorageAdapter, StorageSetResult } from "@shared/storage";
import type { AutoExportConfig, Settings } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import { DEFAULT_SETTINGS } from "@background/settings/defaults";

// ---------------------------------------------------------------------------
// Test Helpers
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

function makeAlarms(): AlarmsApi & {
  _created: Array<{ name: string; alarmInfo: { periodInMinutes: number } }>;
  _cleared: string[];
} {
  const created: Array<{ name: string; alarmInfo: { periodInMinutes: number } }> = [];
  const cleared: string[] = [];
  const activeAlarms = new Map<string, { name: string; scheduledTime: number }>();

  return {
    _created: created,
    _cleared: cleared,
    create(name: string, alarmInfo: { periodInMinutes: number }) {
      created.push({ name, alarmInfo });
      activeAlarms.set(name, { name, scheduledTime: Date.now() + alarmInfo.periodInMinutes * 60_000 });
    },
    async clear(name: string) {
      cleared.push(name);
      activeAlarms.delete(name);
      return true;
    },
    async getAll() {
      return Array.from(activeAlarms.values());
    },
  };
}

function makeAutoExportConfig(overrides?: Partial<AutoExportConfig>): AutoExportConfig {
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

function makeExtractionSuccess(): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Test Article",
      author: "Author",
      publicationDate: "2024-01-15",
      sourceUrl: "https://example.com/page",
      siteName: "Example",
      bodyMarkdown: "Article body content.",
      bodyCharacterCount: 21,
    },
    confidence: "high",
  };
}

interface IntegrationContext {
  settingsManager: SettingsManager;
  scheduler: AutoExportScheduler;
  alarmsApi: ReturnType<typeof makeAlarms>;
  syncStorage: ReturnType<typeof createMockStorage>;
}

function createIntegrationContext(): IntegrationContext {
  const syncStorage = createMockStorage();
  const localStorage = createMockStorage();
  const broadcast = vi.fn();

  const settingsManager = createSettingsManager({
    syncStorage,
    localStorage,
    broadcast,
  });

  const alarmsApi = makeAlarms();

  // The scheduler's getAutoExportConfig reads from the settings manager
  const scheduler = createAutoExportScheduler({
    alarms: alarmsApi,
    extractContent: vi.fn().mockResolvedValue(makeExtractionSuccess()),
    exportContent: vi.fn().mockResolvedValue({ ok: true, filename: "test.md" }),
    getAutoExportConfig: async (origin: string) => {
      const settings = await settingsManager.get();
      return settings.autoExportConfigs.find((c) => c.origin === origin) ?? null;
    },
    hashContent: (content: string) => `hash-${content.length}`,
    clock: () => new Date("2024-01-20T08:00:00Z"),
  });

  return { settingsManager, scheduler, alarmsApi, syncStorage };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("Auto-export config persistence (integration)", () => {
  describe("save config via sidebar → retrieve in settings page", () => {
    it("persists a new auto-export config and retrieves it from settings", async () => {
      const { settingsManager } = createIntegrationContext();

      // Simulate sidebar saving a new auto-export config
      const newConfig = makeAutoExportConfig({
        origin: "https://conference.example.com",
        intervalMinutes: 10,
        destination: { kind: "download" },
        mode: "content-only",
        skipIfUnchanged: true,
      });

      const result = await settingsManager.update({
        autoExportConfigs: [newConfig],
      });

      expect(result.ok).toBe(true);

      // Simulate settings page retrieving the config
      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(1);
      expect(settings.autoExportConfigs[0].origin).toBe("https://conference.example.com");
      expect(settings.autoExportConfigs[0].intervalMinutes).toBe(10);
      expect(settings.autoExportConfigs[0].destination).toEqual({ kind: "download" });
      expect(settings.autoExportConfigs[0].mode).toBe("content-only");
      expect(settings.autoExportConfigs[0].skipIfUnchanged).toBe(true);
    });

    it("persists multiple configs for different origins", async () => {
      const { settingsManager } = createIntegrationContext();

      const configs = [
        makeAutoExportConfig({ origin: "https://site-a.com", intervalMinutes: 5 }),
        makeAutoExportConfig({ origin: "https://site-b.com", intervalMinutes: 30 }),
        makeAutoExportConfig({ origin: "https://site-c.com", intervalMinutes: 60 }),
      ];

      const result = await settingsManager.update({ autoExportConfigs: configs });
      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(3);
      expect(settings.autoExportConfigs.map((c) => c.origin)).toEqual([
        "https://site-a.com",
        "https://site-b.com",
        "https://site-c.com",
      ]);
    });

    it("scheduler can read config saved via settings manager", async () => {
      const { settingsManager, scheduler, alarmsApi } = createIntegrationContext();

      // Save config via settings manager (simulating sidebar save)
      const config = makeAutoExportConfig({
        origin: "https://live-event.com",
        intervalMinutes: 5,
      });
      await settingsManager.update({ autoExportConfigs: [config] });

      // Scheduler reads the config when scheduling
      await scheduler.scheduleForTab(42, "https://live-event.com");

      expect(scheduler.isActiveForTab(42)).toBe(true);
      expect(alarmsApi._created).toHaveLength(1);
      expect(alarmsApi._created[0].alarmInfo.periodInMinutes).toBe(5);
    });
  });

  describe("edit interval/destination/mode → verify update persisted", () => {
    it("updates interval and persists the change", async () => {
      const { settingsManager } = createIntegrationContext();

      // Initial save
      const config = makeAutoExportConfig({
        origin: "https://example.com",
        intervalMinutes: 15,
      });
      await settingsManager.update({ autoExportConfigs: [config] });

      // Edit interval
      const updatedConfig = { ...config, intervalMinutes: 45, updatedAt: "2024-01-02T00:00:00Z" };
      const result = await settingsManager.update({ autoExportConfigs: [updatedConfig] });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs[0].intervalMinutes).toBe(45);
      expect(settings.autoExportConfigs[0].updatedAt).toBe("2024-01-02T00:00:00Z");
    });

    it("updates destination from download to clipboard", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({
        origin: "https://example.com",
        destination: { kind: "download" },
      });
      await settingsManager.update({ autoExportConfigs: [config] });

      // Edit destination
      const updatedConfig = { ...config, destination: { kind: "clipboard" as const } };
      const result = await settingsManager.update({ autoExportConfigs: [updatedConfig] });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs[0].destination).toEqual({ kind: "clipboard" });
    });

    it("updates mode from content-only to full", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({
        origin: "https://example.com",
        mode: "content-only",
      });
      await settingsManager.update({ autoExportConfigs: [config] });

      // Edit mode
      const updatedConfig = { ...config, mode: "full" as const };
      const result = await settingsManager.update({ autoExportConfigs: [updatedConfig] });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs[0].mode).toBe("full");
    });

    it("scheduler uses updated interval after config edit", async () => {
      const { settingsManager, scheduler, alarmsApi } = createIntegrationContext();

      // Save initial config with 15 min interval
      const config = makeAutoExportConfig({
        origin: "https://example.com",
        intervalMinutes: 15,
      });
      await settingsManager.update({ autoExportConfigs: [config] });

      // Schedule with initial interval
      await scheduler.scheduleForTab(1, "https://example.com");
      expect(alarmsApi._created[0].alarmInfo.periodInMinutes).toBe(15);

      // Update interval to 30 minutes
      const updatedConfig = { ...config, intervalMinutes: 30 };
      await settingsManager.update({ autoExportConfigs: [updatedConfig] });

      // Cancel and reschedule (simulating what background script does on config change)
      await scheduler.cancelForTab(1);
      await scheduler.scheduleForTab(1, "https://example.com");

      expect(alarmsApi._created[1].alarmInfo.periodInMinutes).toBe(30);
    });

    it("preserves other configs when editing one", async () => {
      const { settingsManager } = createIntegrationContext();

      const configs = [
        makeAutoExportConfig({ origin: "https://site-a.com", intervalMinutes: 10 }),
        makeAutoExportConfig({ origin: "https://site-b.com", intervalMinutes: 20 }),
      ];
      await settingsManager.update({ autoExportConfigs: configs });

      // Edit only site-b
      const updatedConfigs = [
        configs[0],
        { ...configs[1], intervalMinutes: 60 },
      ];
      const result = await settingsManager.update({ autoExportConfigs: updatedConfigs });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs[0].intervalMinutes).toBe(10); // unchanged
      expect(settings.autoExportConfigs[1].intervalMinutes).toBe(60); // updated
    });
  });

  describe("delete config → verify alarm cancelled and config removed", () => {
    it("removes config from settings when deleted", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ origin: "https://example.com" });
      await settingsManager.update({ autoExportConfigs: [config] });

      // Delete by saving empty array
      const result = await settingsManager.update({ autoExportConfigs: [] });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(0);
    });

    it("cancels alarm when config is deleted and scheduler is notified", async () => {
      const { settingsManager, scheduler, alarmsApi } = createIntegrationContext();

      // Save config and schedule
      const config = makeAutoExportConfig({ origin: "https://example.com" });
      await settingsManager.update({ autoExportConfigs: [config] });
      await scheduler.scheduleForTab(42, "https://example.com");

      expect(scheduler.isActiveForTab(42)).toBe(true);

      // Delete config from settings
      await settingsManager.update({ autoExportConfigs: [] });

      // Background script would cancel the alarm on config deletion
      await scheduler.cancelForTab(42);

      expect(scheduler.isActiveForTab(42)).toBe(false);
      expect(alarmsApi._cleared).toContain("auto-export-42");
    });

    it("removes only the targeted config, preserving others", async () => {
      const { settingsManager } = createIntegrationContext();

      const configs = [
        makeAutoExportConfig({ origin: "https://site-a.com" }),
        makeAutoExportConfig({ origin: "https://site-b.com" }),
        makeAutoExportConfig({ origin: "https://site-c.com" }),
      ];
      await settingsManager.update({ autoExportConfigs: configs });

      // Delete site-b by filtering it out
      const remaining = configs.filter((c) => c.origin !== "https://site-b.com");
      const result = await settingsManager.update({ autoExportConfigs: remaining });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(2);
      expect(settings.autoExportConfigs.map((c) => c.origin)).toEqual([
        "https://site-a.com",
        "https://site-c.com",
      ]);
    });

    it("scheduler returns null config after deletion", async () => {
      const { settingsManager, scheduler, alarmsApi } = createIntegrationContext();

      // Save and schedule
      const config = makeAutoExportConfig({ origin: "https://example.com" });
      await settingsManager.update({ autoExportConfigs: [config] });
      await scheduler.scheduleForTab(42, "https://example.com");

      // Delete config
      await settingsManager.update({ autoExportConfigs: [] });

      // Attempting to schedule again should not create an alarm
      // (since getAutoExportConfig now returns null)
      await scheduler.cancelForTab(42);
      await scheduler.scheduleForTab(42, "https://example.com");

      expect(scheduler.isActiveForTab(42)).toBe(false);
    });
  });

  describe("config validation rejects invalid intervals", () => {
    it("rejects interval of 0", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ intervalMinutes: 0 });
      const result = await settingsManager.update({ autoExportConfigs: [config] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field.includes("intervalMinutes"))).toBe(true);
      }

      // Verify nothing was persisted
      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(0);
    });

    it("rejects interval greater than 120", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ intervalMinutes: 121 });
      const result = await settingsManager.update({ autoExportConfigs: [config] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field.includes("intervalMinutes"))).toBe(true);
      }

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(0);
    });

    it("rejects non-integer interval (e.g., 5.5)", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ intervalMinutes: 5.5 });
      const result = await settingsManager.update({ autoExportConfigs: [config] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field.includes("intervalMinutes"))).toBe(true);
      }

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(0);
    });

    it("rejects negative interval", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ intervalMinutes: -5 });
      const result = await settingsManager.update({ autoExportConfigs: [config] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.field.includes("intervalMinutes"))).toBe(true);
      }

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(0);
    });

    it("accepts valid interval of 1 (minimum)", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ intervalMinutes: 1 });
      const result = await settingsManager.update({ autoExportConfigs: [config] });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs[0].intervalMinutes).toBe(1);
    });

    it("accepts valid interval of 120 (maximum)", async () => {
      const { settingsManager } = createIntegrationContext();

      const config = makeAutoExportConfig({ intervalMinutes: 120 });
      const result = await settingsManager.update({ autoExportConfigs: [config] });

      expect(result.ok).toBe(true);

      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs[0].intervalMinutes).toBe(120);
    });

    it("does not persist valid configs when one config has invalid interval", async () => {
      const { settingsManager } = createIntegrationContext();

      const configs = [
        makeAutoExportConfig({ origin: "https://valid.com", intervalMinutes: 15 }),
        makeAutoExportConfig({ origin: "https://invalid.com", intervalMinutes: 0 }),
      ];
      const result = await settingsManager.update({ autoExportConfigs: configs });

      expect(result.ok).toBe(false);

      // Neither config should be persisted
      const settings = await settingsManager.get();
      expect(settings.autoExportConfigs).toHaveLength(0);
    });

    it("reports field-level error with correct index for invalid config", async () => {
      const { settingsManager } = createIntegrationContext();

      const configs = [
        makeAutoExportConfig({ origin: "https://valid.com", intervalMinutes: 10 }),
        makeAutoExportConfig({ origin: "https://invalid.com", intervalMinutes: 200 }),
      ];
      const result = await settingsManager.update({ autoExportConfigs: configs });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const intervalError = result.errors.find((e) => e.field.includes("intervalMinutes"));
        expect(intervalError).toBeDefined();
        expect(intervalError!.field).toBe("autoExportConfigs[1].intervalMinutes");
      }
    });
  });
});
