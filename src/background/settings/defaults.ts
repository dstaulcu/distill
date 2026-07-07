/**
 * Default settings for Distill v3.
 *
 * Applied on first install and used as the base when no persisted
 * settings exist in storage.
 */

import type { Settings } from "@shared/types";

// ---------------------------------------------------------------------------
// Default Settings
//
// Note: built-in site patterns are NOT seeded into settings. The canonical
// builtin list lives in @background/site-patterns/matcher (BUILTIN_PATTERNS)
// and is applied at match time, so settings only ever hold user patterns.
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  ai: {
    baseUrl: "",
    modelId: "",
    apiKeyRef: null,
    systemPrompt: "",
  },
  export: {
    filenamePattern: "YYYY-MM-DD-slugified-title",
    defaultDestination: { kind: "download" },
    frontmatterFields: ["title", "author", "source_url", "publication_date", "capture_date", "site_name"],
  },
  sitePatterns: [],
  autoExportConfigs: [],
};

// ---------------------------------------------------------------------------
// Storage Key
// ---------------------------------------------------------------------------

export const SETTINGS_STORAGE_KEY = "settings";
