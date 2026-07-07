import { describe, it, expect } from "vitest";
import { generateAutoExportFilename } from "./filename";

describe("generateAutoExportFilename", () => {
  const baseDate = new Date("2024-03-15T10:30:00Z");

  describe("successful filename generation", () => {
    it("generates filename with YYYY-MM-DD-HHmm-slug pattern", () => {
      const result = generateAutoExportFilename({
        title: "Hello World",
        date: baseDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-03-15-1030-hello-world.md" });
    });

    it("pads single-digit hours with leading zero", () => {
      const earlyDate = new Date("2024-06-01T03:05:00Z");
      const result = generateAutoExportFilename({
        title: "Morning Article",
        date: earlyDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-06-01-0305-morning-article.md" });
    });

    it("handles midnight (00:00)", () => {
      const midnightDate = new Date("2024-01-01T00:00:00Z");
      const result = generateAutoExportFilename({
        title: "New Year",
        date: midnightDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-01-01-0000-new-year.md" });
    });

    it("handles end of day (23:59)", () => {
      const lateDate = new Date("2024-12-31T23:59:00Z");
      const result = generateAutoExportFilename({
        title: "Last Minute",
        date: lateDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-12-31-2359-last-minute.md" });
    });

    it("slugifies title correctly (lowercase, alphanumeric, hyphens)", () => {
      const result = generateAutoExportFilename({
        title: "My Article: A Deep Dive! #2024",
        date: baseDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-03-15-1030-my-article-a-deep-dive-2024.md" });
    });

    it("handles title with only numbers", () => {
      const result = generateAutoExportFilename({
        title: "12345",
        date: baseDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-03-15-1030-12345.md" });
    });
  });

  describe("filename length capping", () => {
    it("caps total filename at 100 characters including .md extension", () => {
      const longTitle = "a".repeat(200);
      const result = generateAutoExportFilename({
        title: longTitle,
        date: baseDate,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filename.length).toBeLessThanOrEqual(100);
        expect(result.filename).toMatch(/\.md$/);
      }
    });

    it("truncates slug portion to fit within cap", () => {
      const longTitle = "a".repeat(200);
      const result = generateAutoExportFilename({
        title: longTitle,
        date: baseDate,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Prefix is "2024-03-15-1030-" (16 chars) + ".md" (3 chars) = 19 fixed chars
        // So slug can be at most 100 - 19 = 81 chars
        expect(result.filename).toMatch(/^2024-03-15-1030-a+\.md$/);
        expect(result.filename.length).toBe(100);
      }
    });

    it("does not leave trailing hyphens after truncation", () => {
      // Create a title that produces hyphens at truncation boundary
      const title = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? "a" : " ")).join("");
      const result = generateAutoExportFilename({
        title,
        date: baseDate,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filename).not.toMatch(/-\.md$/);
        expect(result.filename.length).toBeLessThanOrEqual(100);
      }
    });

    it("handles title that exactly fills remaining space", () => {
      // Prefix "2024-03-15-1030-" = 16 chars, extension ".md" = 3 chars
      // Available for slug = 100 - 16 - 3 = 81 chars
      const exactTitle = "a".repeat(81);
      const result = generateAutoExportFilename({
        title: exactTitle,
        date: baseDate,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filename.length).toBe(100);
        expect(result.filename).toBe("2024-03-15-1030-" + "a".repeat(81) + ".md");
      }
    });
  });

  describe("failure cases", () => {
    it("returns failure when title has no alphanumeric characters", () => {
      const result = generateAutoExportFilename({
        title: "!!!@@@###",
        date: baseDate,
      });
      expect(result).toEqual({
        ok: false,
        reason: "filename-invalid",
        detail: "Title contains no alphanumeric characters for slug generation",
      });
    });

    it("returns failure for empty title", () => {
      const result = generateAutoExportFilename({
        title: "",
        date: baseDate,
      });
      expect(result).toEqual({
        ok: false,
        reason: "filename-invalid",
        detail: "Title contains no alphanumeric characters for slug generation",
      });
    });

    it("returns failure for whitespace-only title", () => {
      const result = generateAutoExportFilename({
        title: "   ",
        date: baseDate,
      });
      expect(result).toEqual({
        ok: false,
        reason: "filename-invalid",
        detail: "Title contains no alphanumeric characters for slug generation",
      });
    });

    it("returns failure for title with only special characters and unicode", () => {
      const result = generateAutoExportFilename({
        title: "★☆♠♣♥♦",
        date: baseDate,
      });
      expect(result).toEqual({
        ok: false,
        reason: "filename-invalid",
        detail: "Title contains no alphanumeric characters for slug generation",
      });
    });
  });

  describe("edge cases", () => {
    it("uses UTC time components (not local time)", () => {
      // Date that could differ between UTC and local time zones
      const utcDate = new Date("2024-06-15T23:45:00Z");
      const result = generateAutoExportFilename({
        title: "Test",
        date: utcDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-06-15-2345-test.md" });
    });

    it("handles single character title", () => {
      const result = generateAutoExportFilename({
        title: "x",
        date: baseDate,
      });
      expect(result).toEqual({ ok: true, filename: "2024-03-15-1030-x.md" });
    });

    it("handles title with mixed alphanumeric and special chars", () => {
      const result = generateAutoExportFilename({
        title: "café résumé",
        date: baseDate,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // slugifyTitle strips non-ascii, keeps a-z0-9
        expect(result.filename).toBe("2024-03-15-1030-caf-r-sum.md");
      }
    });
  });
});
