import { describe, it, expect } from "vitest";
import { createTabStateManager } from "./tab-state";
import type { TabState, Conversation } from "@shared/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConversation(tabId: number, url: string, title: string): Conversation {
  return {
    tabId,
    url,
    title,
    messages: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makeTabState(overrides: Partial<TabState> = {}): TabState {
  return {
    url: "https://example.com/article",
    title: "Example Article",
    summary: null,
    conversation: makeConversation(1, "https://example.com/article", "Example Article"),
    extractionConfidence: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TabStateManager", () => {
  describe("get()", () => {
    it("returns undefined for a tab that has not been set", () => {
      const manager = createTabStateManager();
      expect(manager.get(42)).toBeUndefined();
    });

    it("returns the state previously set for a tab", () => {
      const manager = createTabStateManager();
      const state = makeTabState({ url: "https://test.com" });
      manager.set(1, state);

      expect(manager.get(1)).toEqual(state);
    });
  });

  describe("set()", () => {
    it("stores state for a new tab", () => {
      const manager = createTabStateManager();
      const state = makeTabState();
      manager.set(10, state);

      expect(manager.get(10)).toEqual(state);
    });

    it("overwrites existing state for the same tab", () => {
      const manager = createTabStateManager();
      const first = makeTabState({ title: "First" });
      const second = makeTabState({ title: "Second" });

      manager.set(1, first);
      manager.set(1, second);

      expect(manager.get(1)?.title).toBe("Second");
    });

    it("stores state independently for different tabs", () => {
      const manager = createTabStateManager();
      const stateA = makeTabState({ url: "https://a.com" });
      const stateB = makeTabState({ url: "https://b.com" });

      manager.set(1, stateA);
      manager.set(2, stateB);

      expect(manager.get(1)?.url).toBe("https://a.com");
      expect(manager.get(2)?.url).toBe("https://b.com");
    });
  });

  describe("update()", () => {
    it("returns undefined when the tab does not exist", () => {
      const manager = createTabStateManager();
      const result = manager.update(99, { title: "New Title" });

      expect(result).toBeUndefined();
    });

    it("merges a partial patch into existing state", () => {
      const manager = createTabStateManager();
      manager.set(1, makeTabState({ title: "Old", summary: null }));

      const updated = manager.update(1, { summary: "A summary" });

      expect(updated?.summary).toBe("A summary");
      expect(updated?.title).toBe("Old");
    });

    it("returns the updated state", () => {
      const manager = createTabStateManager();
      manager.set(1, makeTabState({ consecutiveFailures: 0 }));

      const updated = manager.update(1, { consecutiveFailures: 3 });

      expect(updated?.consecutiveFailures).toBe(3);
    });

    it("persists the updated state in the store", () => {
      const manager = createTabStateManager();
      manager.set(1, makeTabState({ extractionConfidence: null }));

      manager.update(1, { extractionConfidence: "high" });

      expect(manager.get(1)?.extractionConfidence).toBe("high");
    });

    it("can update multiple fields at once", () => {
      const manager = createTabStateManager();
      manager.set(1, makeTabState());

      const updated = manager.update(1, {
        url: "https://new.com",
        title: "New Title",
        extractionConfidence: "medium",
      });

      expect(updated?.url).toBe("https://new.com");
      expect(updated?.title).toBe("New Title");
      expect(updated?.extractionConfidence).toBe("medium");
    });
  });

  describe("remove()", () => {
    it("removes an existing tab state", () => {
      const manager = createTabStateManager();
      manager.set(1, makeTabState());

      manager.remove(1);

      expect(manager.get(1)).toBeUndefined();
      expect(manager.has(1)).toBe(false);
    });

    it("does nothing when removing a non-existent tab", () => {
      const manager = createTabStateManager();
      // Should not throw
      manager.remove(999);
      expect(manager.has(999)).toBe(false);
    });
  });

  describe("has()", () => {
    it("returns false for a tab that has not been set", () => {
      const manager = createTabStateManager();
      expect(manager.has(1)).toBe(false);
    });

    it("returns true for a tab that has been set", () => {
      const manager = createTabStateManager();
      manager.set(5, makeTabState());

      expect(manager.has(5)).toBe(true);
    });

    it("returns false after a tab has been removed", () => {
      const manager = createTabStateManager();
      manager.set(5, makeTabState());
      manager.remove(5);

      expect(manager.has(5)).toBe(false);
    });
  });
});
