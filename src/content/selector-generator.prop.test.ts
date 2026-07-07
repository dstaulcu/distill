import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { JSDOM } from "jsdom";
import { generateStableSelector } from "./selector-generator";

/**
 * Property-based tests for selector generator stability and uniqueness.
 *
 * **Validates: Requirements 6.5, 6.9**
 *
 * Requirement 6.5: WHEN the user clicks an element in the picker, THE
 * Content_Script SHALL generate a CSS selector for the chosen element and
 * send it to the Background_Script.
 *
 * Requirement 6.9: WHEN the element picker generates a CSS selector, THE
 * selector SHALL prefer stable attributes (id, data-* attributes, semantic
 * tags) over positional selectors (nth-child) to maximize durability across
 * page changes.
 */

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid HTML tag names for generating DOM trees. */
const tagNames = [
  "div",
  "span",
  "p",
  "section",
  "article",
  "main",
  "nav",
  "aside",
  "header",
  "footer",
  "ul",
  "li",
  "h1",
  "h2",
  "h3",
] as const;

const tagNameArb = fc.constantFrom(...tagNames);

/** Generates a simple alphanumeric string suitable for attribute values. */
const alphanumId = fc.stringOf(
  fc.constantFrom(
    "a", "b", "c", "d", "e", "f", "g", "h", "x", "y", "z",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  ),
  { minLength: 1, maxLength: 10 },
);

/**
 * Generates a valid CSS identifier (starts with a letter, followed by alphanumeric/hyphens).
 * CSS identifiers cannot start with a digit.
 */
const validCssId = fc
  .tuple(
    fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "x", "y", "z"),
    fc.stringOf(
      fc.constantFrom(
        "a", "b", "c", "d", "e", "f", "g", "h", "x", "y", "z",
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-",
      ),
      { minLength: 0, maxLength: 9 },
    ),
  )
  .map(([first, rest]) => `${first}${rest}`);

/** Generates a data-* attribute name. */
const dataAttrName = fc
  .constantFrom("data-testid", "data-id", "data-section", "data-role", "data-component", "data-key")

/** Generates a data-* attribute value. */
const dataAttrValue = alphanumId;

/**
 * Generates a random DOM tree as an HTML string with configurable depth and breadth.
 * Returns the HTML and the total number of elements (excluding html/head/body).
 */
function generateDomTree(opts: {
  maxDepth: number;
  maxSiblings: number;
}): fc.Arbitrary<string> {
  const { maxDepth, maxSiblings } = opts;

  const leafNode: fc.Arbitrary<string> = tagNameArb.map(
    (tag) => `<${tag}>text</${tag}>`,
  );

  function treeNode(depth: number): fc.Arbitrary<string> {
    if (depth <= 0) return leafNode;

    return fc
      .record({
        tag: tagNameArb,
        childCount: fc.integer({ min: 1, max: maxSiblings }),
      })
      .chain(({ tag, childCount }) =>
        fc
          .array(treeNode(depth - 1), {
            minLength: childCount,
            maxLength: childCount,
          })
          .map(
            (children) =>
              `<${tag}>${children.join("")}</${tag}>`,
          ),
      );
  }

  return treeNode(maxDepth).map((inner) => `<body>${inner}</body>`);
}

/**
 * Generates a DOM tree and picks a random element index from it.
 */
const domTreeWithRandomElement = fc
  .record({
    tree: generateDomTree({ maxDepth: 3, maxSiblings: 3 }),
    pickIndex: fc.nat(),
  })
  .map(({ tree, pickIndex }) => {
    const dom = new JSDOM(tree);
    const doc = dom.window.document;
    // Get all elements except html, head, body
    const allElements = Array.from(doc.querySelectorAll("body *"));
    if (allElements.length === 0) {
      return null;
    }
    const idx = pickIndex % allElements.length;
    return { doc, element: allElements[idx], allElements };
  })
  .filter((v): v is NonNullable<typeof v> => v !== null);

/**
 * Generates a document with an element that has a unique ID.
 * Uses validCssId to ensure the ID produces a valid CSS #id selector.
 */
