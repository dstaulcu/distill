/**
 * Auto Export Scheduler — manages periodic content extraction and export
 * for configured sites using `browser.alarms`.
 *
 * Alarm names encode the tab ID: `auto-export-${tabId}`.
 *
 * Intended behavior: REQUIREMENTS.md SF-4.
 */

import type { AutoExportConfig, AutoExportMode, ExportDestination } from "@shared/types";
import type { ExtractionResult } from "@content/extractor/extract";
import { hashContent as defaultHashContent } from "./hasher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoExportScheduler {
  /** Create an alarm for a tab based on its origin's Auto_Export_Config. */
  scheduleForTab(tabId: number, origin: string): Promise<void>;
  /** Cancel the alarm for a specific tab. */
  cancelForTab(tabId: number): Promise<void>;
  /** Handle a browser.alarms.onAlarm event. */
  handleAlarm(alarm: { name: string; scheduledTime: number }): Promise<void>;
  /** Check if a tab has an active auto-export alarm. */
  isActiveForTab(tabId: number): boolean;
  /** Get status info for a tab's auto-export. */
  getStatus(tabId: number): AutoExportStatus | null;
  /** Clean up all alarms (e.g., on extension unload). */
  cancelAll(): Promise<void>;
}

export interface AutoExportStatus {
  readonly tabId: number;
  readonly origin: string;
  readonly lastCaptureTime: string | null;
  readonly nextFireTime: number;
  readonly lastHash: string | null;
  readonly consecutiveFailures: number;
}

export interface AutoExportInput {
  readonly tabId: number;
  readonly article: {
    readonly title: string;
    readonly bodyMarkdown: string;
    readonly author: string | null;
    readonly publicationDate: string | null;
    readonly sourceUrl: string;
    readonly siteName: string;
    readonly bodyCharacterCount: number;
  };
  readonly mode: AutoExportMode;
  readonly destination: ExportDestination;
}

export type AutoExportResult =
  | { readonly ok: true; readonly filename: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface AlarmsApi {
  create(name: string, alarmInfo: { periodInMinutes: number }): void;
  clear(name: string): Promise<boolean>;
  getAll(): Promise<Array<{ name: string; scheduledTime: number }>>;
}

export interface CreateAutoExportSchedulerOptions {
  readonly alarms: AlarmsApi;
  readonly extractContent: (tabId: number) => Promise<ExtractionResult>;
  readonly exportContent: (input: AutoExportInput) => Promise<AutoExportResult>;
  readonly getAutoExportConfig: (origin: string) => Promise<AutoExportConfig | null>;
  readonly hashContent?: (content: string) => string;
  readonly clock?: () => Date;
}

// ---------------------------------------------------------------------------
// Internal tracking state
// ---------------------------------------------------------------------------

interface TrackedTab {
  tabId: number;
  origin: string;
  lastCaptureTime: string | null;
  nextFireTime: number;
  lastHash: string | null;
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const ALARM_PREFIX = "auto-export-";

export function createAutoExportScheduler(opts: CreateAutoExportSchedulerOptions): AutoExportScheduler {
  const {
    alarms,
    extractContent,
    exportContent,
    getAutoExportConfig,
    hashContent = defaultHashContent,
    clock = () => new Date(),
  } = opts;

  const tracked = new Map<number, TrackedTab>();

  function alarmName(tabId: number): string {
    return `${ALARM_PREFIX}${tabId}`;
  }

  function parseTabId(name: string): number | null {
    if (!name.startsWith(ALARM_PREFIX)) return null;
    const id = parseInt(name.slice(ALARM_PREFIX.length), 10);
    return Number.isFinite(id) ? id : null;
  }

  const scheduler: AutoExportScheduler = {
    async scheduleForTab(tabId: number, origin: string): Promise<void> {
      const config = await getAutoExportConfig(origin);
      if (!config || !config.enabled) return;

      // Create the alarm
      alarms.create(alarmName(tabId), { periodInMinutes: config.intervalMinutes });

      // Estimate next fire time
      const now = clock().getTime();
      const nextFireTime = now + config.intervalMinutes * 60 * 1000;

      tracked.set(tabId, {
        tabId,
        origin,
        lastCaptureTime: null,
        nextFireTime,
        lastHash: null,
        consecutiveFailures: 0,
      });
    },

    async cancelForTab(tabId: number): Promise<void> {
      await alarms.clear(alarmName(tabId));
      tracked.delete(tabId);
    },

    async handleAlarm(alarm: { name: string; scheduledTime: number }): Promise<void> {
      const tabId = parseTabId(alarm.name);
      if (tabId === null) return;

      const entry = tracked.get(tabId);
      if (!entry) return;

      // Look up config for the origin
      const config = await getAutoExportConfig(entry.origin);
      if (!config || !config.enabled) return;

      // Extract content from the tab
      const extractionResult = await extractContent(tabId);

      if (!extractionResult.ok) {
        // Increment consecutive failures, do NOT cancel alarm
        entry.consecutiveFailures += 1;
        entry.nextFireTime = alarm.scheduledTime + config.intervalMinutes * 60 * 1000;
        return;
      }

      const { article } = extractionResult;

      // Check "skip if unchanged" mode. The hash is compared here but only
      // RECORDED after a successful export — otherwise a failed export would
      // make the next alarm skip content that was never captured (SF-4).
      let currentHash: string | null = null;
      if (config.skipIfUnchanged) {
        currentHash = hashContent(article.bodyMarkdown);
        if (entry.lastHash !== null && entry.lastHash === currentHash) {
          // Content unchanged — skip export, update next fire time
          entry.nextFireTime = alarm.scheduledTime + config.intervalMinutes * 60 * 1000;
          return;
        }
      }

      // Determine export mode — default to "content-only"
      const mode: AutoExportMode = config.mode ?? "content-only";

      // Export the content
      const exportResult = await exportContent({
        tabId,
        article,
        mode,
        destination: config.destination,
      });

      if (exportResult.ok) {
        entry.lastCaptureTime = clock().toISOString();
        entry.consecutiveFailures = 0;
        if (currentHash !== null) {
          entry.lastHash = currentHash;
        }
      } else {
        entry.consecutiveFailures += 1;
      }

      // Update next fire time
      entry.nextFireTime = alarm.scheduledTime + config.intervalMinutes * 60 * 1000;
    },

    isActiveForTab(tabId: number): boolean {
      return tracked.has(tabId);
    },

    getStatus(tabId: number): AutoExportStatus | null {
      const entry = tracked.get(tabId);
      if (!entry) return null;

      return {
        tabId: entry.tabId,
        origin: entry.origin,
        lastCaptureTime: entry.lastCaptureTime,
        nextFireTime: entry.nextFireTime,
        lastHash: entry.lastHash,
        consecutiveFailures: entry.consecutiveFailures,
      };
    },

    async cancelAll(): Promise<void> {
      const allAlarms = await alarms.getAll();
      const autoExportAlarms = allAlarms.filter((a) => a.name.startsWith(ALARM_PREFIX));
      await Promise.all(autoExportAlarms.map((a) => alarms.clear(a.name)));
      tracked.clear();
    },
  };

  return scheduler;
}
