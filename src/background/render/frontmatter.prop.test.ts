import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatYamlValue, needsQuoting } from "./frontmatter";

// ---------------------------------------------------------------------------
// Property 4: Frontmatter YAML quoting round-trip
// Validates: Requirements 5.12
// ---------------------------------------------------------------------------

/**
 * Characters that trigger double-quoting in formatYamlValue.
 */
const YAML_SPECIAL_CHARS = [":", "#", "'", '"', "\n"];

/**
 * Arbitrary that generates strings guaranteed to contain at least one
 * YAML-special character (colon, hash, single/double quote, newline)
 * or have leading/trailing whitespace.
 */
const yamlSpecialStringArb = fc.oneof(
  // Strings containing at least one special character
  fc
    .tuple(
      fc.string({ minLength: 0, maxLength: 20 }),
      fc.constantFrom(...YAML_SPECIAL_CHARS),
      fc.string({ minLength: 0, maxLength: 20 }),
    )
    .map(([prefix, special, suffix]) => prefix + special + suffix),
  // Strings with leading whitespace
  fc
    .tuple(
      fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 }),
      fc.string({ minLength: 1, maxLength: 20 }),
    )
    .map(([ws, rest]) => ws + rest),
  // Strings with trailing whitespace
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 }),
    )
    .map(([rest, ws]) => rest + ws),
);

/**
 * Arbitrary that generates "safe" strings — no YAML-special characters,
 * no leading/trailing whitespace, non-empty.
 */
const safeStringArb = fc
  .stringOf(
    fc.char().filter((c) => {
      // Exclude YAML-special chars, whitespace at edges handled separately
      return !YAML_SPECIAL_CHARS.includes(c) && c !== " " && c !== "\t";
    }),
    { minLength: 1, maxLength: 30 },
  )
  .filter((s) => {
    // Ensure no leading/trailing whitespace and not empty
    return s.length > 0 && s === s.trim() && !/[:#'"\n]/.test(s);
  });

describe("Property 4: Frontmatter YAML quoting round-trip", () => {
  it("strings with YAML-special characters are rendered as double-quoted scalars", () => {
    /**
     * **Validates: Requirements 5.12**
     */
    fc.assert(
      fc.property(yamlSpecialStringArb, (value) => {
        const rendered = formatYamlValue(value);

        // The rendered value must start and end with double quotes
        expect(rendered.startsWith('"')).toBe(true);
        expect(rendered.endsWith('"')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("JSON.parse of the quoted value recovers the original string (round-trip)", () => {
    /**
     * **Validates: Requirements 5.12**
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (value) => {
        const rendered = formatYamlValue(value);

        if (needsQuoting(value)) {
          // The rendered value is a JSON-compatible double-quoted string
          // JSON.parse should recover the original value
          const recovered = JSON.parse(rendered);
          expect(recovered).toBe(value);
        } else {
          // Safe strings are returned as-is (unquoted)
          expect(rendered).toBe(value);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("safe strings (no special chars) are NOT quoted", () => {
    /**
     * **Validates: Requirements 5.12**
     */
    fc.assert(
      fc.property(safeStringArb, (value) => {
        const rendered = formatYamlValue(value);

        // Safe strings should be returned without quotes
        expect(rendered).toBe(value);
        expect(rendered.startsWith('"')).toBe(false);
        expect(rendered.endsWith('"')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
