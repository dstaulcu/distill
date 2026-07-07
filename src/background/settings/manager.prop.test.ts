import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { validateSettings } from "./manager";
import { DEFAULT_SETTINGS } from "./defaults";
import type { Settings, AutoExportConfig, SitePattern } from "@shared/types";

// ---------------------------------------------------------------------------
// Property 12: Settings validation rejects invalid values
// Validates: Requirements 8.7
// ---------------------------------------------------------------------------

describe("Property 12: Settings validation rejects invalid values", () => {
  it("rejects non-empty baseUrl that does not start with http:// or https://", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(
          (s) => !s.startsWith("http://") && !s.startsWith("https://"),
        ),
        (invalidUrl) => {
          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            ai: { ...DEFAULT_SETTINGS.ai, baseUrl: invalidUrl },
          };
          const errors = validateSettings(settings);
          const urlErrors = errors.filter((e) => e.field === "ai.baseUrl");
          expect(urlErrors.length).toBe(1);
          expect(urlErrors[0].message).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects empty or whitespace-only filenamePattern", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r", "\f")).chain((ws) =>
          fc.constant(ws),
        ),
        (whitespaceOnly) => {
          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            export: { ...DEFAULT_SETTINGS.export, filenamePattern: whitespaceOnly },
          };
          const errors = validateSettings(settings);
          const patternErrors = errors.filter((e) => e.field === "export.filenamePattern");
          expect(patternErrors.length).toBe(1);
          expect(patternErrors[0].message).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects more than 50 user-defined site patterns", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 51, max: 200 }),
        (count) => {
          const userPatterns: SitePattern[] = Array.from({ length: count }, (_, i) => ({
            id: `user-${i}`,
            source: "user" as const,
            urlMatchPattern: `*://*.site${i}.com/*`,
            contentSelector: ".content",
          }));
          const settings: Settings = {
            ...DEFAULT_SETTINGS,
            sitePatterns: userPatterns,
          };
          const errors = validateSettings(settings);
          const patternErrors = errors.filter((e) => e.field === "sitePatterns");
          expect(patternErrors.length).toBe(1);
          expect(patternErrors[0].message).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects non-integer or out-of-range [1,120] intervalMinutes", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    const invalidInterval = fc.oneof(
      // Non-integer values (floats)
      fc.double({ min: 0.01, max: 200, noNaN: true }).filter(
        (n) => !Number.isInteger(n),
      ),
      // Below range
      fc.integer({ min: -1000, max: 0 }),
      // Above range
      fc.integer({ min: 121, max: 10000 }),
    );

    fc.assert(
      fc.property(invalidInterval, (interval) => {
        const config: AutoExportConfig = {
          origin: "https://example.com",
          enabled: true,
          intervalMinutes: interval,
          destination: { kind: "download" },
          mode: "content-only",
          skipIfUnchanged: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        };
        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          autoExportConfigs: [config],
        };
        const errors = validateSettings(settings);
        const intervalErrors = errors.filter((e) =>
          e.field.includes("intervalMinutes"),
        );
        expect(intervalErrors.length).toBe(1);
        expect(intervalErrors[0].message).toBeTruthy();
      }),
      { numRuns: 100 },
    );
  });

  it("accepts valid settings with no validation errors", () => {
    /**
     * **Validates: Requirements 8.7**
     */
    const validBaseUrl = fc.oneof(
      fc.constant(""),
      fc.webUrl().map((url) => url), // webUrl generates http/https URLs
    );

    const validFilenamePattern = fc.string({ minLength: 1 }).filter(
      (s) => s.trim().length > 0,
    );

    const validInterval = fc.integer({ min: 1, max: 120 });

    const validSitePatterns = fc.array(
      fc.record({
        id: fc.string({ minLength: 1 }),
        source: fc.constant("user" as const),
        urlMatchPattern: fc.string({ minLength: 1 }),
        contentSelector: fc.string({ minLength: 1 }),
      }),
      { minLength: 0, maxLength: 50 },
    );

    const validAutoExportConfigs = fc.array(
      validInterval.map((interval) => ({
        origin: "https://example.com",
        enabled: true,
        intervalMinutes: interval,
        destination: { kind: "download" as const },
        mode: "content-only" as const,
        skipIfUnchanged: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      })),
      { minLength: 0, maxLength: 5 },
    );

    fc.assert(
      fc.property(
        validBaseUrl,
        validFilenamePattern,
        validSitePatterns,
        validAutoExportConfigs,
        (baseUrl, filenamePattern, sitePatterns, autoExportConfigs) => {
          const settings: Settings = {
            schemaVersion: 1,
            ai: {
              baseUrl,
              modelId: "gpt-4",
              apiKeyRef: null,
              systemPrompt: "",
            },
            export: {
              filenamePattern,
              defaultDestination: { kind: "download" },
              frontmatterFields: ["title"],
            },
            sitePatterns,
            autoExportConfigs,
          };
          const errors = validateSettings(settings);
          expect(errors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
