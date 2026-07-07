/**
 * Unit tests for Auto Export Scheduler.
 *
 * Tests scheduling, alarm handling, change detection, failure resilience,
 * and cleanup with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAutoExportScheduler } from "./scheduler";
import type {
  CreateAutoExportSchedulerOptions,
  AlarmsApi,
  AutoExportInput,
  AutoExportResult,
} from "./scheduler";
import type { AutoExportConfig, AutoExportMode, ExportDestination } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";

// ---------------------------------------------------------------------------
// Test Helpers
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
  get(name: string): Promise<{ name: string; scheduledTime: number } | undefined>;
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
    async get(name: string) {
      return activeAlarms.get(name);
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
// Tests
// ---------------------------------------------------------------------------

describe("Auto Export Scheduler", () => {
  describe("scheduleForTab", () => {
    it("creates an alarm with the correct name and interval", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({ alarms: alarmsApi });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      expect(alarmsApi._created).toHaveLength(1);
      expect(alarmsApi._created[0].name).toBe("auto-export-42");
      expect(alarmsApi._created[0].alarmInfo.periodInMinutes).toBe(15);
    });

    it("marks the tab as active after scheduling", async () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      expect(scheduler.isActiveForTab(42)).toBe(true);
    });

    it("does not create alarm when config is null", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({
        alarms: alarmsApi,
        getAutoExportConfig: vi.fn().mockResolvedValue(null),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      expect(alarmsApi._created).toHaveLength(0);
      expect(scheduler.isActiveForTab(42)).toBe(false);
    });

    it("does not create alarm when config is disabled", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({
        alarms: alarmsApi,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ enabled: false })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      expect(alarmsApi._created).toHaveLength(0);
      expect(scheduler.isActiveForTab(42)).toBe(false);
    });

    it("uses the interval from the config", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({
        alarms: alarmsApi,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ intervalMinutes: 30 })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(1, "https://example.com");

      expect(alarmsApi._created[0].alarmInfo.periodInMinutes).toBe(30);
    });

    it("sets initial status with null lastCaptureTime and lastHash", async () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      const status = scheduler.getStatus(42);
      expect(status).not.toBeNull();
      expect(status!.lastCaptureTime).toBeNull();
      expect(status!.lastHash).toBeNull();
      expect(status!.consecutiveFailures).toBe(0);
      expect(status!.origin).toBe("https://example.com");
      expect(status!.tabId).toBe(42);
    });
  });

  describe("cancelForTab", () => {
    it("clears the alarm and removes from tracking", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({ alarms: alarmsApi });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      expect(scheduler.isActiveForTab(42)).toBe(true);

      await scheduler.cancelForTab(42);

      expect(alarmsApi._cleared).toContain("auto-export-42");
      expect(scheduler.isActiveForTab(42)).toBe(false);
      expect(scheduler.getStatus(42)).toBeNull();
    });

    it("handles cancelling a tab that was never scheduled", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({ alarms: alarmsApi });
      const scheduler = createAutoExportScheduler(opts);

      // Should not throw
      await scheduler.cancelForTab(99);

      expect(alarmsApi._cleared).toContain("auto-export-99");
      expect(scheduler.isActiveForTab(99)).toBe(false);
    });
  });

  describe("handleAlarm", () => {
    it("extracts content and exports on alarm fire", async () => {
      const extractContent = vi.fn().mockResolvedValue(makeExtractionSuccess());
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const opts = makeOpts({ extractContent, exportContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      expect(extractContent).toHaveBeenCalledWith(42);
      expect(exportContent).toHaveBeenCalledTimes(1);
    });

    it("passes correct mode and destination to exportContent", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const opts = makeOpts({
        exportContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(
          makeConfig({ mode: "full", destination: { kind: "clipboard" } }),
        ),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      const input = exportContent.mock.calls[0][0] as AutoExportInput;
      expect(input.mode).toBe("full");
      expect(input.destination).toEqual({ kind: "clipboard" });
      expect(input.tabId).toBe(42);
    });

    it("defaults to content-only mode", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const opts = makeOpts({
        exportContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ mode: "content-only" })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      const input = exportContent.mock.calls[0][0] as AutoExportInput;
      expect(input.mode).toBe("content-only");
    });

    it("updates lastCaptureTime on successful export", async () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      const status = scheduler.getStatus(42);
      expect(status!.lastCaptureTime).toBe("2024-01-20T08:00:00.000Z");
      expect(status!.consecutiveFailures).toBe(0);
    });

    it("increments consecutiveFailures on extraction failure without cancelling", async () => {
      const extractContent = vi.fn().mockResolvedValue(makeExtractionFailure());
      const exportContent = vi.fn();
      const alarmsApi = makeAlarms();
      const opts = makeOpts({ extractContent, exportContent, alarms: alarmsApi });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      // Should NOT have exported
      expect(exportContent).not.toHaveBeenCalled();

      // Should still be active
      expect(scheduler.isActiveForTab(42)).toBe(true);

      // Should have incremented failures
      const status = scheduler.getStatus(42);
      expect(status!.consecutiveFailures).toBe(1);
      expect(status!.lastCaptureTime).toBeNull();
    });

    it("increments consecutiveFailures on export failure", async () => {
      const exportContent = vi.fn().mockResolvedValue({
        ok: false,
        reason: "download-failed",
        detail: "Disk full",
      });
      const opts = makeOpts({ exportContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      const status = scheduler.getStatus(42);
      expect(status!.consecutiveFailures).toBe(1);
      expect(status!.lastCaptureTime).toBeNull();
    });

    it("accumulates consecutive failures across multiple alarm fires", async () => {
      const extractContent = vi.fn().mockResolvedValue(makeExtractionFailure());
      const opts = makeOpts({ extractContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      const status = scheduler.getStatus(42);
      expect(status!.consecutiveFailures).toBe(3);
    });

    it("resets consecutiveFailures on successful export", async () => {
      const extractContent = vi.fn()
        .mockResolvedValueOnce(makeExtractionFailure())
        .mockResolvedValueOnce(makeExtractionSuccess());
      const opts = makeOpts({ extractContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(scheduler.getStatus(42)!.consecutiveFailures).toBe(1);

      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(scheduler.getStatus(42)!.consecutiveFailures).toBe(0);
    });

    it("ignores alarms that are not auto-export alarms", async () => {
      const extractContent = vi.fn();
      const opts = makeOpts({ extractContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.handleAlarm({ name: "some-other-alarm", scheduledTime: Date.now() });

      expect(extractContent).not.toHaveBeenCalled();
    });

    it("ignores alarms for tabs not in tracking map", async () => {
      const extractContent = vi.fn();
      const opts = makeOpts({ extractContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.handleAlarm({ name: "auto-export-999", scheduledTime: Date.now() });

      expect(extractContent).not.toHaveBeenCalled();
    });

    it("does nothing if config becomes null after scheduling", async () => {
      const getAutoExportConfig = vi.fn()
        .mockResolvedValueOnce(makeConfig()) // for scheduleForTab
        .mockResolvedValueOnce(null); // for handleAlarm
      const exportContent = vi.fn();
      const opts = makeOpts({ getAutoExportConfig, exportContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      expect(exportContent).not.toHaveBeenCalled();
    });
  });

  describe("skip if unchanged", () => {
    it("skips export when content hash matches previous", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const hashContent = vi.fn().mockReturnValue("same-hash");
      const opts = makeOpts({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      // First alarm — no previous hash, should export
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      // Second alarm — same hash, should skip
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1); // Still 1
    });

    it("exports when content hash differs from previous", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      let callCount = 0;
      const hashContent = vi.fn().mockImplementation(() => `hash-${++callCount}`);
      const opts = makeOpts({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2);
    });

    it("always exports on first alarm (no previous hash)", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const opts = makeOpts({
        exportContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      expect(exportContent).toHaveBeenCalledTimes(1);
    });

    it("SF-4 retries the capture at the next alarm when the export fails (hash recorded only on success)", async () => {
      // Q4 decision: a failed export must not consume the content revision.
      const exportContent = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: "download-failed", detail: "disk full" })
        .mockResolvedValue({ ok: true, filename: "test.md" });
      const hashContent = vi.fn().mockReturnValue("same-hash");
      const opts = makeOpts({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      // First alarm: export attempted and fails — the hash must NOT be recorded
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);
      expect(scheduler.getStatus(42)?.lastHash).toBeNull();

      // Second alarm: same content, but the previous attempt failed — retry, don't skip
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2);
      expect(scheduler.getStatus(42)?.lastHash).toBe("same-hash");
    });

    it("does not check hash when skipIfUnchanged is false", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const hashContent = vi.fn().mockReturnValue("same-hash");
      const opts = makeOpts({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: false })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      // Should export both times even with same hash
      expect(exportContent).toHaveBeenCalledTimes(2);
    });

    it("updates lastHash in status after export", async () => {
      const hashContent = vi.fn().mockReturnValue("abc123");
      const opts = makeOpts({
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime: Date.now() });

      const status = scheduler.getStatus(42);
      expect(status!.lastHash).toBe("abc123");
    });
  });

  describe("isActiveForTab", () => {
    it("returns false for untracked tabs", () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      expect(scheduler.isActiveForTab(42)).toBe(false);
    });

    it("returns true for tracked tabs", async () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      expect(scheduler.isActiveForTab(42)).toBe(true);
    });

    it("returns false after cancellation", async () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.cancelForTab(42);

      expect(scheduler.isActiveForTab(42)).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns null for untracked tabs", () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      expect(scheduler.getStatus(42)).toBeNull();
    });

    it("returns full status for tracked tabs", async () => {
      const opts = makeOpts({
        clock: () => new Date("2024-01-20T10:00:00Z"),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");

      const status = scheduler.getStatus(42);
      expect(status).toEqual({
        tabId: 42,
        origin: "https://example.com",
        lastCaptureTime: null,
        nextFireTime: new Date("2024-01-20T10:00:00Z").getTime() + 15 * 60 * 1000,
        lastHash: null,
        consecutiveFailures: 0,
      });
    });

    it("updates nextFireTime after alarm fires", async () => {
      const scheduledTime = new Date("2024-01-20T10:15:00Z").getTime();
      const opts = makeOpts({
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ intervalMinutes: 15 })),
      });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(42, "https://example.com");
      await scheduler.handleAlarm({ name: "auto-export-42", scheduledTime });

      const status = scheduler.getStatus(42);
      expect(status!.nextFireTime).toBe(scheduledTime + 15 * 60 * 1000);
    });
  });

  describe("cancelAll", () => {
    it("clears all auto-export alarms and tracking", async () => {
      const alarmsApi = makeAlarms();
      const opts = makeOpts({ alarms: alarmsApi });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(1, "https://site-a.com");
      await scheduler.scheduleForTab(2, "https://site-b.com");
      await scheduler.scheduleForTab(3, "https://site-c.com");

      expect(scheduler.isActiveForTab(1)).toBe(true);
      expect(scheduler.isActiveForTab(2)).toBe(true);
      expect(scheduler.isActiveForTab(3)).toBe(true);

      await scheduler.cancelAll();

      expect(scheduler.isActiveForTab(1)).toBe(false);
      expect(scheduler.isActiveForTab(2)).toBe(false);
      expect(scheduler.isActiveForTab(3)).toBe(false);
    });

    it("only clears auto-export alarms, not other alarms", async () => {
      const alarmsApi = makeAlarms();
      // Manually add a non-auto-export alarm
      alarmsApi.create("some-other-alarm", { periodInMinutes: 5 });

      const opts = makeOpts({ alarms: alarmsApi });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(1, "https://example.com");
      await scheduler.cancelAll();

      // The "some-other-alarm" should not have been cleared
      // Only "auto-export-1" should be in the cleared list
      expect(alarmsApi._cleared).toContain("auto-export-1");
      expect(alarmsApi._cleared).not.toContain("some-other-alarm");
    });
  });

  describe("multiple tabs", () => {
    it("tracks multiple tabs independently", async () => {
      const opts = makeOpts();
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(1, "https://site-a.com");
      await scheduler.scheduleForTab(2, "https://site-b.com");

      expect(scheduler.isActiveForTab(1)).toBe(true);
      expect(scheduler.isActiveForTab(2)).toBe(true);

      await scheduler.cancelForTab(1);

      expect(scheduler.isActiveForTab(1)).toBe(false);
      expect(scheduler.isActiveForTab(2)).toBe(true);
    });

    it("handles alarms for different tabs correctly", async () => {
      const extractContent = vi.fn().mockResolvedValue(makeExtractionSuccess());
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const opts = makeOpts({ extractContent, exportContent });
      const scheduler = createAutoExportScheduler(opts);

      await scheduler.scheduleForTab(1, "https://site-a.com");
      await scheduler.scheduleForTab(2, "https://site-b.com");

      await scheduler.handleAlarm({ name: "auto-export-1", scheduledTime: Date.now() });

      expect(extractContent).toHaveBeenCalledWith(1);
      expect(exportContent).toHaveBeenCalledTimes(1);

      const input = exportContent.mock.calls[0][0] as AutoExportInput;
      expect(input.tabId).toBe(1);
    });
  });
});
