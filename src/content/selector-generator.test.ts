import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { generateStableSelector } from "./selector-generator";

function createDoc(html: string): Document {
  const dom = new JSDOM(html);
  return dom.window.document;
}

describe("CF-6.3 generateStableSelector", () => {
  describe("id selector (highest priority)", () => {
    it("returns #id when element has a unique id", () => {
      const doc = createDoc(`<body><div id="main-content">Hello</div></body>`);
      const el = doc.getElementById("main-content")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe("#main-content");
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("escapes special characters in id", () => {
      const doc = createDoc(`<body><div id="my.element">Hello</div></body>`);
      const el = doc.querySelector('[id="my.element"]')!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe("#my\\.element");
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("skips id if it matches multiple elements (invalid HTML)", () => {
      // jsdom allows duplicate IDs; querySelectorAll will return multiple
      const doc = createDoc(
        `<body><div id="dup">A</div><div id="dup">B</div></body>`
      );
      const el = doc.querySelector('[id="dup"]')!;
      const selector = generateStableSelector(el, doc);
      // Should NOT be #dup since it matches more than one
      expect(selector).not.toBe("#dup");
    });
  });

  describe("data-* attribute selector (second priority)", () => {
    it("returns [data-attr] selector when unique", () => {
      const doc = createDoc(
        `<body><div data-testid="card">Card</div><div>Other</div></body>`
      );
      const el = doc.querySelector('[data-testid="card"]')!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe('[data-testid="card"]');
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("tries multiple data attributes until one is unique", () => {
      const doc = createDoc(
        `<body>
          <div data-type="item" data-id="unique-123">A</div>
          <div data-type="item">B</div>
        </body>`
      );
      const el = doc.querySelector('[data-id="unique-123"]')!;
      const selector = generateStableSelector(el, doc);
      // data-type="item" matches 2 elements, so it should use data-id
      expect(selector).toBe('[data-id="unique-123"]');
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("escapes quotes in data attribute values", () => {
      const doc = createDoc(
        `<body><div data-label='say "hello"'>Content</div></body>`
      );
      const el = doc.querySelector("div[data-label]")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe('[data-label="say \\"hello\\""]');
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("skips data-* if none are unique", () => {
      const doc = createDoc(
        `<body>
          <div data-type="item">A</div>
          <div data-type="item">B</div>
        </body>`
      );
      const el = doc.querySelector('[data-type="item"]')!;
      const selector = generateStableSelector(el, doc);
      // Should fall through to nth-of-type path
      expect(selector).not.toContain("data-type");
    });
  });

  describe("semantic tag selector (third priority)", () => {
    it("returns tag name for unique semantic elements", () => {
      const doc = createDoc(
        `<body><article><p>Content</p></article></body>`
      );
      const el = doc.querySelector("article")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe("article");
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("works for all semantic tags", () => {
      const tags = ["main", "nav", "aside", "header", "footer", "section"];
      for (const tag of tags) {
        const doc = createDoc(`<body><${tag}>Content</${tag}></body>`);
        const el = doc.querySelector(tag)!;
        const selector = generateStableSelector(el, doc);
        expect(selector).toBe(tag);
        expect(doc.querySelectorAll(selector).length).toBe(1);
      }
    });

    it("skips semantic tag if multiple exist", () => {
      const doc = createDoc(
        `<body><section>A</section><section>B</section></body>`
      );
      const el = doc.querySelectorAll("section")[1];
      const selector = generateStableSelector(el, doc);
      expect(selector).not.toBe("section");
    });
  });

  describe("nth-of-type path (fallback)", () => {
    it("builds path from root for non-unique elements", () => {
      const doc = createDoc(
        `<body>
          <div><p>First</p></div>
          <div><p>Second</p></div>
        </body>`
      );
      const el = doc.querySelectorAll("p")[1];
      const selector = generateStableSelector(el, doc);
      // Should be a path like body > div:nth-of-type(2) > p
      expect(selector).toContain(">");
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("omits nth-of-type when element is only child of its type", () => {
      const doc = createDoc(
        `<body><div><span>Only span</span></div></body>`
      );
      const el = doc.querySelector("span")!;
      const selector = generateStableSelector(el, doc);
      // span is the only span in its parent, so no :nth-of-type needed
      expect(selector).not.toContain(":nth-of-type");
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("uses nth-of-type for sibling elements of same tag", () => {
      const doc = createDoc(
        `<body>
          <div>
            <p>First</p>
            <p>Second</p>
            <p>Third</p>
          </div>
        </body>`
      );
      const el = doc.querySelectorAll("p")[2]; // Third <p>
      const selector = generateStableSelector(el, doc);
      expect(selector).toContain("p:nth-of-type(3)");
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });

    it("handles deeply nested elements", () => {
      const doc = createDoc(
        `<body>
          <div>
            <div>
              <div>
                <span>Deep</span>
              </div>
            </div>
          </div>
        </body>`
      );
      const el = doc.querySelector("span")!;
      const selector = generateStableSelector(el, doc);
      expect(doc.querySelectorAll(selector).length).toBe(1);
    });
  });

  describe("priority ordering", () => {
    it("prefers id over data-* attributes", () => {
      const doc = createDoc(
        `<body><div id="unique" data-testid="card">Content</div></body>`
      );
      const el = doc.getElementById("unique")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe("#unique");
    });

    it("prefers data-* over semantic tag", () => {
      const doc = createDoc(
        `<body><article data-section="main">Content</article></body>`
      );
      const el = doc.querySelector("article")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe('[data-section="main"]');
    });

    it("prefers semantic tag over nth-of-type path", () => {
      const doc = createDoc(
        `<body><div><article>Content</article></div></body>`
      );
      const el = doc.querySelector("article")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe("article");
    });
  });

  describe("validation", () => {
    it("generated selector always matches exactly one element", () => {
      const doc = createDoc(
        `<body>
          <div class="container">
            <div class="row">
              <div class="col">A</div>
              <div class="col">B</div>
              <div class="col">C</div>
            </div>
            <div class="row">
              <div class="col">D</div>
              <div class="col">E</div>
            </div>
          </div>
        </body>`
      );
      // Test each .col element
      const cols = doc.querySelectorAll(".col");
      for (const col of cols) {
        const selector = generateStableSelector(col, doc);
        const matches = doc.querySelectorAll(selector);
        expect(matches.length).toBe(1);
        expect(matches[0]).toBe(col);
      }
    });

    it("uses doc parameter when provided", () => {
      const doc = createDoc(
        `<body><div id="target">Content</div></body>`
      );
      const el = doc.getElementById("target")!;
      const selector = generateStableSelector(el, doc);
      expect(selector).toBe("#target");
    });

    it("falls back to ownerDocument when doc not provided", () => {
      const doc = createDoc(
        `<body><div id="target">Content</div></body>`
      );
      const el = doc.getElementById("target")!;
      // Not passing doc explicitly
      const selector = generateStableSelector(el);
      expect(selector).toBe("#target");
    });
  });
});
