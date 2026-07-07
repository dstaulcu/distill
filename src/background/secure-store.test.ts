import { describe, it, expect, vi } from "vitest";
import { createSecureStore } from "./secure-store";
import type { StorageAdapter, StorageSetResult } from "@shared/storage";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** In-memory storage adapter for testing. */
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

/** Counter-based ID generator for deterministic tests. */
function createMockIdGenerator() {
  let counter = 0;
  return () => `ref-${++counter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-5.3 SecureStore", () => {
  describe("createRef", () => {
    it("returns a unique reference string each call", () => {
      const store = createSecureStore({
        storage: createMockStorage(),
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      const ref1 = store.createRef();
      const ref2 = store.createRef();

      expect(ref1).toBe("ref-1");
      expect(ref2).toBe("ref-2");
      expect(ref1).not.toBe(ref2);
    });

    it("uses the default ID generator when none is provided", () => {
      const store = createSecureStore({
        storage: createMockStorage(),
        crypto: globalThis.crypto.subtle,
      });

      const ref = store.createRef();
      // Default generator produces a non-empty string
      expect(ref.length).toBeGreaterThan(0);
    });
  });

  describe("setSecret / getSecret round-trip", () => {
    it("encrypts and decrypts a simple string", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("my-ref", "sk-abc123");
      const result = await store.getSecret("my-ref");

      expect(result).toBe("sk-abc123");
    });

    it("encrypts and decrypts an empty string", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("empty-ref", "");
      const result = await store.getSecret("empty-ref");

      expect(result).toBe("");
    });

    it("encrypts and decrypts a string with special characters", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      const secret = "p@$$w0rd!#%^&*()_+{}|:<>?~`-=[]\\;',./\n\ttabs and newlines 🔑";
      await store.setSecret("special-ref", secret);
      const result = await store.getSecret("special-ref");

      expect(result).toBe(secret);
    });

    it("encrypts and decrypts a long string", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      const secret = "x".repeat(10_000);
      await store.setSecret("long-ref", secret);
      const result = await store.getSecret("long-ref");

      expect(result).toBe(secret);
    });

    it("stores ciphertext that differs from plaintext", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      const secret = "my-api-key-12345";
      await store.setSecret("ct-ref", secret);

      // The stored entry should not contain the plaintext
      const entry = storage.data.get("secure:ct-ref") as { ct: string; iv: string; key: string };
      expect(entry).toBeDefined();
      expect(entry.ct).not.toContain(secret);
      // The base64-encoded ciphertext should not decode to the plaintext
      expect(atob(entry.ct)).not.toBe(secret);
    });

    it("produces different ciphertext for the same plaintext (unique IV per call)", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("ref-a", "same-secret");
      await store.setSecret("ref-b", "same-secret");

      const entryA = storage.data.get("secure:ref-a") as { ct: string; iv: string };
      const entryB = storage.data.get("secure:ref-b") as { ct: string; iv: string };

      // Different IVs should produce different ciphertexts
      expect(entryA.iv).not.toBe(entryB.iv);
      expect(entryA.ct).not.toBe(entryB.ct);
    });
  });

  describe("getSecret", () => {
    it("returns null for a non-existent reference", async () => {
      const store = createSecureStore({
        storage: createMockStorage(),
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      const result = await store.getSecret("does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("deleteSecret", () => {
    it("removes a stored secret", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("del-ref", "to-be-deleted");
      expect(await store.getSecret("del-ref")).toBe("to-be-deleted");

      await store.deleteSecret("del-ref");
      expect(await store.getSecret("del-ref")).toBeNull();
    });

    it("does not throw when deleting a non-existent reference", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      // Should not throw
      await expect(store.deleteSecret("no-such-ref")).resolves.toBeUndefined();
    });
  });

  describe("storage isolation", () => {
    it("stores entries with a 'secure:' prefix", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("api-key", "secret-value");

      // The key in storage should be prefixed
      expect(storage.data.has("secure:api-key")).toBe(true);
      expect(storage.data.has("api-key")).toBe(false);
    });
  });

  describe("dependency injection", () => {
    it("uses the injected storage adapter", async () => {
      const storage = createMockStorage();
      const setSpy = vi.spyOn(storage, "set");

      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("injected-ref", "value");
      expect(setSpy).toHaveBeenCalledWith("secure:injected-ref", expect.any(Object));
    });

    it("uses the injected generateId function", () => {
      const customId = () => "custom-id-42";
      const store = createSecureStore({
        storage: createMockStorage(),
        crypto: globalThis.crypto.subtle,
        generateId: customId,
      });

      expect(store.createRef()).toBe("custom-id-42");
      expect(store.createRef()).toBe("custom-id-42");
    });

    it("uses the injected crypto implementation", async () => {
      const storage = createMockStorage();
      const mockCrypto = globalThis.crypto.subtle;
      const generateKeySpy = vi.spyOn(mockCrypto, "generateKey");

      const store = createSecureStore({
        storage,
        crypto: mockCrypto,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("crypto-ref", "test");
      expect(generateKeySpy).toHaveBeenCalledWith(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );

      generateKeySpy.mockRestore();
    });
  });

  describe("encrypted entry structure", () => {
    it("stores an object with ct, iv, and key fields", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("struct-ref", "hello");

      const entry = storage.data.get("secure:struct-ref") as Record<string, unknown>;
      expect(entry).toHaveProperty("ct");
      expect(entry).toHaveProperty("iv");
      expect(entry).toHaveProperty("key");
      expect(typeof entry.ct).toBe("string");
      expect(typeof entry.iv).toBe("string");
      expect(typeof entry.key).toBe("string");
    });

    it("stores a 12-byte IV (16 base64 chars)", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("iv-ref", "test");

      const entry = storage.data.get("secure:iv-ref") as { iv: string };
      // 12 bytes → 16 base64 characters (with padding)
      const ivBytes = atob(entry.iv);
      expect(ivBytes.length).toBe(12);
    });

    it("stores a 256-bit (32-byte) key", async () => {
      const storage = createMockStorage();
      const store = createSecureStore({
        storage,
        crypto: globalThis.crypto.subtle,
        generateId: createMockIdGenerator(),
      });

      await store.setSecret("key-ref", "test");

      const entry = storage.data.get("secure:key-ref") as { key: string };
      const keyBytes = atob(entry.key);
      expect(keyBytes.length).toBe(32);
    });
  });
});
