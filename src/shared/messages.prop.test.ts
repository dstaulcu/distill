import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isAnyMessage } from "./messages";

/**
 * Property 13: Message envelope validation
 * Validates: Requirements 9.2, 9.5, 9.6
 *
 * Verifies that isAnyMessage:
 * - Never throws for any input
 * - Returns true for valid envelopes (non-null object with string kind + payload present)
 * - Returns false for invalid values (primitives, nulls, malformed objects)
 */
describe("Property 13: Message envelope validation", () => {
  it("never throws for arbitrary values", () => {
    /**
     * **Validates: Requirements 9.2, 9.5, 9.6**
     */
    fc.assert(
      fc.property(fc.anything(), (value) => {
        // isAnyMessage must never throw, regardless of input
        expect(() => isAnyMessage(value)).not.toThrow();
      }),
    );
  });

  it("returns true for valid envelopes (object with string kind and payload present)", () => {
    /**
     * **Validates: Requirements 9.2, 9.5, 9.6**
     */
    const validEnvelopeArb = fc.record({
      kind: fc.string({ minLength: 1 }),
      payload: fc.anything(),
    });

    fc.assert(
      fc.property(validEnvelopeArb, (envelope) => {
        expect(isAnyMessage(envelope)).toBe(true);
      }),
    );
  });

  it("returns false for null, undefined, and primitives", () => {
    /**
     * **Validates: Requirements 9.2, 9.5, 9.6**
     */
    const invalidPrimitiveArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.double(),
      fc.boolean(),
      fc.string(),
      fc.bigInt(),
    );

    fc.assert(
      fc.property(invalidPrimitiveArb, (value) => {
        expect(isAnyMessage(value)).toBe(false);
      }),
    );
  });

  it("returns false for objects missing kind or payload", () => {
    /**
     * **Validates: Requirements 9.2, 9.5, 9.6**
     */
    const missingKindArb = fc.record({
      payload: fc.anything(),
    });

    const missingPayloadArb = fc.record({
      kind: fc.string({ minLength: 1 }),
    });

    const nonStringKindArb = fc.record({
      kind: fc.oneof(
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.double(),
        fc.array(fc.anything()),
      ),
      payload: fc.anything(),
    });

    fc.assert(
      fc.property(missingKindArb, (value) => {
        expect(isAnyMessage(value)).toBe(false);
      }),
    );

    fc.assert(
      fc.property(missingPayloadArb, (value) => {
        expect(isAnyMessage(value)).toBe(false);
      }),
    );

    fc.assert(
      fc.property(nonStringKindArb, (value) => {
        expect(isAnyMessage(value)).toBe(false);
      }),
    );
  });
});
