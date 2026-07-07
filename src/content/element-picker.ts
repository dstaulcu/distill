import { generateStableSelector } from "./selector-generator";

export interface ElementPicker {
  pick(): Promise<{ selector: string; previewText: string } | null>;
  cancel(): void;
}

export interface ElementPickerOptions {
  readonly generateSelector?: (el: Element) => string;
  readonly window?: Window;
  readonly document?: Document;
}

/**
 * Creates an element picker that overlays the page with a visual picker UI.
 * Highlights hovered elements with a border and semi-transparent overlay,
 * shows tag name and dimensions, and generates a CSS selector on click.
 */
export function createElementPicker(opts?: ElementPickerOptions): ElementPicker {
  const win = opts?.window ?? window;
  const doc = opts?.document ?? document;
  const genSelector = opts?.generateSelector ?? ((el: Element) => generateStableSelector(el, doc));

  let resolvePromise: ((result: { selector: string; previewText: string } | null) => void) | null = null;
  let overlay: HTMLElement | null = null;
  let highlight: HTMLElement | null = null;
  let tooltip: HTMLElement | null = null;
  let currentTarget: Element | null = null;
  let active = false;

  function createOverlay(): HTMLElement {
    const el = doc.createElement("div");
    el.setAttribute("data-distill-picker-overlay", "true");
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      zIndex: "2147483646",
      cursor: "crosshair",
      pointerEvents: "auto",
    });
    return el;
  }

  function createHighlight(): HTMLElement {
    const el = doc.createElement("div");
    el.setAttribute("data-distill-picker-highlight", "true");
    Object.assign(el.style, {
      position: "fixed",
      border: "2px solid #4a90d9",
      backgroundColor: "rgba(74, 144, 217, 0.15)",
      pointerEvents: "none",
      zIndex: "2147483647",
      display: "none",
      boxSizing: "border-box",
    });
    return el;
  }

  function createTooltip(): HTMLElement {
    const el = doc.createElement("div");
    el.setAttribute("data-distill-picker-tooltip", "true");
    Object.assign(el.style, {
      position: "fixed",
      backgroundColor: "#333",
      color: "#fff",
      padding: "4px 8px",
      borderRadius: "3px",
      fontSize: "12px",
      fontFamily: "monospace",
      pointerEvents: "none",
      zIndex: "2147483647",
      display: "none",
      whiteSpace: "nowrap",
    });
    return el;
  }

  function updateHighlight(target: Element): void {
    if (!highlight || !tooltip) return;

    const rect = target.getBoundingClientRect();

    Object.assign(highlight.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      display: "block",
    });

    const tagName = target.tagName.toLowerCase();
    const dimensions = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
    tooltip.textContent = `${tagName} — ${dimensions}`;

    // Position tooltip above the element, or below if not enough space
    const tooltipTop = rect.top > 30 ? rect.top - 28 : rect.bottom + 4;
    Object.assign(tooltip.style, {
      top: `${tooltipTop}px`,
      left: `${rect.left}px`,
      display: "block",
    });
  }

  function hideHighlight(): void {
    if (highlight) highlight.style.display = "none";
    if (tooltip) tooltip.style.display = "none";
  }

  function handleMouseMove(e: MouseEvent): void {
    if (!active) return;

    // Temporarily hide overlay to get the element underneath
    if (overlay) overlay.style.pointerEvents = "none";
    const target = doc.elementFromPoint(e.clientX, e.clientY);
    if (overlay) overlay.style.pointerEvents = "auto";

    if (
      target &&
      target !== overlay &&
      target !== highlight &&
      target !== tooltip &&
      !target.hasAttribute("data-distill-picker-overlay") &&
      !target.hasAttribute("data-distill-picker-highlight") &&
      !target.hasAttribute("data-distill-picker-tooltip")
    ) {
      currentTarget = target;
      updateHighlight(target);
    } else {
      currentTarget = null;
      hideHighlight();
    }
  }

  function handleClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!active || !currentTarget) return;

    const selector = genSelector(currentTarget);
    const textContent = currentTarget.textContent ?? "";
    const previewText = textContent.slice(0, 500);

    cleanup();
    if (resolvePromise) {
      resolvePromise({ selector, previewText });
      resolvePromise = null;
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      cancel();
    }
  }

  function cleanup(): void {
    active = false;

    if (overlay) {
      overlay.removeEventListener("mousemove", handleMouseMove);
      overlay.removeEventListener("click", handleClick);
    }
    doc.removeEventListener("keydown", handleKeyDown, true);

    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (highlight && highlight.parentNode) highlight.parentNode.removeChild(highlight);
    if (tooltip && tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);

    overlay = null;
    highlight = null;
    tooltip = null;
    currentTarget = null;
  }

  function cancel(): void {
    cleanup();
    if (resolvePromise) {
      resolvePromise(null);
      resolvePromise = null;
    }
  }

  function pick(): Promise<{ selector: string; previewText: string } | null> {
    // If already active, cancel the previous pick
    if (active) {
      cancel();
    }

    return new Promise((resolve) => {
      resolvePromise = resolve;
      active = true;

      overlay = createOverlay();
      highlight = createHighlight();
      tooltip = createTooltip();

      doc.body.appendChild(overlay);
      doc.body.appendChild(highlight);
      doc.body.appendChild(tooltip);

      overlay.addEventListener("mousemove", handleMouseMove);
      overlay.addEventListener("click", handleClick);
      doc.addEventListener("keydown", handleKeyDown, true);
    });
  }

  return { pick, cancel };
}
