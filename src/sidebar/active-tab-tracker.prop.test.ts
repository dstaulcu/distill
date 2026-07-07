import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createActiveTabTracker } from "./active-tab-tracker";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type ActivatedListener = (info: { tabId: number; windowId: number }) => void;

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
  };
  onRemoved: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
}

interface MockWindows {
  getCurrent: ReturnType<typeof vi.fn>;
}

function createMockTabs(sidebarWindowId: number): MockTabs {
  const activatedListeners: ActivatedListener[] = [];

  return {
    query: vi.fn().mockResolvedValue([{ id: 1, url: "https://initial.com" }]),
    get: vi.fn().mockImplementation((tabId: number) =>
      Promise.resolve({ id: tabId, url: `https://tab-${tabId}.com` }),
    ),
    onActivated: {
      addListener: vi.fn((fn: ActivatedListener) => activatedListeners.push(fn)),
      removeListener: vi.fn(),
      _listeners: activatedListeners,
      _fire(info: { tabId: number; windowId: number }) {
        for (const fn of [...activatedListeners]) fn(info);
      },
    },
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  };
}

function createMockWindows(windowId: number): MockWindows {
  return {
    getCurrent: vi.fn().mockResolvedValue({ id: windowId }),
  };
}

// ---------------------------------------------------------------------------
// Property 17: Active tab tracker window filtering
// Validates: Requirements 12.2, 12.6
// ---------------------------------------------------------------------------

describe("Property 17: Active tab tracker window filtering", () => {
  it("only activation events matching the sidebar's window update the tracked tab", async () => {
    /**
     * **Validates: Requirements 12.2, 12.6**
     *
     * Generate a random sidebar windowId and a set of activation events with
     * various windowIds. Verify that only events whose windowId matches the
     * sidebar's window actually update the tracked tab.
     */
    await fc.assert(
      fc.asyncProperty(
        // Sidebar's own window ID (positive integer)
        fc.integer({ min: 1, max: 10000 }),
        // An activation event with a random windowId and tabId
        fc.integer({ min: 1, max: 10000 }), // event tabId
        fc.integer({ min: 1, max: 10000 }), // event windowId
        async (sidebarWindowId, eventTabId, eventWindowId) => {
          const mockTabs = createMockTabs(sidebarWindowId);
          const mockWindows = createMockWindows(sidebarWindowId);

          const tracker = await createActiveTabTracker({
            tabs: mockTabs as unknown as typeof browser.tabs,
            windows: mockWindows as unknown as typeof browser.windows,
          });

          // Record the initial state
          const initialTabId = tracker.getActiveTabId();

          // Fire an activation event
          mockTabs.onActivated._fire({ tabId: eventTabId, windowId: eventWindowId });

          // Allow async operations to settle
          await new Promise((r) => setTimeout(r, 10));

          if (eventWindowId === sidebarWindowId) {
            // Matching window: tracker should update to the new tab
            expect(tracker.getActiveTabId()).toBe(eventTabId);
          } else {
            // Non-matching window: tracker should remain unchanged
            expect(tracker.getActiveTabId()).toBe(initialTabId);
          }

          tracker.destroy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("sequences of activation events with mixed windowIds only reflect matching events", async () => {
    /**
     * **Validates: Requirements 12.2, 12.6**
     *
     * Generate a sidebar windowId and a sequence of activation events with
     * a mix of matching and non-matching windowIds. After processing all
     * events, verify the tracker state reflects only the last matching event.
     */
    await fc.assert(
      fc.asyncProperty(
        // Sidebar's own window ID
        fc.integer({ min: 1, max: 10000 }),
        // Sequence of activation events: array of { tabId, windowId }
        fc.array(
          fc.record({
            tabId: fc.integer({ min: 1, max: 10000 }),
            windowId: fc.integer({ min: 1, max: 10000 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (sidebarWindowId, events) => {
          const mockTabs = createMockTabs(sidebarWindowId);
          const mockWindows = createMockWindows(sidebarWindowId);

          const tracker = await createActiveTabTracker({
            tabs: mockTabs as unknown as typeof browser.tabs,
            windows: mockWindows as unknown as typeof browser.windows,
          });

          // Track which events should have been processed (matching window)
          const matchingEvents = events.filter((e) => e.windowId === sidebarWindowId);

          // Fire all events in sequence, awaiting each to settle
          for (const event of events) {
            mockTabs.onActivated._fire({ tabId: event.tabId, windowId: event.windowId });
            // Allow the async tabs.get() call to resolve
            await Promise.resolve();
            await Promise.resolve();
          }

          // Allow final microtasks to settle
          await new Promise((r) => setTimeout(r, 10));

          if (matchingEvents.length > 0) {
            // The tracker should reflect the last matching event's tabId
            const lastMatching = matchingEvents[matchingEvents.length - 1];
            expect(tracker.getActiveTabId()).toBe(lastMatching.tabId);
          } else {
            // No matching events: tracker should still have the initial tab
            expect(tracker.getActiveTabId()).toBe(1); // initial from query mock
          }

          tracker.destroy();
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});
