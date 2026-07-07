/**
 * Integration tests for the Auto-Export Lifecycle.
 *
 * These tests verify the end-to-end auto-export flow:
 * - Alarm creation on page load with matching origin config
 * - Alarm fires → extraction → export with timestamp filename
 * - "Skip if unchanged" mode behavior
 * - Navigation away from origin → alarm cancelled
 * - Tab close → alarm cancelled
 * - Extraction failure → alarm persists, retries next cycle
 *
 * Requirements: 14.4, 14.5, 14.8, 14.9, 14.10, 14.11
 */

import { describe, it, expect, vi } from "vitest";
import { createAutoExportScheduler } from "./scheduler";
import type {
  CreateAutoExportSchedulerOptions,
  AlarmsApi,
  AutoExportInput,
  AutoExportResult,
} from "./scheduler";
import type { AutoExportConfig } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import { generateAutoExportFilename } from "./filename";

// ---------------------------------------------------------------------------
// Shared Test Infrastructure
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AutoExportConfig>): AutoExportConfig {
  return {
    origin: "https://conference.example.com",
    enabled: true,
    intervalMinutes: 10,
    destination: { kind: "download" },
    mode: "content-only",
    skipIfUnchanged: false,
    createdAt: "2024-03-01T09:00:00Z",
    updatedAt: "2024-03-01T09:00:00Z",
    ...overrides,
  };
}

