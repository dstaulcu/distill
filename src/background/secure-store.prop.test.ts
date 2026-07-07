import { describe, it, expect } from "vitest";
import fc from "fast-check";
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

// ---------------------------------------------------------------------------
// Property 18: SecureStore encryption round-trip
// Validates: Requirements 8.2
// ---------------------------------------------------------------------------

describe("Property 18: SecureStore encryption round-trip", () => {
  it("setSecret → getSecret returns the original value for any string", async () => {
    /**
     * **Validates: Requirements 8.2**
     */
    await fc.assert(
      fc.asyncProperty(fc.fullUnicodeString(), async (plaintext) => {
        const storage = createMockStorage();
        const store = createSecureStore({
          storage,
          crypto: globalThis.crypto.subtle,
        });

        await store.setSecret("test-ref", plaintext);
        const result = await store.getSecret("test-ref");

        expect(result).toBe(plaintext);
      }),
      { numRuns: 100 },
    );
  });

  it("stored ciphertext differs from plaintext for non-empty strings", async () => {
    /**
     * **Validates: Requirements 8.2**
     */
    await fc.assert(
      fc.asyncProperty(
        fc.fullUnicodeString({ minLength: 1 }),
        async (plaintext) => {
          const storage = createMockStorage();
          const store = createSecureStore({
            storage,
            crypto: globalThis.crypto.subtle,
          });

          await store.setSecret("test-ref", plaintext);

          const entry = storage.data.get("secure:test-ref") as {
            ct: string;
            iv: string;
            key: string;
          };

          // The base64-encoded ciphertext should not equal the plaintext
          expect(entry.ct).not.toBe(plaintext);

          // Decoding the base64 ciphertext should not yield the plaintext
          const decoded = atob(entry.ct);
          expect(decoded).not.toBe(plaintext);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("different IVs are used for different secrets (ciphertext differs for same plaintext)", async () => {
    /**
     * **Validates: Requirements 8.2**
     */
    await fc.assert(
      fc.asyncProperty(
        fc.fullUnicodeString({ minLength: 1 }),
        async (plaintext) => {
          const storage = createMockStorage();
          const store = createSecureStore({
            storage,
            crypto: globalThis.crypto.subtle,
          });

          await store.setSecret("ref-a", plaintext);
          await store.setSecret("ref-b", plaintext);

          const entryA = storage.data.get("secure:ref-a") as {
            ct: string;
            iv: string;
          };
          const entryB = storage.data.get("secure:ref-b") as {
            ct: string;
            iv: string;
          };

          // Different IVs should be generated for each call
          expect(entryA.iv).not.toBe(entryB.iv);

          // Different IVs produce different ciphertexts
          expect(entryA.ct).not.toBe(entryB.ct);
        },
      ),
      { numRuns: 100 },
    );
  });
});
