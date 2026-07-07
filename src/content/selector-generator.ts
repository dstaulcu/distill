/**
 * Generates durable CSS selectors preferring stable attributes over positional indices.
 * Priority: id > data-* attributes > semantic tags > nth-of-type path.
 * Validates generated selector matches exactly one element.
 */

const SEMANTIC_TAGS = new Set([
  "article",
  "main",
  "section",
  "nav",
  "aside",
  "header",
  "footer",
]);

function escapeCssIdentifier(value: string): string {
  // Escape characters that are not valid in CSS identifiers
  return value.replace(/([^\w-])/g, "\\$1");
}

function escapeCssAttributeValue(value: string): string {
  // Escape quotes and backslashes inside attribute value strings
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function matchesExactlyOne(selector: string, doc: Document): boolean {
  try {
    const matches = doc.querySelectorAll(selector);
    return matches.length === 1;
  } catch {
    return false;
  }
}

function tryIdSelector(el: Element, doc: Document): string | null {
  const id = el.id;
  if (!id) return null;

  const selector = `#${escapeCssIdentifier(id)}`;
  if (matchesExactlyOne(selector, doc)) {
    return selector;
  }
  return null;
}

function tryDataAttributeSelector(el: Element, doc: Document): string | null {
  const attributes = el.attributes;
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    if (attr.name.startsWith("data-")) {
      const selector = `[${attr.name}="${escapeCssAttributeValue(attr.value)}"]`;
      if (matchesExactlyOne(selector, doc)) {
        return selector;
      }
    }
  }
  return null;
}

function trySemanticTagSelector(el: Element, doc: Document): string | null {
  const tagName = el.tagName.toLowerCase();
  if (!SEMANTIC_TAGS.has(tagName)) return null;

  if (matchesExactlyOne(tagName, doc)) {
    return tagName;
  }
  return null;
}

function buildNthOfTypePath(el: Element, doc: Document): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current !== doc.documentElement) {
    const tagName = current.tagName.toLowerCase();

    if (tagName === "body" || tagName === "html") {
      parts.unshift(tagName);
      current = current.parentElement;
      continue;
    }

    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(tagName);
      break;
    }

    // Count siblings of the same tag type before this element
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName.toLowerCase() === tagName
    );

    if (siblings.length === 1) {
      parts.unshift(tagName);
    } else {
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tagName}:nth-of-type(${index})`);
    }

    current = parent;
  }

  return parts.join(" > ");
}

/**
 * Generates a stable CSS selector for the given element.
 * Priority: id → data-* attributes → semantic tags → nth-of-type path.
 * Validates generated selector matches exactly one element via querySelector.
 */
export function generateStableSelector(el: Element, doc?: Document): string {
  const document = doc ?? el.ownerDocument;

  // 1. Try id selector
  const idSelector = tryIdSelector(el, document);
  if (idSelector) return idSelector;

  // 2. Try data-* attribute selectors
  const dataSelector = tryDataAttributeSelector(el, document);
  if (dataSelector) return dataSelector;

  // 3. Try semantic tag selector
  const semanticSelector = trySemanticTagSelector(el, document);
  if (semanticSelector) return semanticSelector;

  // 4. Fall back to nth-of-type path
  return buildNthOfTypePath(el, document);
}
