import { describe, it, expect } from "vitest";
import { hashContent, hasContentChanged } from "./hasher";

describe("hashContent", () => {
  it("returns a deterministic hash for the same content", () => {
    const content = "Hello, world!";
    expect(hashContent(content)).toBe(hashContent(content));
  });

  it("returns different hashes for different content", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("returns an 8-character hex string", () => {
    const hash = hashContent("test content");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("SF-4 detects changes beyond 10,000 characters (full content is hashed)", () => {
    // A page whose opening is stable but whose tail changed must NOT be
    // treated as unchanged (Q3 decision — the old truncation missed this).
    const base = "a".repeat(10_000);
    const withExtra = base + "b".repeat(5_000);
    expect(hashContent(base)).not.toBe(hashContent(withExtra));
  });

  it("produces different hashes for a single-character difference", () => {
    const a = "a".repeat(10_000);
    const b = "a".repeat(9_999) + "b";
    expect(hashContent(a)).not.toBe(hashContent(b));
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles content shorter than 10,000 characters", () => {
    const hash = hashContent("short");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles content exactly 10,000 characters", () => {
    const content = "x".repeat(10_000);
    const hash = hashContent(content);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces consistent results across calls", () => {
    const content = "The quick brown fox jumps over the lazy dog";
    const hash1 = hashContent(content);
    const hash2 = hashContent(content);
    const hash3 = hashContent(content);
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });
});

describe("hasContentChanged", () => {
  it("returns true when previousHash is null", () => {
    expect(hasContentChanged(null, "abcdef01")).toBe(true);
  });

  it("returns true when hashes differ", () => {
    expect(hasContentChanged("11111111", "22222222")).toBe(true);
  });

  it("returns false when hashes are identical", () => {
    expect(hasContentChanged("abcdef01", "abcdef01")).toBe(false);
    const hash = hashContent("same content");
    expect(hasContentChanged(hash, hash)).toBe(false);
  });

  it("returns false for same content hashed independently", () => {
    const content = "test content for hashing";
    const hash1 = hashContent(content);
    const hash2 = hashContent(content);
    expect(hasContentChanged(hash1, hash2)).toBe(false);
  });

  it("returns true for different content hashed independently", () => {
    const hash1 = hashContent("content version 1");
    const hash2 = hashContent("content version 2");
    expect(hasContentChanged(hash1, hash2)).toBe(true);
  });
});
