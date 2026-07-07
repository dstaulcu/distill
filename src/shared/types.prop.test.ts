import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { Result } from "./types";

/**
 * Property 14: Result union discriminant narrowing
 *
 * For any result union value, checking `result.ok === true` SHALL narrow the
 * type to the success branch, and checking `result.ok === false` SHALL narrow
 * to the failure branch with access to `reason` and `detail` fields, without
 * requiring type assertions.
 *
 * **Validates: Requirements 10.1, 10.5**
 */
describe("Property 14: Result union discriminant narrowing", () => {
  // Arbitrary for success results: ok is true and carries an arbitrary payload
  const successResultArb = fc
    .record({
      value: fc.string(),
      count: fc.integer(),
    })
    .map(
      (payload): Result<{ value: string; count: number }, string> => ({
        ok: true,
        ...payload,
      })
    );

  // Arbitrary for failure results: ok is false with reason and detail
  const failureResultArb = fc
    .record({
      reason: fc.stringOf(fc.constantFrom("network", "timeout", "not-found", "validation"), {
        minLength: 1,
        maxLength: 1,
      }),
      detail: fc.string({ minLength: 0, maxLength: 200 }),
    })
    .map(
      ({ reason, detail }): Result<{ value: string; count: number }, string> => ({
        ok: false,
        reason,
        detail,
      })
    );

  // Combined arbitrary that produces either success or failure results
  const resultArb = fc.oneof(successResultArb, failureResultArb);

  it("success results narrow to the success branch with payload accessible", () => {
    fc.assert(
      fc.property(successResultArb, (result) => {
        // Narrowing via ok field — no type assertions needed
        if (result.ok === true) {
          expect(result.ok).toBe(true);
          expect(typeof result.value).toBe("string");
          expect(typeof result.count).toBe("number");
        } else {
          // This branch should never be reached for success results
          expect.unreachable("Success result should not narrow to failure branch");
        }
      })
    );
  });

  it("failure results narrow to the failure branch with reason and detail accessible", () => {
    fc.assert(
      fc.property(failureResultArb, (result) => {
        // Narrowing via ok field — no type assertions needed
        if (result.ok === false) {
          expect(result.ok).toBe(false);
          expect(typeof result.reason).toBe("string");
          expect(result.reason.length).toBeGreaterThan(0);
          expect(typeof result.detail).toBe("string");
          expect(result.detail.length).toBeLessThanOrEqual(200);
        } else {
          // This branch should never be reached for failure results
          expect.unreachable("Failure result should not narrow to success branch");
        }
      })
    );
  });

  it("the ok field is always a boolean and serves as the sole discriminant", () => {
    fc.assert(
      fc.property(resultArb, (result) => {
        // ok is always a boolean
        expect(typeof result.ok).toBe("boolean");

        // Discriminant narrowing works in both directions
        if (result.ok) {
          // Success branch: payload fields are accessible, failure fields are not
          expect(result.ok).toBe(true);
          expect("value" in result).toBe(true);
          expect("count" in result).toBe(true);
        } else {
          // Failure branch: reason and detail are accessible
          expect(result.ok).toBe(false);
          expect("reason" in result).toBe(true);
          expect("detail" in result).toBe(true);
          expect(typeof result.reason).toBe("string");
          expect(typeof result.detail).toBe("string");
        }
      })
    );
  });
});
