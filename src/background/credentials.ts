/**
 * API key credential flow (CF-5.3).
 *
 * The settings object only ever holds an opaque `apiKeyRef`; the key material
 * itself lives in the SecureStore. Saving a key stores it under the existing
 * ref (or a fresh one) and records the ref via the settings manager. Resolution
 * prefers an explicit override (a key typed into a form) over the stored key,
 * and returns null when no key exists so keyless endpoints keep working.
 */

import type { Settings } from "@shared/types";
import type { SecureStore } from "./secure-store";
import type { PartialSettings, SettingsUpdateResult } from "./settings/manager";

export type ApiKeySaveResult =
  | { readonly ok: true; readonly ref: string }
  | { readonly ok: false; readonly reason: "empty-key" | "settings-update-failed"; readonly detail: string };

export interface CreateApiKeySaverOptions {
  readonly getSettings: () => Promise<Settings>;
  readonly updateSettings: (patch: PartialSettings) => Promise<SettingsUpdateResult>;
  readonly secureStore: SecureStore;
}

export function createApiKeySaver(opts: CreateApiKeySaverOptions) {
  const { getSettings, updateSettings, secureStore } = opts;

  return async function saveApiKey(apiKey: string): Promise<ApiKeySaveResult> {
    const trimmed = apiKey.trim();
    if (trimmed === "") {
      return { ok: false, reason: "empty-key", detail: "API key must not be empty" };
    }

    const settings = await getSettings();
    const existingRef = settings.ai.apiKeyRef;
    const ref = existingRef ?? secureStore.createRef();

    await secureStore.setSecret(ref, trimmed);

    if (existingRef !== ref) {
      const updateResult = await updateSettings({ ai: { apiKeyRef: ref } });
      if (!updateResult.ok) {
        // Roll back the orphaned secret so we don't leak unreferenced entries
        await secureStore.deleteSecret(ref);
        return {
          ok: false,
          reason: "settings-update-failed",
          detail: updateResult.errors.map((e) => e.message).join("; "),
        };
      }
    }

    return { ok: true, ref };
  };
}

export interface ResolveApiKeyOptions {
  readonly settings: Settings;
  readonly secureStore: SecureStore;
  /** A key provided directly (e.g. typed into the options form); wins over the stored key. */
  readonly override?: string;
}

/**
 * Resolves the effective API key: explicit override → stored secret → null.
 */
export async function resolveApiKey(opts: ResolveApiKeyOptions): Promise<string | null> {
  const override = opts.override?.trim();
  if (override) {
    return override;
  }
  const ref = opts.settings.ai.apiKeyRef;
  if (!ref) {
    return null;
  }
  return opts.secureStore.getSecret(ref);
}
