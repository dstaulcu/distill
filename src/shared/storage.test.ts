/**
 * Unit tests for the browser.storage adapters (CF-5.1 plumbing).
 *
 * Uses a global browser mock (same pattern as content/main.test.ts) since
 * the adapters are thin wrappers over browser.storage areas.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Storage } from "webextension-polyfill";

interface MockArea {
  data: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  failNextSetWith?: Error;
}

function makeArea(): MockArea {
  const area: MockArea = {
    data: new Map<string, unknown>(),
    get: vi.fn(async (key: string) => ({ [key]: area.data.get(key) })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      if (area.failNextSetWith) {
        const err = area.failNextSetWith;
        area.failNextSetWith = undefined;
        throw err;
      }
      for (const [k, v] of Object.entries(items)) {
        area.data.set(k, v);
      }
    }),
    remove: vi.fn(async (key: string) => {
      area.data.delete(key);
    }),
  };
  return area;
}

let localArea: MockArea;
let syncArea: MockArea;
let changeListeners: Array<(changes: Record<string, Storage.StorageChange>, areaName: string) => void>;

beforeEach(() => {
  vi.resetModules();
  localArea = makeArea();
  syncArea = makeArea();
  changeListeners = [];

  Object.defineProperty(globalThis, "browser", {
    value: {
      storage: {
        local: localArea,
        sync: syncArea,
        onChanged: {
          addListener: vi.fn((cb: (typeof changeListeners)[number]) => changeListeners.push(cb)),
          removeListener: vi.fn((cb: (typeof changeListeners)[number]) => {
            const idx = changeListeners.indexOf(cb);
            if (idx >= 0) changeListeners.splice(idx, 1);
          }),
        },
      },
    },
    writable: true,
    configurable: true,
  });
});

async function loadAdapters() {
  return import("./storage");
}

describe("storage adapters", () => {
  it("round-trips values through get/set/remove", async () => {
    const { createLocalStorageAdapter } = await loadAdapters();
    const adapter = createLocalStorageAdapter();

    const setResult = await adapter.set("key", { a: 1 });
    expect(setResult).toEqual({ ok: true });
    expect(await adapter.get("key")).toEqual({ a: 1 });

    await adapter.remove("key");
    expect(await adapter.get("key")).toBeUndefined();
  });

  it("routes sync and local adapters to their respective areas", async () => {
    const { createLocalStorageAdapter, createSyncStorageAdapter } = await loadAdapters();

    await createLocalStorageAdapter().set("k", "local-value");
    await createSyncStorageAdapter().set("k", "sync-value");

    expect(localArea.data.get("k")).toBe("local-value");
    expect(syncArea.data.get("k")).toBe("sync-value");
  });

  it("maps quota errors to reason quota-exceeded", async () => {
    const { createSyncStorageAdapter } = await loadAdapters();
    syncArea.failNextSetWith = new Error("QUOTA_BYTES quota exceeded");

    const result = await createSyncStorageAdapter().set("k", "v");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("quota-exceeded");
    }
  });

  it("maps other failures to reason storage-error", async () => {
    const { createLocalStorageAdapter } = await loadAdapters();
    localArea.failNextSetWith = new Error("Backend unavailable");

    const result = await createLocalStorageAdapter().set("k", "v");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("storage-error");
      expect(result.detail).toContain("Backend unavailable");
    }
  });

  it("subscribe fires for the matching key and unsubscribes cleanly", async () => {
    const { createLocalStorageAdapter } = await loadAdapters();
    const adapter = createLocalStorageAdapter();
    const seen: unknown[] = [];

    const unsubscribe = adapter.subscribe<string>("watched", (v) => seen.push(v));
    for (const cb of changeListeners) {
      cb({ watched: { newValue: "hello" } }, "local");
      cb({ other: { newValue: "ignored" } }, "local");
    }
    expect(seen).toEqual(["hello"]);

    unsubscribe();
    expect(changeListeners).toHaveLength(0);
  });
});
