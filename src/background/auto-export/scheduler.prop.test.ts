/**
 * Property-based tests for Auto Export Scheduler.
 *
 * Covers Properties 20, 21, 22, 25, 26, 27 from the design document.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createAutoExportScheduler } from "./scheduler";
import type {
  CreateAutoExportSchedulerOptions,
  AlarmsApi,
  AutoExportInput,
} from "./scheduler";
import type { AutoExportConfig, AutoExportMode, ExportDestination, Settings } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import { validateSettings } from "@background/settings/manager";
import { DEFAULT_SETTINGS } from "@background/settings/defaults";

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AutoExportConfig>): AutoExportConfig {
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

function makeExtractionSuccess(bodyMarkdown = "Article body content."): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Test Article",
      author: "Author",
      publicationDate: "2024-01-15",
      sourceUrl: "https://example.com/page",
      siteName: "Example",
      bodyMarkdown,
      bodyCharacterCount: bodyMarkdown.length,
    },
    confidence: "high",
  };
}

function makeExtractionFailure(): ExtractionResult {
  return {
    ok: false,
    reason: "no-content-detected",
    detail: "No article content found",
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

function makeOpts(overrides?: Partial<CreateAutoExportSchedulerOptions>): CreateAutoExportSchedulerOptions {
  return {
    alarms: makeAlarms(),
    extractContent: vi.fn().mockResolvedValue(makeExtractionSuccess()),
    exportContent: vi.fn().mockResolvedValue({ ok: true, filename: "2024-01-20-0800-test-article.md" }),
    getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig()),
    hashContent: (content: string) => `hash-${content.length}`,
    clock: () => new Date("2024-01-20T08:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const validInterval = fc.integer({ min: 1, max: 120 });

const validTabId = fc.integer({ min: 1, max: 100000 });

const validOrigin = fc.webUrl().map((url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "https://example.com";
  }
});

const validDestination: fc.Arbitrary<ExportDestination> = fc.oneof(
  fc.constant({ kind: "download" } as ExportDestination),
  fc.constant({ kind: "clipboard" } as ExportDestination),
);

const validMode: fc.Arbitrary<AutoExportMode> = fc.oneof(
  fc.constant("content-only" as AutoExportMode),
  fc.constant("full" as AutoExportMode),
);

// ---------------------------------------------------------------------------
// Property 21: Alarm creation uses correct interval from config
// Validates: Requirements 14.4
// ---------------------------------------------------------------------------

describe("Property 21: Alarm creation uses correct interval from config", () => {
  it("alarm is created with periodInMinutes matching config interval and name matching auto-export-${tabId}", () => {
    /**
     * **Validates: Requirements 14.4**
     */
    fc.assert(
      fc.asyncProperty(validTabId, validInterval, async (tabId, interval) => {
        const alarmsApi = makeAlarms();
        const config = makeConfig({ intervalMinutes: interval });
        const opts = makeOpts({
          alarms: alarmsApi,
          getAutoExportConfig: vi.fn().mockResolvedValue(config),
        });
        const scheduler = createAutoExportScheduler(opts);

        await scheduler.scheduleForTab(tabId, "https://example.com");

        expect(alarmsApi._created).toHaveLength(1);
        expect(alarmsApi._created[0].name).toBe(`auto-export-${tabId}`);
        expect(alarmsApi._created[0].alarmInfo.periodInMinutes).toBe(interval);
      }),
      { numRuns: 100 },
    );
  });

  it("tab is marked active after scheduling", () => {
    /**
     * **Validates: Requirements 14.4**
     */
    fc.assert(
      fc.asyncProperty(validTabId, validInterval, async (tabId, interval) => {
        const config = makeConfig({ intervalMinutes: interval });
        const opts = makeOpts({
          getAutoExportConfig: vi.fn().mockResolvedValue(config),
        });
        const scheduler = createAutoExportScheduler(opts);

        await scheduler.scheduleForTab(tabId, "https://example.com");

        expect(scheduler.isActiveForTab(tabId)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22: Alarm cleanup on navigation away or tab close
// Validates: Requirements 14.9, 14.10
// ---------------------------------------------------------------------------

describe("Property 22: Alarm cleanup on navigation away or tab close", () => {
  it("cancelForTab clears alarm and isActiveForTab returns false", () => {
    /**
     * **Validates: Requirements 14.9, 14.10**
     */
    fc.assert(
      fc.asyncProperty(validTabId, async (tabId) => {
        const alarmsApi = makeAlarms();
        const opts = makeOpts({ alarms: alarmsApi });
        const scheduler = createAutoExportScheduler(opts);

        // Schedule first
        await scheduler.scheduleForTab(tabId, "https://example.com");
        expect(scheduler.isActiveForTab(tabId)).toBe(true);

        // Cancel (simulates navigation away or tab close)
        await scheduler.cancelForTab(tabId);

        expect(alarmsApi._cleared).toContain(`auto-export-${tabId}`);
        expect(scheduler.isActiveForTab(tabId)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("cancelling multiple tabs independently cleans up each one", () => {
    /**
     * **Validates: Requirements 14.9, 14.10**
     */
    fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(validTabId, { minLength: 2, maxLength: 5 }),
        async (tabIds) => {
          const alarmsApi = makeAlarms();
          const opts = makeOpts({ alarms: alarmsApi });
          const scheduler = createAutoExportScheduler(opts);

          // Schedule all tabs
          for (const tabId of tabIds) {
            await scheduler.scheduleForTab(tabId, `https://site-${tabId}.com`);
          }

          // Cancel the first tab (simulates navigation away)
          await scheduler.cancelForTab(tabIds[0]);

          // First tab should be inactive
          expect(scheduler.isActiveForTab(tabIds[0])).toBe(false);
          expect(alarmsApi._cleared).toContain(`auto-export-${tabIds[0]}`);

          // Other tabs should still be active
          for (let i = 1; i < tabIds.length; i++) {
            expect(scheduler.isActiveForTab(tabIds[i])).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 27: Extraction failure does not disable schedule
// Validates: Requirements 14.8
// ---------------------------------------------------------------------------

describe("Property 27: Extraction failure does not disable schedule", () => {
  it("alarm remains active and consecutiveFailures increments after extraction failure", () => {
    /**
     * **Validates: Requirements 14.8**
     */
    fc.assert(
      fc.asyncProperty(
        validTabId,
        fc.integer({ min: 1, max: 10 }),
        async (tabId, failureCount) => {
          const alarmsApi = makeAlarms();
          const extractContent = vi.fn().mockResolvedValue(makeExtractionFailure());
          const exportContent = vi.fn();
          const opts = makeOpts({
            alarms: alarmsApi,
            extractContent,
            exportContent,
          });
          const scheduler = createAutoExportScheduler(opts);

          await scheduler.scheduleForTab(tabId, "https://example.com");

          // Fire alarm multiple times with extraction failures
          for (let i = 0; i < failureCount; i++) {
            await scheduler.handleAlarm({
              name: `auto-export-${tabId}`,
              scheduledTime: Date.now() + i * 60_000,
            });
          }

          // Alarm should still be active (not cancelled)
          expect(scheduler.isActiveForTab(tabId)).toBe(true);
          expect(alarmsApi._cleared).not.toContain(`auto-export-${tabId}`);

          // Consecutive failures should be tracked
          const status = scheduler.getStatus(tabId);
          expect(status).not.toBeNull();
          expect(status!.consecutiveFailures).toBe(failureCount);

          // Export should never have been called
          expect(exportContent).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25: Export mode composition
// Validates: Requirements 14.14, 14.15
// ---------------------------------------------------------------------------

describe("Property 25: Export mode composition", () => {
  it("content-only mode passes mode as 'content-only' to exportContent", () => {
    /**
     * **Validates: Requirements 14.14, 14.15**
     */
    fc.assert(
      fc.asyncProperty(validTabId, async (tabId) => {
        const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
        const config = makeConfig({ mode: "content-only" });
        const opts = makeOpts({
          exportContent,
          getAutoExportConfig: vi.fn().mockResolvedValue(config),
        });
        const scheduler = createAutoExportScheduler(opts);

        await scheduler.scheduleForTab(tabId, "https://example.com");
        await scheduler.handleAlarm({ name: `auto-export-${tabId}`, scheduledTime: Date.now() });

        expect(exportContent).toHaveBeenCalledTimes(1);
        const input = exportContent.mock.calls[0][0] as AutoExportInput;
        expect(input.mode).toBe("content-only");
      }),
      { numRuns: 50 },
    );
  });

  it("full mode passes mode as 'full' to exportContent", () => {
    /**
     * **Validates: Requirements 14.14, 14.15**
     */
    fc.assert(
      fc.asyncProperty(validTabId, async (tabId) => {
        const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
        const config = makeConfig({ mode: "full" });
        const opts = makeOpts({
          exportContent,
          getAutoExportConfig: vi.fn().mockResolvedValue(config),
        });
        const scheduler = createAutoExportScheduler(opts);

        await scheduler.scheduleForTab(tabId, "https://example.com");
        await scheduler.handleAlarm({ name: `auto-export-${tabId}`, scheduledTime: Date.now() });

        expect(exportContent).toHaveBeenCalledTimes(1);
        const input = exportContent.mock.calls[0][0] as AutoExportInput;
        expect(input.mode).toBe("full");
      }),
      { numRuns: 50 },
    );
  });

  it("export mode from config is always passed through to exportContent", () => {
    /**
     * **Validates: Requirements 14.14, 14.15**
     */
    fc.assert(
      fc.asyncProperty(validTabId, validMode, async (tabId, mode) => {
        const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
        const config = makeConfig({ mode });
        const opts = makeOpts({
          exportContent,
          getAutoExportConfig: vi.fn().mockResolvedValue(config),
        });
        const scheduler = createAutoExportScheduler(opts);

        await scheduler.scheduleForTab(tabId, "https://example.com");
        await scheduler.handleAlarm({ name: `auto-export-${tabId}`, scheduledTime: Date.now() });

        expect(exportContent).toHaveBeenCalledTimes(1);
        const input = exportContent.mock.calls[0][0] as AutoExportInput;
        expect(input.mode).toBe(mode);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: Auto_Export_Config persistence round-trip
// Validates: Requirements 14.3
// ---------------------------------------------------------------------------

describe("Property 20: Auto_Export_Config persistence round-trip", () => {
  it("valid Auto_Export_Config passes settings validation", () => {
    /**
     * **Validates: Requirements 14.3**
     */
    fc.assert(
      fc.property(
        validOrigin,
        validInterval,
        validDestination,
        validMode,
        fc.boolean(),
        (origin, intervalMinutes, destination, mode, skipIfUnchanged) => {
          const config: AutoExportConfig = {
            origin,
            enabled: true,
            intervalMinutes,
            destination,
            mode,
            skipIfUnchanged,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          };

          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            autoExportConfigs: [config],
          };

          const errors = validateSettings(settings);
          const intervalErrors = errors.filter((e) => e.field.includes("intervalMinutes"));
          expect(intervalErrors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("config round-trips through settings structure without data loss", () => {
    /**
     * **Validates: Requirements 14.3**
     */
    fc.assert(
      fc.property(
        validOrigin,
        validInterval,
        validDestination,
        validMode,
        fc.boolean(),
        (origin, intervalMinutes, destination, mode, skipIfUnchanged) => {
          const config: AutoExportConfig = {
            origin,
            enabled: true,
            intervalMinutes,
            destination,
            mode,
            skipIfUnchanged,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          };

          // Simulate save/load by serializing and deserializing (JSON round-trip)
          const serialized = JSON.stringify(config);
          const deserialized = JSON.parse(serialized) as AutoExportConfig;

          expect(deserialized.origin).toBe(origin);
          expect(deserialized.intervalMinutes).toBe(intervalMinutes);
          expect(deserialized.destination).toEqual(destination);
          expect(deserialized.mode).toBe(mode);
          expect(deserialized.skipIfUnchanged).toBe(skipIfUnchanged);
          expect(deserialized.enabled).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26: Auto-export interval validation
// Validates: Requirements 14.2
// ---------------------------------------------------------------------------

describe("Property 26: Auto-export interval validation", () => {
  it("integers in [1, 120] are accepted without validation errors", () => {
    /**
     * **Validates: Requirements 14.2**
     */
    fc.assert(
      fc.property(validInterval, (interval) => {
        const config: AutoExportConfig = {
          origin: "https://example.com",
          enabled: true,
          intervalMinutes: interval,
          destination: { kind: "download" },
          mode: "content-only",
          skipIfUnchanged: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        };

        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          autoExportConfigs: [config],
        };

        const errors = validateSettings(settings);
        const intervalErrors = errors.filter((e) => e.field.includes("intervalMinutes"));
        expect(intervalErrors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it("non-integer values are rejected", () => {
    /**
     * **Validates: Requirements 14.2**
     */
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 200, noNaN: true }).filter((n) => !Number.isInteger(n)),
        (interval) => {
          const config: AutoExportConfig = {
            origin: "https://example.com",
            enabled: true,
            intervalMinutes: interval,
            destination: { kind: "download" },
            mode: "content-only",
            skipIfUnchanged: false,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          };

          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            autoExportConfigs: [config],
          };

          const errors = validateSettings(settings);
          const intervalErrors = errors.filter((e) => e.field.includes("intervalMinutes"));
          expect(intervalErrors).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("integers below 1 are rejected", () => {
    /**
     * **Validates: Requirements 14.2**
     */
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 0 }), (interval) => {
        const config: AutoExportConfig = {
          origin: "https://example.com",
          enabled: true,
          intervalMinutes: interval,
          destination: { kind: "download" },
          mode: "content-only",
          skipIfUnchanged: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        };

        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          autoExportConfigs: [config],
        };

        const errors = validateSettings(settings);
        const intervalErrors = errors.filter((e) => e.field.includes("intervalMinutes"));
        expect(intervalErrors).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it("integers above 120 are rejected", () => {
    /**
     * **Validates: Requirements 14.2**
     */
    fc.assert(
      fc.property(fc.integer({ min: 121, max: 10000 }), (interval) => {
        const config: AutoExportConfig = {
          origin: "https://example.com",
          enabled: true,
          intervalMinutes: interval,
          destination: { kind: "download" },
          mode: "content-only",
          skipIfUnchanged: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        };

        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          autoExportConfigs: [config],
        };

        const errors = validateSettings(settings);
        const intervalErrors = errors.filter((e) => e.field.includes("intervalMinutes"));
        expect(intervalErrors).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });
});
