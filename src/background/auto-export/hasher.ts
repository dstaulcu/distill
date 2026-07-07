/**
 * Content hasher for auto-export change detection (SF-4).
 * Uses FNV-1a (32-bit) for fast, synchronous, deterministic hashing over the
 * FULL content — truncating would silently miss tail-only changes.
 */

// FNV-1a 32-bit constants
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Computes an FNV-1a 32-bit hash of the input string.
 */
function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Produces a hash string from the full content.
 * Used for "skip if unchanged" mode in auto-export.
 */
export function hashContent(content: string): string {
  const hash = fnv1a32(content);
  return hash.toString(16).padStart(8, "0");
}

/**
 * Compares two hashes to determine if content has changed.
 * Returns true if hashes differ or previousHash is null.
 */
export function hasContentChanged(previousHash: string | null, currentHash: string): boolean {
  if (previousHash === null) {
    return true;
  }
  return previousHash !== currentHash;
}
