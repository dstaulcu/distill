import { describe, it, expect } from "vitest";
import {
  isSidebarToControllerMessage,
  isControllerToSidebarMessage,
} from "./port-protocol";

describe("port-protocol", () => {
  describe("isSidebarToControllerMessage", () => {
    it("returns true for valid sidebar messages", () => {
      expect(isSidebarToControllerMessage({ type: "init", tabId: 1 })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "sendMessage", text: "hi" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "abort" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "retry" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "autoExportEnable", config: {} })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "autoExportDisable", origin: "https://x.com" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "autoExportStatusRequest", tabId: 5 })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "loadSkill", raw: "# Skill" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "generateSkillFromContext" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "clearSkill" })).toBe(true);
    });

    it("returns false for invalid values", () => {
      expect(isSidebarToControllerMessage(null)).toBe(false);
      expect(isSidebarToControllerMessage(undefined)).toBe(false);
      expect(isSidebarToControllerMessage(42)).toBe(false);
      expect(isSidebarToControllerMessage({})).toBe(false);
      expect(isSidebarToControllerMessage({ type: 123 })).toBe(false);
      expect(isSidebarToControllerMessage({ type: "unknownType" })).toBe(false);
    });
  });

  describe("isControllerToSidebarMessage", () => {
    it("returns true for valid controller messages", () => {
      expect(isControllerToSidebarMessage({ type: "contextLoaded", title: "T", url: "u" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "streamToken", token: "hi" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "streamEnd", fullContent: "done" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "streamStart" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "configError", reason: "not-configured" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "autoExportStatus", status: null })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "skillLoaded", name: "Dave", description: "A persona", activation: "Hello!" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "skillGenerationStarted" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "skillCleared" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "skillError", errors: ["Missing name"] })).toBe(true);
    });

    it("returns false for invalid values", () => {
      expect(isControllerToSidebarMessage(null)).toBe(false);
      expect(isControllerToSidebarMessage(undefined)).toBe(false);
      expect(isControllerToSidebarMessage({})).toBe(false);
      expect(isControllerToSidebarMessage({ type: "init" })).toBe(false);
      expect(isControllerToSidebarMessage({ type: "unknownType" })).toBe(false);
    });
  });
});
