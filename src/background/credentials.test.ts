/**
 * Unit tests for the API key credential flow.
 *
 * CF-5.3: entering a key in options must make subsequent AI requests
 * authenticate with it; empty key keeps keyless endpoints working.
 */

import { describe, it, expect, vi } from "vitest";
import { createApiKeySaver, resolveApiKey } from "./credentials";
import type { SecureStore } from "./secure-store";
import type { Settings } from "@shared/types";

function makeSettings(overrides?: Partial<Settings["ai"]>): Settings {
  return {
    schemaVersion: 1,
    ai: { baseUrl: "http://localhost:11434", modelId: "llama3", apiKeyRef: null, systemPrompt: "", ...overrides },
    export: { filenamePattern: "YYYY-MM-DD-slugified-title", defaultDestination: { kind: "download" }, frontmatterFields: ["title"] },
    sitePatterns: [],
    autoExportConfigs: [],
  };
}

function makeSecureStore(): SecureStore & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  let counter = 0;
  return {
    secrets,
    async setSecret(ref: string, value: string) {
      secrets.set(ref, value);
    },
    async getSecret(ref: string) {
      return secrets.get(ref) ?? null;
    },
    async deleteSecret(ref: string) {
      secrets.delete(ref);
    },
    createRef() {
      counter++;
      return `ref-${counter}`;
    },
  };
}

describe("CF-5.3 API key storage (createApiKeySaver)", () => {
  it("stores the key under a new ref and records the ref in settings", async () => {
    const secureStore = makeSecureStore();
    const settings = makeSettings();
    const updateSettings = vi.fn(async () => ({ ok: true as const, settings }));

    const save = createApiKeySaver({
      getSettings: async () => settings,
      updateSettings,
      secureStore,
    });

    const result = await save("sk-test-123");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(secureStore.secrets.get(result.ref)).toBe("sk-test-123");
    }
    expect(updateSettings).toHaveBeenCalledWith({ ai: { apiKeyRef: "ref-1" } });
  });

  it("reuses the existing ref when one is already recorded", async () => {
    const secureStore = makeSecureStore();
    const settings = makeSettings({ apiKeyRef: "existing-ref" });
    const updateSettings = vi.fn(async () => ({ ok: true as const, settings }));

    const save = createApiKeySaver({
      getSettings: async () => settings,
      updateSettings,
      secureStore,
    });

    const result = await save("sk-updated");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref).toBe("existing-ref");
    }
    expect(secureStore.secrets.get("existing-ref")).toBe("sk-updated");
    // Ref unchanged — no settings update needed
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty key without storing anything", async () => {
    const secureStore = makeSecureStore();
    const updateSettings = vi.fn(async () => ({ ok: true as const, settings: makeSettings() }));

    const save = createApiKeySaver({
      getSettings: async () => makeSettings(),
      updateSettings,
      secureStore,
    });

    const result = await save("   ");

    expect(result.ok).toBe(false);
    expect(secureStore.secrets.size).toBe(0);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("round-trips: a saved key is retrievable via the recorded ref", async () => {
    const secureStore = makeSecureStore();
    let settings = makeSettings();
    const save = createApiKeySaver({
      getSettings: async () => settings,
      updateSettings: async (patch) => {
        settings = { ...settings, ai: { ...settings.ai, ...patch.ai } };
        return { ok: true as const, settings };
      },
      secureStore,
    });

    const result = await save("sk-round-trip");
    expect(result.ok).toBe(true);

    const resolved = await resolveApiKey({ settings, secureStore });
    expect(resolved).toBe("sk-round-trip");
  });
});

describe("CF-5.3 API key resolution (resolveApiKey)", () => {
  it("prefers an explicit override key", async () => {
    const secureStore = makeSecureStore();
    secureStore.secrets.set("stored-ref", "sk-stored");
    const settings = makeSettings({ apiKeyRef: "stored-ref" });

    const resolved = await resolveApiKey({ settings, secureStore, override: "sk-typed-in-form" });
    expect(resolved).toBe("sk-typed-in-form");
  });

  it("falls back to the stored key when no override is given", async () => {
    const secureStore = makeSecureStore();
    secureStore.secrets.set("stored-ref", "sk-stored");
    const settings = makeSettings({ apiKeyRef: "stored-ref" });

    const resolved = await resolveApiKey({ settings, secureStore });
    expect(resolved).toBe("sk-stored");
  });

  it("returns null when no key exists anywhere (keyless endpoints keep working)", async () => {
    const secureStore = makeSecureStore();
    const settings = makeSettings();

    const resolved = await resolveApiKey({ settings, secureStore });
    expect(resolved).toBeNull();
  });

  it("returns null when the ref points at a missing secret", async () => {
    const secureStore = makeSecureStore();
    const settings = makeSettings({ apiKeyRef: "dangling-ref" });

    const resolved = await resolveApiKey({ settings, secureStore });
    expect(resolved).toBeNull();
  });
});
