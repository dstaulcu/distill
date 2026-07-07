import { describe, it, expect, vi, beforeEach } from "vitest";
import { createActiveTabTracker } from "./active-tab-tracker";
import type { ActiveTabTracker, CreateActiveTabTrackerOptions } from "./active-tab-tracker";

// ---------------------------------------------------------------------------
// Mock helpers
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
// Tests
// ---------------------------------------------------------------------------

describe("ActiveTabTracker", () => {
  let mockTabs: MockTabs;
  let mockWindows: MockWindows;
  const WINDOW_ID = 100;

  beforeEach(() => {
    mockTabs = createMockTabs();
    mockWindows = createMockWindows(WINDOW_ID);
  });

  async function createTracker(): Promise<ActiveTabTracker> {
    return createActiveTabTracker({
      tabs: mockTabs as unknown as typeof browser.tabs,
      windows: mockWindows as unknown as typeof browser.windows,
    });
  }

  describe("initialization", () => {
    it("queries the current window on init", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      await createTracker();

      expect(mockWindows.getCurrent).toHaveBeenCalled();
    });

    it("queries active tab in the current window on init", async () => {
      mockTabs.query.mockResolvedValue([{ id: 5, url: "https://example.com/page" }]);
      await createTracker();

      expect(mockTabs.query).toHaveBeenCalledWith({ active: true, windowId: WINDOW_ID });
    });

    it("sets the initial active tab from query result", async () => {
      mockTabs.query.mockResolvedValue([{ id: 7, url: "https://test.com/article" }]);
      const tracker = await createTracker();

      expect(tracker.getActiveTabId()).toBe(7);
      expect(tracker.getActiveTabUrl()).toBe("https://test.com/article");
    });

    it("returns null when no active tab is found", async () => {
      mockTabs.query.mockResolvedValue([]);
      const tracker = await createTracker();

      expect(tracker.getActiveTabId()).toBeNull();
      expect(tracker.getActiveTabUrl()).toBeNull();
    });

    it("registers all event listeners", async () => {
      mockTabs.query.mockResolvedValue([]);
      await createTracker();

      expect(mockTabs.onActivated.addListener).toHaveBeenCalledTimes(1);
      expect(mockTabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
      expect(mockTabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("onActivated", () => {
    it("updates tracked tab when event is for the sidebar's window", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://initial.com" }]);
      mockTabs.get.mockResolvedValue({ id: 2, url: "https://new-tab.com" });
      const tracker = await createTracker();

      mockTabs.onActivated._fire({ tabId: 2, windowId: WINDOW_ID });
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));

      expect(tracker.getActiveTabUrl()).toBe("https://new-tab.com");
    });

    it("ignores activation events from other windows", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://initial.com" }]);
      const tracker = await createTracker();

      mockTabs.onActivated._fire({ tabId: 99, windowId: 999 });
      // Give async operations time to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(tracker.getActiveTabId()).toBe(1);
    });

    it("notifies listeners on tab activation in same window", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://initial.com" }]);
      mockTabs.get.mockResolvedValue({ id: 3, url: "https://switched.com" });
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onActivated._fire({ tabId: 3, windowId: WINDOW_ID });
      await vi.waitFor(() => expect(cb).toHaveBeenCalled());

      expect(cb).toHaveBeenCalledWith(3, "https://switched.com");
    });

    it("does not notify listeners for events from other windows", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://initial.com" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onActivated._fire({ tabId: 5, windowId: 999 });
      await new Promise((r) => setTimeout(r, 10));

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("onUpdated", () => {
    it("triggers change when tracked tab navigates to a different URL", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/page1" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://example.com/page2", windowId: WINDOW_ID },
      );

      expect(cb).toHaveBeenCalledWith(1, "https://example.com/page2");
    });

    it("does not trigger change for fragment-only navigation", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/page#section1" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://example.com/page#section2", windowId: WINDOW_ID },
      );

      expect(cb).not.toHaveBeenCalled();
    });

    it("ignores updates for non-tracked tabs", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        99,
        { status: "complete" },
        { id: 99, url: "https://other.com", windowId: WINDOW_ID },
      );

      expect(cb).not.toHaveBeenCalled();
      expect(tracker.getActiveTabId()).toBe(1);
    });

    it("ignores updates with status other than 'complete'", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/page1" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "loading" },
        { id: 1, url: "https://example.com/page2", windowId: WINDOW_ID },
      );

      expect(cb).not.toHaveBeenCalled();
    });

    it("triggers change when origin changes", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/page" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://different.com/page", windowId: WINDOW_ID },
      );

      expect(cb).toHaveBeenCalledWith(1, "https://different.com/page");
    });

    it("triggers change when query string changes", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/search?q=foo" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://example.com/search?q=bar", windowId: WINDOW_ID },
      );

      expect(cb).toHaveBeenCalledWith(1, "https://example.com/search?q=bar");
    });

    it("updates stored URL after navigation", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/old" }]);
      const tracker = await createTracker();

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://example.com/new", windowId: WINDOW_ID },
      );

      expect(tracker.getActiveTabUrl()).toBe("https://example.com/new");
    });
  });

  describe("onRemoved", () => {
    it("re-queries active tab when tracked tab is closed", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://example.com" }]) // init
        .mockResolvedValueOnce([{ id: 2, url: "https://fallback.com" }]); // after removal
      const tracker = await createTracker();

      mockTabs.onRemoved._fire(1);
      await vi.waitFor(() => expect(tracker.getActiveTabId()).toBe(2));

      expect(tracker.getActiveTabUrl()).toBe("https://fallback.com");
    });

    it("notifies listeners with the new active tab after removal", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://example.com" }])
        .mockResolvedValueOnce([{ id: 3, url: "https://next.com" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onRemoved._fire(1);
      await vi.waitFor(() => expect(cb).toHaveBeenCalled());

      expect(cb).toHaveBeenCalledWith(3, "https://next.com");
    });

    it("ignores removal of non-tracked tabs", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      mockTabs.onRemoved._fire(99);
      await new Promise((r) => setTimeout(r, 10));

      expect(cb).not.toHaveBeenCalled();
      expect(tracker.getActiveTabId()).toBe(1);
    });

    it("sets null state when no active tab remains after removal", async () => {
      mockTabs.query
        .mockResolvedValueOnce([{ id: 1, url: "https://example.com" }])
        .mockResolvedValueOnce([]); // no tabs left
      const tracker = await createTracker();

      mockTabs.onRemoved._fire(1);
      await new Promise((r) => setTimeout(r, 10));

      // After removal with no replacement, state should be null
      expect(tracker.getActiveTabId()).toBeNull();
      expect(tracker.getActiveTabUrl()).toBeNull();
    });
  });

  describe("onActiveTabChanged", () => {
    it("returns an unsubscribe function", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      mockTabs.get.mockResolvedValue({ id: 2, url: "https://new.com" });
      const tracker = await createTracker();
      const cb = vi.fn();
      const unsub = tracker.onActiveTabChanged(cb);

      unsub();

      mockTabs.onActivated._fire({ tabId: 2, windowId: WINDOW_ID });
      await new Promise((r) => setTimeout(r, 10));

      expect(cb).not.toHaveBeenCalled();
    });

    it("supports multiple listeners", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/old" }]);
      const tracker = await createTracker();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      tracker.onActiveTabChanged(cb1);
      tracker.onActiveTabChanged(cb2);

      mockTabs.onUpdated._fire(
        1,
        { status: "complete" },
        { id: 1, url: "https://example.com/new", windowId: WINDOW_ID },
      );

      expect(cb1).toHaveBeenCalledWith(1, "https://example.com/new");
      expect(cb2).toHaveBeenCalledWith(1, "https://example.com/new");
    });
  });

  describe("destroy", () => {
    it("removes all event listeners", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      const tracker = await createTracker();

      tracker.destroy();

      expect(mockTabs.onActivated.removeListener).toHaveBeenCalled();
      expect(mockTabs.onUpdated.removeListener).toHaveBeenCalled();
      expect(mockTabs.onRemoved.removeListener).toHaveBeenCalled();
    });

    it("stops notifying listeners after destroy", async () => {
      mockTabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/old" }]);
      const tracker = await createTracker();
      const cb = vi.fn();
      tracker.onActiveTabChanged(cb);

      tracker.destroy();

      // Manually fire (simulating if removeListener didn't work)
      // After destroy, the listeners set is cleared so even if called, nothing happens
      expect(mockTabs.onActivated._listeners).toHaveLength(0);
      expect(mockTabs.onUpdated._listeners).toHaveLength(0);
      expect(mockTabs.onRemoved._listeners).toHaveLength(0);
    });
  });
});
