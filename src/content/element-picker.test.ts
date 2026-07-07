import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createElementPicker } from "./element-picker";

function createTestEnv(html = "<body><div id='content'><p>Hello world</p><span>More text</span></div></body>") {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const doc = dom.window.document;
  const win = dom.window as unknown as Window;
  return { dom, doc, win };
}

describe("CF-6.3 createElementPicker", () => {
  describe("factory function", () => {
    it("returns an object with pick and cancel methods", () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });
      expect(picker).toHaveProperty("pick");
      expect(picker).toHaveProperty("cancel");
      expect(typeof picker.pick).toBe("function");
      expect(typeof picker.cancel).toBe("function");
    });
  });

  describe("pick()", () => {
    it("creates overlay, highlight, and tooltip elements in the DOM", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      // Start picking (don't await — it resolves on click/cancel)
      const pickPromise = picker.pick();

      expect(doc.querySelector("[data-distill-picker-overlay]")).not.toBeNull();
      expect(doc.querySelector("[data-distill-picker-highlight]")).not.toBeNull();
      expect(doc.querySelector("[data-distill-picker-tooltip]")).not.toBeNull();

      // Clean up
      picker.cancel();
      await pickPromise;
    });

    it("overlay has fixed positioning and full viewport coverage", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      expect(overlay.style.position).toBe("fixed");
      expect(overlay.style.top).toBe("0px");
      expect(overlay.style.left).toBe("0px");
      expect(overlay.style.width).toBe("100%");
      expect(overlay.style.height).toBe("100%");
      expect(overlay.style.cursor).toBe("crosshair");

      picker.cancel();
      await pickPromise;
    });

    it("highlight element has a visible border style", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      const highlight = doc.querySelector("[data-distill-picker-highlight]") as HTMLElement;

      expect(highlight.style.borderWidth).toBe("2px");
      expect(highlight.style.borderStyle).toBe("solid");
      expect(highlight.style.pointerEvents).toBe("none");

      picker.cancel();
      await pickPromise;
    });

    it("resolves with selector and previewText on click", async () => {
      const { doc, win, dom } = createTestEnv();
      const generateSelector = vi.fn().mockReturnValue("#content");

      const picker = createElementPicker({
        document: doc,
        window: win,
        generateSelector,
      });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      // Simulate mousemove to set currentTarget
      // We need to mock elementFromPoint since jsdom doesn't support it well
      const targetEl = doc.getElementById("content")!;
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      const moveEvent = new dom.window.MouseEvent("mousemove", {
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      overlay.dispatchEvent(moveEvent);

      // Simulate click
      const clickEvent = new dom.window.MouseEvent("click", {
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      overlay.dispatchEvent(clickEvent);

      const result = await pickPromise;
      expect(result).not.toBeNull();
      expect(result!.selector).toBe("#content");
      expect(result!.previewText).toBe("Hello worldMore text");
      expect(generateSelector).toHaveBeenCalledWith(targetEl);
    });

    it("truncates previewText to 500 characters", async () => {
      const longText = "A".repeat(1000);
      const { doc, win, dom } = createTestEnv(
        `<body><div id="long">${longText}</div></body>`
      );
      const generateSelector = vi.fn().mockReturnValue("#long");

      const picker = createElementPicker({
        document: doc,
        window: win,
        generateSelector,
      });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      const targetEl = doc.getElementById("long")!;
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );
      overlay.dispatchEvent(
        new dom.window.MouseEvent("click", { clientX: 50, clientY: 50, bubbles: true })
      );

      const result = await pickPromise;
      expect(result).not.toBeNull();
      expect(result!.previewText.length).toBe(500);
    });

    it("uses generateStableSelector by default when no generateSelector provided", async () => {
      const { doc, win, dom } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      const targetEl = doc.getElementById("content")!;
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );
      overlay.dispatchEvent(
        new dom.window.MouseEvent("click", { clientX: 50, clientY: 50, bubbles: true })
      );

      const result = await pickPromise;
      expect(result).not.toBeNull();
      // generateStableSelector should return #content for an element with id="content"
      expect(result!.selector).toBe("#content");
    });
  });

  describe("cancel()", () => {
    it("resolves the pick promise with null", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      picker.cancel();

      const result = await pickPromise;
      expect(result).toBeNull();
    });

    it("removes all DOM elements on cancel", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      expect(doc.querySelector("[data-distill-picker-overlay]")).not.toBeNull();

      picker.cancel();
      await pickPromise;

      expect(doc.querySelector("[data-distill-picker-overlay]")).toBeNull();
      expect(doc.querySelector("[data-distill-picker-highlight]")).toBeNull();
      expect(doc.querySelector("[data-distill-picker-tooltip]")).toBeNull();
    });

    it("can be called multiple times without error", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      picker.cancel();
      picker.cancel(); // Should not throw
      picker.cancel();

      const result = await pickPromise;
      expect(result).toBeNull();
    });
  });

  describe("Escape key", () => {
    it("cancels the picker when Escape is pressed", async () => {
      const { doc, win, dom } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();

      const escEvent = new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      });
      doc.dispatchEvent(escEvent);

      const result = await pickPromise;
      expect(result).toBeNull();
    });

    it("removes DOM elements when Escape is pressed", async () => {
      const { doc, win, dom } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      expect(doc.querySelector("[data-distill-picker-overlay]")).not.toBeNull();

      const escEvent = new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      });
      doc.dispatchEvent(escEvent);
      await pickPromise;

      expect(doc.querySelector("[data-distill-picker-overlay]")).toBeNull();
    });
  });

  describe("hover highlighting", () => {
    it("updates highlight position on mousemove", async () => {
      const { doc, win, dom } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;
      const highlightEl = doc.querySelector("[data-distill-picker-highlight]") as HTMLElement;

      const targetEl = doc.getElementById("content")!;
      // Mock getBoundingClientRect
      targetEl.getBoundingClientRect = () => ({
        top: 100,
        left: 50,
        width: 200,
        height: 150,
        bottom: 250,
        right: 250,
        x: 50,
        y: 100,
        toJSON: () => {},
      });
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 100, clientY: 150, bubbles: true })
      );

      expect(highlightEl.style.display).toBe("block");
      expect(highlightEl.style.top).toBe("100px");
      expect(highlightEl.style.left).toBe("50px");
      expect(highlightEl.style.width).toBe("200px");
      expect(highlightEl.style.height).toBe("150px");

      picker.cancel();
      await pickPromise;
    });

    it("shows tag name and dimensions in tooltip", async () => {
      const { doc, win, dom } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;
      const tooltipEl = doc.querySelector("[data-distill-picker-tooltip]") as HTMLElement;

      const targetEl = doc.querySelector("p")!;
      targetEl.getBoundingClientRect = () => ({
        top: 100,
        left: 50,
        width: 300,
        height: 20,
        bottom: 120,
        right: 350,
        x: 50,
        y: 100,
        toJSON: () => {},
      });
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 100, clientY: 110, bubbles: true })
      );

      expect(tooltipEl.style.display).toBe("block");
      expect(tooltipEl.textContent).toBe("p — 300×20");

      picker.cancel();
      await pickPromise;
    });

    it("hides highlight when hovering over picker elements", async () => {
      const { doc, win, dom } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;
      const highlightEl = doc.querySelector("[data-distill-picker-highlight]") as HTMLElement;

      // First, hover over a real element
      const targetEl = doc.getElementById("content")!;
      targetEl.getBoundingClientRect = () => ({
        top: 0, left: 0, width: 100, height: 100, bottom: 100, right: 100, x: 0, y: 0, toJSON: () => {},
      });
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);
      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );
      expect(highlightEl.style.display).toBe("block");

      // Now hover over the overlay itself
      doc.elementFromPoint = vi.fn().mockReturnValue(overlay);
      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );
      expect(highlightEl.style.display).toBe("none");

      picker.cancel();
      await pickPromise;
    });
  });

  describe("cleanup", () => {
    it("removes all DOM elements after successful pick", async () => {
      const { doc, win, dom } = createTestEnv();
      const generateSelector = vi.fn().mockReturnValue("#content");
      const picker = createElementPicker({
        document: doc,
        window: win,
        generateSelector,
      });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      const targetEl = doc.getElementById("content")!;
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );
      overlay.dispatchEvent(
        new dom.window.MouseEvent("click", { clientX: 50, clientY: 50, bubbles: true })
      );

      await pickPromise;

      expect(doc.querySelector("[data-distill-picker-overlay]")).toBeNull();
      expect(doc.querySelector("[data-distill-picker-highlight]")).toBeNull();
      expect(doc.querySelector("[data-distill-picker-tooltip]")).toBeNull();
    });

    it("cancels previous pick if pick() is called again while active", async () => {
      const { doc, win } = createTestEnv();
      const picker = createElementPicker({ document: doc, window: win });

      const firstPick = picker.pick();
      const secondPick = picker.pick();

      // First pick should resolve with null (cancelled)
      const firstResult = await firstPick;
      expect(firstResult).toBeNull();

      // Second pick is now active
      picker.cancel();
      const secondResult = await secondPick;
      expect(secondResult).toBeNull();
    });
  });

  describe("click behavior", () => {
    it("prevents default and stops propagation on click", async () => {
      const { doc, win, dom } = createTestEnv();
      const generateSelector = vi.fn().mockReturnValue("#content");
      const picker = createElementPicker({
        document: doc,
        window: win,
        generateSelector,
      });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      const targetEl = doc.getElementById("content")!;
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );

      const clickEvent = new dom.window.MouseEvent("click", {
        clientX: 50,
        clientY: 50,
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(clickEvent, "preventDefault");
      const stopPropagationSpy = vi.spyOn(clickEvent, "stopPropagation");

      overlay.dispatchEvent(clickEvent);
      await pickPromise;

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
    });

    it("does nothing on click if no element is hovered", async () => {
      const { doc, win, dom } = createTestEnv();
      const generateSelector = vi.fn().mockReturnValue("#content");
      const picker = createElementPicker({
        document: doc,
        window: win,
        generateSelector,
      });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      // Don't move mouse first — currentTarget is null
      doc.elementFromPoint = vi.fn().mockReturnValue(null);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("click", { clientX: 50, clientY: 50, bubbles: true })
      );

      // Picker should still be active since click was ignored
      expect(doc.querySelector("[data-distill-picker-overlay]")).not.toBeNull();

      picker.cancel();
      const result = await pickPromise;
      expect(result).toBeNull();
    });

    it("handles elements with null textContent gracefully", async () => {
      const { doc, win, dom } = createTestEnv(
        `<body><img id="img-test" src="test.png" /></body>`
      );
      const generateSelector = vi.fn().mockReturnValue("#img-test");
      const picker = createElementPicker({
        document: doc,
        window: win,
        generateSelector,
      });

      const pickPromise = picker.pick();
      const overlay = doc.querySelector("[data-distill-picker-overlay]") as HTMLElement;

      const targetEl = doc.getElementById("img-test")!;
      doc.elementFromPoint = vi.fn().mockReturnValue(targetEl);

      overlay.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })
      );
      overlay.dispatchEvent(
        new dom.window.MouseEvent("click", { clientX: 50, clientY: 50, bubbles: true })
      );

      const result = await pickPromise;
      expect(result).not.toBeNull();
      expect(result!.previewText).toBe("");
    });
  });
});
