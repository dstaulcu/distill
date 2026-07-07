import { describe, it, expect } from "vitest";
import {
  buildMessage,
  isAnyMessage,
  isMessageOfKind,
} from "./messages";

describe("messages", () => {
  describe("buildMessage", () => {
    it("constructs a message envelope with kind and payload", () => {
      const msg = buildMessage("extractRequested", { tabId: 42 });
      expect(msg.kind).toBe("extractRequested");
      expect(msg.payload).toEqual({ tabId: 42 });
      expect(msg.requestId).toBeUndefined();
    });

    it("includes requestId when provided", () => {
      const msg = buildMessage("clipboardWrite", { content: "hello" }, "req-1");
      expect(msg.kind).toBe("clipboardWrite");
      expect(msg.payload).toEqual({ content: "hello" });
      expect(msg.requestId).toBe("req-1");
    });
  });

  describe("isAnyMessage", () => {
    it("returns true for a valid message envelope", () => {
      expect(isAnyMessage({ kind: "extractRequested", payload: { tabId: 1 } })).toBe(true);
    });

    it("returns true for unknown kind with payload present", () => {
      expect(isAnyMessage({ kind: "unknownKind", payload: {} })).toBe(true);
    });

    it("returns false for null", () => {
      expect(isAnyMessage(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isAnyMessage(undefined)).toBe(false);
    });

    it("returns false for a primitive", () => {
      expect(isAnyMessage(42)).toBe(false);
      expect(isAnyMessage("hello")).toBe(false);
      expect(isAnyMessage(true)).toBe(false);
    });

    it("returns false for an object without kind", () => {
      expect(isAnyMessage({ payload: {} })).toBe(false);
    });

    it("returns false for an object with non-string kind", () => {
      expect(isAnyMessage({ kind: 123, payload: {} })).toBe(false);
    });

    it("returns false for an object without payload", () => {
      expect(isAnyMessage({ kind: "extractRequested" })).toBe(false);
    });

    it("returns true when payload is null (payload property is present)", () => {
      expect(isAnyMessage({ kind: "test", payload: null })).toBe(true);
    });

    it("returns true when payload is undefined (property exists)", () => {
      expect(isAnyMessage({ kind: "test", payload: undefined })).toBe(true);
    });
  });

  describe("isMessageOfKind", () => {
    it("returns true for a message matching the specified kind", () => {
      const msg = { kind: "extractRequested", payload: { tabId: 1 } };
      expect(isMessageOfKind(msg, "extractRequested")).toBe(true);
    });

    it("returns false for a message with a different kind", () => {
      const msg = { kind: "extractResult", payload: { ok: true } };
      expect(isMessageOfKind(msg, "extractRequested")).toBe(false);
    });

    it("returns false for invalid values", () => {
      expect(isMessageOfKind(null, "extractRequested")).toBe(false);
      expect(isMessageOfKind(42, "extractRequested")).toBe(false);
      expect(isMessageOfKind({}, "extractRequested")).toBe(false);
    });
  });
});
