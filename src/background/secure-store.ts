/**
 * SecureStore — AES-GCM encrypted storage for sensitive values (API keys).
 *
 * Stores encrypted data in browser.storage.local via a StorageAdapter.
 * Only opaque references are exposed to the settings object; actual secrets
 * live in a separate encrypted area keyed by the reference.
 *
 * All external dependencies (storage, crypto, ID generation) are injectable
 * for testability.
 */

import type { StorageAdapter } from "@shared/storage";
import { createLocalStorageAdapter } from "@shared/storage";

// ---------------------------------------------------------------------------
// Public Interface
// ---------------------------------------------------------------------------

export interface SecureStore {
  /** Encrypt and persist a secret under the given reference. */
  setSecret(ref: string, value: string): Promise<void>;
  /** Retrieve and decrypt a secret by reference. Returns null if not found. */
  getSecret(ref: string): Promise<string | null>;
  /** Remove a secret by reference. */
  deleteSecret(ref: string): Promise<void>;
  /** Generate a new opaque reference string. */
  createRef(): string;
}

export interface CreateSecureStoreOptions {
  readonly storage?: StorageAdapter;
  readonly crypto?: SubtleCrypto;
  readonly generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/** Shape of the encrypted payload persisted to storage. */
interface EncryptedEntry {
  /** Base64-encoded ciphertext. */
  readonly ct: string;
  /** Base64-encoded initialization vector. */
  readonly iv: string;
  /** Base64-encoded AES-GCM key (exported raw). */
  readonly key: string;
}

// ---------------------------------------------------------------------------
// Storage key prefix — isolates secrets from other storage entries.
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "secure:";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSecureStore(opts?: CreateSecureStoreOptions): SecureStore {
  const storage = opts?.storage ?? getDefaultStorage();
  const crypto = opts?.crypto ?? getDefaultCrypto();
  const generateId = opts?.generateId ?? defaultGenerateId;

  return {
    async setSecret(ref: string, value: string): Promise<void> {
      const encoded = new TextEncoder().encode(value);

      // Generate a fresh AES-GCM key for each secret.
      const key = await crypto.generateKey(
        { name: "AES-GCM", length: 256 },
        true, // extractable so we can persist it
        ["encrypt", "decrypt"],
      );

      // Random 12-byte IV (recommended for AES-GCM).
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

      const ciphertext = await crypto.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoded,
      );

      // Export the raw key bytes for storage.
      const rawKey = await crypto.exportKey("raw", key);

      const entry: EncryptedEntry = {
        ct: bufferToBase64(ciphertext),
        iv: bufferToBase64(iv),
        key: bufferToBase64(rawKey),
      };

      await storage.set(STORAGE_PREFIX + ref, entry);
    },

    async getSecret(ref: string): Promise<string | null> {
      const entry = await storage.get<EncryptedEntry>(STORAGE_PREFIX + ref);
      if (!entry) return null;

      const rawKey = base64ToBuffer(entry.key);
      const iv = base64ToBuffer(entry.iv);
      const ct = base64ToBuffer(entry.ct);

      const key = await crypto.importKey(
        "raw",
        rawKey,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );

      const plainBuffer = await crypto.decrypt(
        { name: "AES-GCM", iv },
        key,
        ct,
      );

      return new TextDecoder().decode(plainBuffer);
    },

    async deleteSecret(ref: string): Promise<void> {
      await storage.remove(STORAGE_PREFIX + ref);
    },

    createRef(): string {
      return generateId();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  // Explicit ArrayBuffer backing so the result satisfies BufferSource under strict TS libs
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Default implementations (production)
// ---------------------------------------------------------------------------

function getDefaultCrypto(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function getDefaultStorage(): StorageAdapter {
  return createLocalStorageAdapter();
}

function defaultGenerateId(): string {
  // Produce a URL-safe random ID (16 bytes → 22 base64url chars).
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return bufferToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