const docWithUniqueId = fc
  .record({
    id: validCssId,
    tag: tagNameArb,
    siblingCount: fc.integer({ min: 0, max: 4 }),
  })
  .map(({ id, tag, siblingCount }) => {
    const siblings = Array.from(
      { length: siblingCount },
      (_, i) => `<div>sibling-${i}</div>`,
    ).join("");
    const html = `<body>${siblings}<${tag} id="${id}">target</${tag}></body>`;
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const element = doc.getElementById(id)!;
    return { doc, element, id };
  });

/**
 * Generates a document with an element that has a unique data-* attribute
 * but no ID.
 */
const docWithUniqueDataAttr = fc
  .record({
    attrName: dataAttrName,
    attrValue: dataAttrValue,
    tag: tagNameArb,
    siblingCount: fc.integer({ min: 0, max: 4 }),
  })
  .map(({ attrName, attrValue, tag, siblingCount }) => {
    const siblings = Array.from(
      { length: siblingCount },
      (_, i) => `<div>sibling-${i}</div>`,
    ).join("");
    const html = `<body>${siblings}<${tag} ${attrName}="${attrValue}">target</${tag}></body>`;
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const element = doc.querySelector(`[${attrName}="${attrValue}"]`)!;
    return { doc, element, attrName, attrValue };
  });

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Selector Generator - Property 15: Selector generator stability and uniqueness", () => {
  it("generated selector matches exactly one element and it is the original element", () => {
    fc.assert(
      fc.property(domTreeWithRandomElement, ({ doc, element }) => {
        const selector = generateStableSelector(element, doc);

        // The selector must be a non-empty string
        expect(selector).toBeTruthy();
        expect(typeof selector).toBe("string");

        // The selector must match exactly one element
        const matches = doc.querySelectorAll(selector);
        expect(matches.length).toBe(1);

        // The matched element must be the original element
        expect(matches[0]).toBe(element);
      }),
      { numRuns: 300 },
    );
  });

  it("elements with unique IDs produce #id format selectors", () => {
    fc.assert(
      fc.property(docWithUniqueId, ({ doc, element, id }) => {
        const selector = generateStableSelector(element, doc);

        // Should use the id selector format
        expect(selector.startsWith("#")).toBe(true);

        // Must still match exactly one element
        const matches = doc.querySelectorAll(selector);
        expect(matches.length).toBe(1);
        expect(matches[0]).toBe(element);
      }),
      { numRuns: 200 },
    );
  });

  it("elements with unique data-* attributes produce [data-attr=\"value\"] format selectors", () => {
    fc.assert(
      fc.property(docWithUniqueDataAttr, ({ doc, element, attrName, attrValue }) => {
        const selector = generateStableSelector(element, doc);

        // Should use the data attribute selector format
        expect(selector.startsWith("[")).toBe(true);
        expect(selector).toContain(attrName);

        // Must still match exactly one element
        const matches = doc.querySelectorAll(selector);
        expect(matches.length).toBe(1);
        expect(matches[0]).toBe(element);
      }),
      { numRuns: 200 },
    );
  });

  it("selector never matches zero or more than one element", () => {
    fc.assert(
      fc.property(domTreeWithRandomElement, ({ doc, element }) => {
        const selector = generateStableSelector(element, doc);

        const matches = doc.querySelectorAll(selector);

        // Must never be zero
        expect(matches.length).toBeGreaterThan(0);
        // Must never be more than one
        expect(matches.length).toBeLessThanOrEqual(1);
        // Combined: exactly one
        expect(matches.length).toBe(1);
      }),
      { numRuns: 300 },
    );
  });

  it("prefers id over data-* over positional selectors", () => {
    fc.assert(
      fc.property(
        fc.record({
          id: validCssId,
          dataAttr: dataAttrName,
          dataValue: dataAttrValue,
          siblingCount: fc.integer({ min: 1, max: 3 }),
        }),
        ({ id, dataAttr, dataValue, siblingCount }) => {
          // Element with both id and data-* attribute
          const siblings = Array.from(
            { length: siblingCount },
            (_, i) => `<div>sibling-${i}</div>`,
          ).join("");
          const html = `<body>${siblings}<div id="${id}" ${dataAttr}="${dataValue}">target</div></body>`;
          const dom = new JSDOM(html);
          const doc = dom.window.document;
          const element = doc.getElementById(id)!;

          const selector = generateStableSelector(element, doc);

          // Should prefer id over data-*
          expect(selector.startsWith("#")).toBe(true);
          expect(selector).not.toContain("[");
        },
      ),
      { numRuns: 200 },
    );
  });
});