function makeExtractionSuccess(bodyMarkdown = "# Live Transcript\n\nSpeaker A said something."): ExtractionResult {
  return {
    ok: true,
    article: {
      title: "Conference Session - Day 1",
      author: null,
      publicationDate: null,
      sourceUrl: "https://conference.example.com/live",
      siteName: "Conference Live",
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
    detail: "No article content found on page",
  };
}

function makeAlarms(): AlarmsApi & {
  _created: Array<{ name: string; alarmInfo: { periodInMinutes: number } }>;
  _cleared: string[];
  _active: Map<string, { name: string; scheduledTime: number }>;
} {
  const created: Array<{ name: string; alarmInfo: { periodInMinutes: number } }> = [];
  const cleared: string[] = [];
  const active = new Map<string, { name: string; scheduledTime: number }>();

  return {
    _created: created,
    _cleared: cleared,
    _active: active,
    create(name: string, alarmInfo: { periodInMinutes: number }) {
      created.push({ name, alarmInfo });
      active.set(name, { name, scheduledTime: Date.now() + alarmInfo.periodInMinutes * 60_000 });
    },
    async clear(name: string) {
      cleared.push(name);
      active.delete(name);
      return true;
    },
    async getAll() {
      return Array.from(active.values());
    },
  };
}

interface LifecycleHarness {
  scheduler: ReturnType<typeof createAutoExportScheduler>;
  alarms: ReturnType<typeof makeAlarms>;
  extractContent: ReturnType<typeof vi.fn>;
  exportContent: ReturnType<typeof vi.fn>;
  getAutoExportConfig: ReturnType<typeof vi.fn>;
  clock: () => Date;
}

function createHarness(overrides?: Partial<CreateAutoExportSchedulerOptions>): LifecycleHarness {
  const alarmsApi = makeAlarms();
  const extractContent = vi.fn().mockResolvedValue(makeExtractionSuccess());
  const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "2024-03-01-0910-conference-session-day-1.md" });
  const getAutoExportConfig = vi.fn().mockResolvedValue(makeConfig());
  const clockFn = () => new Date("2024-03-01T09:00:00Z");

  const opts: CreateAutoExportSchedulerOptions = {
    alarms: alarmsApi,
    extractContent,
    exportContent,
    getAutoExportConfig,
    clock: clockFn,
    ...overrides,
  };

  const scheduler = createAutoExportScheduler(opts);

  return {
    scheduler,
    alarms: alarmsApi,
    extractContent: extractContent as ReturnType<typeof vi.fn>,
    exportContent: exportContent as ReturnType<typeof vi.fn>,
    getAutoExportConfig: getAutoExportConfig as ReturnType<typeof vi.fn>,
    clock: clockFn,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("Auto-Export Lifecycle (Integration)", () => {
  describe("alarm creation on page load with matching origin config", () => {
    it("creates alarm when tab loads a page whose origin has a saved config", async () => {
      const { scheduler, alarms } = createHarness();

      // Simulate: tab 5 loads https://conference.example.com/live
      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // Alarm should be created with correct name and interval
      expect(alarms._created).toHaveLength(1);
      expect(alarms._created[0].name).toBe("auto-export-5");
      expect(alarms._created[0].alarmInfo.periodInMinutes).toBe(10);
      expect(scheduler.isActiveForTab(5)).toBe(true);
    });

    it("does not create alarm when origin has no config", async () => {
      const { scheduler, alarms } = createHarness({
        getAutoExportConfig: vi.fn().mockResolvedValue(null),
      });

      await scheduler.scheduleForTab(5, "https://no-config.example.com");

      expect(alarms._created).toHaveLength(0);
      expect(scheduler.isActiveForTab(5)).toBe(false);
    });

    it("does not create alarm when config exists but is disabled", async () => {
      const { scheduler, alarms } = createHarness({
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ enabled: false })),
      });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      expect(alarms._created).toHaveLength(0);
      expect(scheduler.isActiveForTab(5)).toBe(false);
    });
  });

  describe("alarm fires → extraction → export with timestamp filename", () => {
    it("full cycle: alarm fires, content extracted, exported with correct inputs", async () => {
      const { scheduler, extractContent, exportContent } = createHarness();

      // Schedule the tab
      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // Simulate alarm firing
      const scheduledTime = new Date("2024-03-01T09:10:00Z").getTime();
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime });

      // Extraction should be called for the correct tab
      expect(extractContent).toHaveBeenCalledWith(5);

      // Export should be called with the article data
      expect(exportContent).toHaveBeenCalledTimes(1);
      const exportInput: AutoExportInput = exportContent.mock.calls[0][0];
      expect(exportInput.tabId).toBe(5);
      expect(exportInput.article.title).toBe("Conference Session - Day 1");
      expect(exportInput.mode).toBe("content-only");
      expect(exportInput.destination).toEqual({ kind: "download" });
    });

    it("generates a timestamp-based filename for auto-export", () => {
      // Verify the filename generator produces the expected pattern
      const result = generateAutoExportFilename({
        title: "Conference Session - Day 1",
        date: new Date("2024-03-01T09:10:00Z"),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should match YYYY-MM-DD-HHmm-slug.md pattern
        expect(result.filename).toMatch(/^2024-03-01-0910-conference-session-day-1\.md$/);
      }
    });

    it("updates status after successful export", async () => {
      const { scheduler } = createHarness();

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      const scheduledTime = new Date("2024-03-01T09:10:00Z").getTime();
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime });

      const status = scheduler.getStatus(5);
      expect(status).not.toBeNull();
      expect(status!.lastCaptureTime).toBe("2024-03-01T09:00:00.000Z");
      expect(status!.consecutiveFailures).toBe(0);
    });

    it("supports full mode with summary when configured", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const { scheduler } = createHarness({
        exportContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ mode: "full" })),
      });

      await scheduler.scheduleForTab(5, "https://conference.example.com");
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });

      const input: AutoExportInput = exportContent.mock.calls[0][0];
      expect(input.mode).toBe("full");
    });
  });

  describe("skip if unchanged mode", () => {
    it("same content → skip export on second alarm", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const hashContent = vi.fn().mockReturnValue("stable-hash-abc");
      const { scheduler } = createHarness({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // First alarm — no previous hash, should export
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      // Second alarm — same hash, should skip
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1); // Still 1, skipped

      // Status should reflect no new capture
      const status = scheduler.getStatus(5);
      expect(status!.lastHash).toBe("stable-hash-abc");
    });

    it("different content → export on second alarm", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      let callCount = 0;
      const hashContent = vi.fn().mockImplementation(() => `hash-v${++callCount}`);
      const { scheduler } = createHarness({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // First alarm — exports (no previous hash)
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      // Second alarm — different hash, should export again
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2);
    });

    it("multiple cycles: skip → change → skip → change", async () => {
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const hashes = ["h1", "h1", "h2", "h2", "h3"];
      let idx = 0;
      const hashContent = vi.fn().mockImplementation(() => hashes[idx++] ?? "final");
      const { scheduler } = createHarness({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // Alarm 1: hash=h1, no previous → export
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      // Alarm 2: hash=h1, same as previous → skip
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      // Alarm 3: hash=h2, different → export
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2);

      // Alarm 4: hash=h2, same → skip
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2);

      // Alarm 5: hash=h3, different → export
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(3);
    });
  });

  describe("navigation away from origin → alarm cancelled", () => {
    it("cancelling alarm on navigation removes tracking and clears alarm", async () => {
      const { scheduler, alarms } = createHarness();

      // Tab loads page with matching config
      await scheduler.scheduleForTab(5, "https://conference.example.com");
      expect(scheduler.isActiveForTab(5)).toBe(true);

      // Simulate: background detects navigation to different origin
      // Background script would call cancelForTab when origin changes
      await scheduler.cancelForTab(5);

      // Alarm should be cleared
      expect(alarms._cleared).toContain("auto-export-5");
      expect(scheduler.isActiveForTab(5)).toBe(false);
      expect(scheduler.getStatus(5)).toBeNull();
    });

    it("alarm does not fire after navigation cancellation", async () => {
      const { scheduler, extractContent } = createHarness();

      await scheduler.scheduleForTab(5, "https://conference.example.com");
      await scheduler.cancelForTab(5);

      // Simulate a stale alarm firing (shouldn't happen in practice, but tests resilience)
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });

      // extractContent should not be called since tab is no longer tracked
      expect(extractContent).not.toHaveBeenCalled();
    });

    it("can reschedule after navigating back to configured origin", async () => {
      const { scheduler, alarms } = createHarness();

      // Initial schedule
      await scheduler.scheduleForTab(5, "https://conference.example.com");
      expect(scheduler.isActiveForTab(5)).toBe(true);

      // Navigate away
      await scheduler.cancelForTab(5);
      expect(scheduler.isActiveForTab(5)).toBe(false);

      // Navigate back
      await scheduler.scheduleForTab(5, "https://conference.example.com");
      expect(scheduler.isActiveForTab(5)).toBe(true);
      expect(alarms._created).toHaveLength(2); // Two create calls total
    });
  });

  describe("tab close → alarm cancelled", () => {
    it("cancelling alarm on tab close removes all tracking", async () => {
      const { scheduler, alarms } = createHarness();

      await scheduler.scheduleForTab(5, "https://conference.example.com");
      expect(scheduler.isActiveForTab(5)).toBe(true);

      // Simulate: background detects tab close via browser.tabs.onRemoved
      await scheduler.cancelForTab(5);

      expect(alarms._cleared).toContain("auto-export-5");
      expect(scheduler.isActiveForTab(5)).toBe(false);
      expect(scheduler.getStatus(5)).toBeNull();
    });

    it("closing one tab does not affect other tabs' alarms", async () => {
      const { scheduler, alarms } = createHarness();

      await scheduler.scheduleForTab(5, "https://conference.example.com");
      await scheduler.scheduleForTab(8, "https://conference.example.com");

      // Close tab 5
      await scheduler.cancelForTab(5);

      // Tab 8 should still be active
      expect(scheduler.isActiveForTab(5)).toBe(false);
      expect(scheduler.isActiveForTab(8)).toBe(true);
      expect(scheduler.getStatus(8)).not.toBeNull();
    });

    it("alarm for closed tab does not trigger extraction", async () => {
      const { scheduler, extractContent } = createHarness();

      await scheduler.scheduleForTab(5, "https://conference.example.com");
      await scheduler.cancelForTab(5); // Tab closed

      // Stale alarm fires
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });

      expect(extractContent).not.toHaveBeenCalled();
    });
  });

  describe("extraction failure → alarm persists, retries next cycle", () => {
    it("extraction failure increments failures but keeps alarm active", async () => {
      const extractContent = vi.fn().mockResolvedValue(makeExtractionFailure());
      const exportContent = vi.fn();
      const { scheduler, alarms } = createHarness({ extractContent, exportContent });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // Alarm fires, extraction fails
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });

      // Should NOT have exported
      expect(exportContent).not.toHaveBeenCalled();

      // Alarm should still be active (not cleared)
      expect(scheduler.isActiveForTab(5)).toBe(true);
      expect(alarms._cleared).not.toContain("auto-export-5");

      // Failures should be tracked
      const status = scheduler.getStatus(5);
      expect(status!.consecutiveFailures).toBe(1);
      expect(status!.lastCaptureTime).toBeNull();
    });

    it("retries successfully on next cycle after failure", async () => {
      const extractContent = vi.fn()
        .mockResolvedValueOnce(makeExtractionFailure())
        .mockResolvedValueOnce(makeExtractionSuccess());
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const { scheduler } = createHarness({ extractContent, exportContent });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // First alarm — extraction fails
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).not.toHaveBeenCalled();
      expect(scheduler.getStatus(5)!.consecutiveFailures).toBe(1);

      // Second alarm — extraction succeeds
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);
      expect(scheduler.getStatus(5)!.consecutiveFailures).toBe(0);
      expect(scheduler.getStatus(5)!.lastCaptureTime).not.toBeNull();
    });

    it("accumulates failures across multiple cycles without disabling", async () => {
      const extractContent = vi.fn().mockResolvedValue(makeExtractionFailure());
      const { scheduler } = createHarness({ extractContent });

      await scheduler.scheduleForTab(5, "https://conference.example.com");

      // Multiple failures
      for (let i = 0; i < 5; i++) {
        await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      }

      // Still active after 5 consecutive failures
      expect(scheduler.isActiveForTab(5)).toBe(true);
      expect(scheduler.getStatus(5)!.consecutiveFailures).toBe(5);
    });

    it("export failure also increments failures but keeps alarm active", async () => {
      const exportContent = vi.fn().mockResolvedValue({
        ok: false,
        reason: "download-failed",
        detail: "Disk full",
      });
      const { scheduler, alarms } = createHarness({ exportContent });

      await scheduler.scheduleForTab(5, "https://conference.example.com");
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });

      expect(scheduler.isActiveForTab(5)).toBe(true);
      expect(alarms._cleared).not.toContain("auto-export-5");
      expect(scheduler.getStatus(5)!.consecutiveFailures).toBe(1);
    });
  });

  describe("end-to-end lifecycle scenario", () => {
    it("full lifecycle: schedule → export → skip unchanged → change → export → navigate away → cancel", async () => {
      let hashValue = "initial-hash";
      const hashContent = vi.fn().mockImplementation(() => hashValue);
      const exportContent = vi.fn().mockResolvedValue({ ok: true, filename: "test.md" });
      const { scheduler, alarms } = createHarness({
        exportContent,
        hashContent,
        getAutoExportConfig: vi.fn().mockResolvedValue(makeConfig({ skipIfUnchanged: true })),
      });

      // 1. Tab loads page with matching config
      await scheduler.scheduleForTab(5, "https://conference.example.com");
      expect(scheduler.isActiveForTab(5)).toBe(true);
      expect(alarms._created).toHaveLength(1);

      // 2. First alarm fires → extracts and exports (no previous hash)
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1);

      // 3. Second alarm fires → same content → skip
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(1); // Still 1

      // 4. Content changes
      hashValue = "updated-hash";

      // 5. Third alarm fires → different content → export
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2);

      // 6. User navigates away from origin
      await scheduler.cancelForTab(5);
      expect(scheduler.isActiveForTab(5)).toBe(false);
      expect(alarms._cleared).toContain("auto-export-5");

      // 7. Stale alarm should not trigger anything
      await scheduler.handleAlarm({ name: "auto-export-5", scheduledTime: Date.now() });
      expect(exportContent).toHaveBeenCalledTimes(2); // No change
    });
  });
});
