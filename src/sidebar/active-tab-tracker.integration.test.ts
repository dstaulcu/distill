/**
 * Integration tests for Active Tab Tracker.
 *
 * These tests verify end-to-end scenarios combining multiple behaviors:
 * window filtering, tab switching, navigation detection, tab close recovery,
 * and initial query on sidebar load.
 *
 * Validates: Requirements 12.1, 12.2, 12.4, 12.5, 12.6
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createActiveTabTracker } from "./active-tab-tracker";
import type { ActiveTabTracker } from "./active-tab-tracker";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type ActivatedListener = (info: { tabId: number; windowId: number }) => void;
type UpdatedListener = (
  tabId: number,
  changeInfo: { status?: string; url?: string },
  tab: { id?: number; url?: string; windowId?: number },
) => void;
type RemovedListener = (tabId: number) => void;

interface MockTabs {
  query: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  onActivated: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    _listeners: ActivatedListener[];
    _fire(info: { tabId: number; windowId: number }): void;
  };
  onUpdated: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    _listeners: UpdatedListener[];
    _fire(
      tabId: number,
      changeInfo: { status?: string; url?: string },
      tab: { id?: number; url?: string; windowId?: number },
    ): void;
  };
  onRemoved: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    _listeners: RemovedListener[];
    _fire(tabId: number): void;
  };
}

interface MockWindows {
  getCurrent: ReturnType<typeof vi.fn>;
}

function createMockTabs(): MockTabs {
  const activatedListeners: ActivatedListener[] = [];
  const updatedListeners: UpdatedListener[] = [];
  const removedListeners: RemovedListener[] = [];

  return {
    query: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: 1, url: "" }),
    onActivated: {
      addListener: vi.fn((fn: ActivatedListener) => activatedListeners.push(fn)),
      removeListener: vi.fn((fn: ActivatedListener) => {
        const idx = activatedListeners.indexOf(fn);
        if (idx >= 0) activatedListeners.splice(idx, 1);
      }),
      _listeners: activatedListeners,
      _fire(info: { tabId: number; windowId: number }) {
        for (const fn of [...activatedListeners]) fn(info);
      },
    },
    onUpdated: {
      addListener: vi.fn((fn: UpdatedListener) => updatedListeners.push(fn)),
      removeListener: vi.fn((fn: UpdatedListener) => {
        const idx = updatedListeners.indexOf(fn);
        if (idx >= 0) updatedListeners.splice(idx, 1);
      }),
      _listeners: updatedListeners,
      _fire(
        tabId: number,
        changeInfo: { status?: string; url?: string },
        tab: { id?: number; url?: string; windowId?: number },
      ) {
        for (const fn of [...updatedListeners]) fn(tabId, changeInfo, tab);
      },
    },
    onRemoved: {
      addListener: vi.fn((fn: RemovedListener) => removedListeners.push(fn)),
      removeListener: vi.fn((fn: RemovedListener) => {
        const idx = removedListeners.indexOf(fn);
        if (idx >= 0) removedListeners.splice(idx, 1);
      }),
      _listeners: removedListeners,
      _fire(tabId: number) {
        for (const fn of [...removedListeners]) fn(tabId);
      },
    },
  };
}

function createMockWindows(windowId = 100): MockWindows {
  return {
    getCurrent: vi.fn().mockResolvedValue({ id: windowId }),
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("ActiveTabTracker integration", () => {
  let mockTabs: MockTabs;
  let mockWindows: MockWindows;
  const SIDEBAR_WINDOW = 42;
  const OTHER_WINDOW = 99;

  beforeEach(() => {
    mockTabs = createMockTabs();
    mockWindows = createMockWindows(SIDEBAR_WINDOW);
  });

  async function createTracker(): Promise<ActiveTabTracker> {
    return createActiveTabTracker({
      tabs: mockTabs as unknown as typeof browser.tabs,
      windows: mockWindows as unknown as typeof browser.windows,
    });
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Initial query on sidebar load determines the active tab
  // Validates: Requirement 12.1
  // -------------------------------------------------------------------------

  describe("initial query on sidebar load", () => {
    it("determines the active tab from the current window on first load", async () => {
      mockTabs.query.mockResolvedValue([
        { id: 10, url: "https://docs.example.com/getting-started" },
      ]);

      const tracker = await createTracker();

      expect(mockWindows.getCurrent).toHaveBeenCalledTimes(1);
      expect(mockTabs.query).toHaveBeenCalledWith({ active: true, windowId: SIDEBAR_WINDOW });
      expect(tracker.getActiveTabId()).toBe(10);
      expect(tracker.getActiveTabUrl()).toBe("https://docs.example.com/getting-started");
    });

    it("handles sidebar opening in a window with no tabs gracefully", async () => {
      mockTabs.query.mockResolvedValue([]);

      const tracker = await createTracker();

      expect(tracker.getActiveTabId()).toBeNull();
      expect(tracker.getActiveTabUrl()).toBeNull();
    });

    it("notifies listeners once a tab becomes active after starting with none", async () => {
      mockTabs.query.mockResolvedValue([]);
      mockTabs.get.mockResolvedValue({ id: 5, url: "https://new-tab.com" });

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // A tab becomes active in the sidebar's window
      mockTabs.onActivated._fire({ tabId: 5, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(cb).toHaveBeenCalled());

      expect(tracker.getActiveTabId()).toBe(5);
      expect(tracker.getActiveTabUrl()).toBe("https://new-tab.com");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Window filtering — only events from sidebar's window matter
  // Validates: Requirements 12.2, 12.6
  // -------------------------------------------------------------------------

  describe("window filtering", () => {
    it("ignores tab activations from other windows while tracking sidebar window", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://original.com" }]);
      mockTabs.get.mockResolvedValue({ id: 50, url: "https://other-window-tab.com" });

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Fire activations from a different window
      mockTabs.onActivated._fire({ tabId: 50, windowId: OTHER_WINDOW });
      mockTabs.onActivated._fire({ tabId: 51, windowId: OTHER_WINDOW });
      mockTabs.onActivated._fire({ tabId: 52, windowId: OTHER_WINDOW });

      await new Promise((r) => setTimeout(r, 20));

      expect(cb).not.toHaveBeenCalled();
      expect(tracker.getActiveTabId()).toBe(1);
      expect(tracker.getActiveTabUrl()).toBe("https://original.com");
    });

    it("processes activation from sidebar window after ignoring other windows", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://original.com" }]);
      mockTabs.get.mockImplementation((tabId: number) =>
        Promise.resolve({ id: tabId, url: `https://tab-${tabId}.com` }),
      );

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Events from other window — should be ignored
      mockTabs.onActivated._fire({ tabId: 50, windowId: OTHER_WINDOW });
      await new Promise((r) => setTimeout(r, 10));
      expect(cb).not.toHaveBeenCalled();

      // Event from sidebar's window — should be processed
      mockTabs.onActivated._fire({ tabId: 7, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(cb).toHaveBeenCalled());

      expect(tracker.getActiveTabId()).toBe(7);
      expect(tracker.getActiveTabUrl()).toBe("https://tab-7.com");
    });

    it("interleaved events from multiple windows only reflect sidebar window", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://start.com" }]);
      mockTabs.get.mockImplementation((tabId: number) =>
        Promise.resolve({ id: tabId, url: `https://tab-${tabId}.com` }),
      );

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Interleaved events
      mockTabs.onActivated._fire({ tabId: 20, windowId: OTHER_WINDOW });
      mockTabs.onActivated._fire({ tabId: 3, windowId: SIDEBAR_WINDOW });
      mockTabs.onActivated._fire({ tabId: 21, windowId: OTHER_WINDOW });

      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(3));

      // Only one notification for the sidebar window event
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(3, "https://tab-3.com");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Tab switch — onActivated fires for sidebar's window
  // Validates: Requirement 12.2
  // -------------------------------------------------------------------------

  describe("tab switch via onActivated", () => {
    it("updates tracked tab and notifies on switch within sidebar window", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://first.com" }]);
      mockTabs.get.mockImplementation((tabId: number) =>
        Promise.resolve({ id: tabId, url: `https://tab-${tabId}.com` }),
      );

      const tracker = await createTracker();
      const changes: Array<{ tabId: number; url: string }> = [];
      tracker.onActiveTabChanged((tabId, url) => changes.push({ tabId, url }));

      // Switch through multiple tabs
      mockTabs.onActivated._fire({ tabId: 2, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));

      mockTabs.onActivated._fire({ tabId: 3, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(3));

      mockTabs.onActivated._fire({ tabId: 4, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(4));

      expect(changes).toHaveLength(3);
      expect(changes[0]).toEqual({ tabId: 2, url: "https://tab-2.com" });
      expect(changes[1]).toEqual({ tabId: 3, url: "https://tab-3.com" });
      expect(changes[2]).toEqual({ tabId: 4, url: "https://tab-4.com" });
    });

    it("switching back to a previously active tab still triggers notification", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://first.com" }]);
      mockTabs.get.mockImplementation((tabId: number) =>
        Promise.resolve({ id: tabId, url: `https://tab-${tabId}.com` }),
      );

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Switch to tab 2
      mockTabs.onActivated._fire({ tabId: 2, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));

      // Switch back to tab 1
      mockTabs.get.mockResolvedValue({ id: 1, url: "https://first.com" });
      mockTabs.onActivated._fire({ tabId: 1, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(1));

      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Navigation detection — onUpdated with URL change
  // Validates: Requirement 12.4
  // -------------------------------------------------------------------------

  describe("navigation detection via onUpdated", () => {
    it("detects navigation to a different path and triggers re-extraction", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://blog.com/post/1" }]);

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Tab navigates to a different path
      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://blog.com/post/2", windowId: SIDEBAR_WINDOW },
      );

      expect(cb).toHaveBeenCalledWith(1, "https://blog.com/post/2");
      expect(tracker.getActiveTabUrl()).toBe("https://blog.com/post/2");
    });

    it("detects navigation to a different origin and triggers re-extraction", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://site-a.com/page" }]);

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://site-b.com/page", windowId: SIDEBAR_WINDOW },
      );

      expect(cb).toHaveBeenCalledWith(1, "https://site-b.com/page");
    });

    it("does not trigger re-extraction for fragment-only changes", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://docs.com/guide#intro" }]);

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://docs.com/guide#section-2", windowId: SIDEBAR_WINDOW },
      );

      expect(cb).not.toHaveBeenCalled();
      // URL is still updated internally
      expect(tracker.getActiveTabUrl()).toBe("https://docs.com/guide#section-2");
    });

    it("handles multiple navigations in sequence correctly", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://news.com/article/1" }]);

      const tracker = await createTracker();
      const changes: string[] = [];
      tracker.onActiveTabChanged((_tabId, url) => changes.push(url));

      // Navigate through several pages
      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://news.com/article/2", windowId: SIDEBAR_WINDOW },
      );
      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://news.com/article/3", windowId: SIDEBAR_WINDOW },
      );
      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://other-site.com/home", windowId: SIDEBAR_WINDOW },
      );

      expect(changes).toEqual([
        "https://news.com/article/2",
        "https://news.com/article/3",
        "https://other-site.com/home",
      ]);
    });

    it("ignores onUpdated events for non-active tabs", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://active.com" }]);

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Update for a different tab
      mockTabs.onUpdated._fire(
        99,
        { status: "complete" },
        { id: 99, url: "https://background-tab.com", windowId: SIDEBAR_WINDOW },
      );

      expect(cb).not.toHaveBeenCalled();
      expect(tracker.getActiveTabId()).toBe(1);
    });

    it("ignores onUpdated events with status other than 'complete'", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/page1" }]);

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Loading status — should be ignored
      mockTabs.onUpdated._fire(
        1,
        { status: "loading" },
        { id: 1, url: "https://example.com/page2", windowId: SIDEBAR_WINDOW },
      );

      expect(cb).not.toHaveBeenCalled();
      expect(tracker.getActiveTabUrl()).toBe("https://example.com/page1");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Tab close recovery — re-queries to find new active tab
  // Validates: Requirement 12.5
  // -------------------------------------------------------------------------

  describe("tab close recovery", () => {
    it("recovers by querying the new active tab when current tab is closed", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://closing-tab.com" }]) // init
        .mockResolvedValueOnce([{ id: 2, url: "https://next-tab.com" }]); // after close

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      expect(tracker.getActiveTabId()).toBe(1);

      // Close the active tab
      mockTabs.onRemoved._fire(1);
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));

      expect(tracker.getActiveTabUrl()).toBe("https://next-tab.com");
      expect(cb).toHaveBeenCalledWith(2, "https://next-tab.com");
    });

    it("handles closing the last tab in the window", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://only-tab.com" }]) // init
        .mockResolvedValueOnce([]); // no tabs after close

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onRemoved._fire(1);
      await new Promise((r) => setTimeout(r, 20));

      expect(tracker.getActiveTabId()).toBeNull();
      expect(tracker.getActiveTabUrl()).toBeNull();
    });

    it("does not react when a non-active tab is closed", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://active.com" }]);

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Close a different tab
      mockTabs.onRemoved._fire(99);
      await new Promise((r) => setTimeout(r, 20));

      expect(cb).not.toHaveBeenCalled();
      expect(tracker.getActiveTabId()).toBe(1);
    });

    it("recovers correctly after multiple tab closures in sequence", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://tab-1.com" }]) // init
        .mockResolvedValueOnce([{ id: 2, url: "https://tab-2.com" }]) // after first close
        .mockResolvedValueOnce([{ id: 3, url: "https://tab-3.com" }]); // after second close

      const tracker = await createTracker();
      const changes: Array<{ tabId: number; url: string }> = [];
      tracker.onActiveTabChanged((tabId, url) => changes.push({ tabId, url }));

      // Close tab 1 → recovers to tab 2
      mockTabs.onRemoved._fire(1);
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));

      // Close tab 2 → recovers to tab 3
      mockTabs.onRemoved._fire(2);
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(3));

      expect(changes).toEqual([
        { tabId: 2, url: "https://tab-2.com" },
        { tabId: 3, url: "https://tab-3.com" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Combined end-to-end flow
  // Validates: Requirements 12.1, 12.2, 12.4, 12.5, 12.6
  // -------------------------------------------------------------------------

  describe("combined end-to-end flow", () => {
    it("handles a full session: init → switch → navigate → close → recover", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://start.com/page" }]) // init
        .mockResolvedValueOnce([{ id: 3, url: "https://recovered.com" }]); // after tab 2 close

      mockTabs.get.mockImplementation((tabId: number) => {
        const urls: Record<number, string> = {
          2: "https://second-tab.com",
          3: "https://recovered.com",
        };
        return Promise.resolve({ id: tabId, url: urls[tabId] ?? "" });
      });

      const tracker = await createTracker();
      const events: Array<{ tabId: number; url: string }> = [];
      tracker.onActiveTabChanged((tabId, url) => events.push({ tabId, url }));

      // Step 1: Initial state
      expect(tracker.getActiveTabId()).toBe(1);
      expect(tracker.getActiveTabUrl()).toBe("https://start.com/page");

      // Step 2: Switch to tab 2 (in sidebar's window)
      mockTabs.onActivated._fire({ tabId: 2, windowId: SIDEBAR_WINDOW });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));
      expect(events[0]).toEqual({ tabId: 2, url: "https://second-tab.com" });

      // Step 3: Tab 2 navigates to a new URL
      mockTabs.onUpdated._fire(
        2,
        { status: "complete" },
        { id: 2, url: "https://second-tab.com/new-page", windowId: SIDEBAR_WINDOW },
      );
      expect(events[1]).toEqual({ tabId: 2, url: "https://second-tab.com/new-page" });

      // Step 4: Fragment-only change — no notification
      mockTabs.onUpdated._fire(
        2,
        { status: "complete" },
        { id: 2, url: "https://second-tab.com/new-page#section", windowId: SIDEBAR_WINDOW },
      );
      expect(events).toHaveLength(2); // No new event

      // Step 5: Ignore event from another window
      mockTabs.onActivated._fire({ tabId: 50, windowId: OTHER_WINDOW });
      await new Promise((r) => setTimeout(r, 10));
      expect(events).toHaveLength(2); // Still no new event
      expect(tracker.getActiveTabId()).toBe(2); // Unchanged

      // Step 6: Active tab is closed → recovery
      mockTabs.onRemoved._fire(2);
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(3));
      expect(events[2]).toEqual({ tabId: 3, url: "https://recovered.com" });

      // Final state
      expect(tracker.getActiveTabId()).toBe(3);
      expect(tracker.getActiveTabUrl()).toBe("https://recovered.com");
      expect(events).toHaveLength(3);
    });

    it("destroy stops all tracking and cleans up listeners", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      mockTabs.get.mockResolvedValue({ id: 2, url: "https://new.com" });

      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      // Destroy the tracker
      tracker.destroy();

      // Verify listeners are removed
      expect(mockTabs.onActivated._listeners).toHaveLength(0);
      expect(mockTabs.onUpdated._listeners).toHaveLength(0);
      expect(mockTabs.onRemoved._listeners).toHaveLength(0);

      // State is still readable but frozen
      expect(tracker.getActiveTabId()).toBe(1);
    });
  });
});
