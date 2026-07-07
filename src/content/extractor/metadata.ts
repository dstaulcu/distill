/**
 * Metadata Extractor
 *
 * Extracts article metadata using a priority-ordered source chain:
 * Open Graph → JSON-LD → meta tags → DOM heuristics.
 *
 * Each field is resolved independently using the first non-empty value
 * found in the priority chain.
 */

export interface ArticleMetadata {
  readonly title: string;
  readonly author: string | null;
  readonly publicationDate: string | null;
  readonly sourceUrl: string;
  readonly siteName: string;
}

export interface MetadataExtractorOptions {
  readonly doc?: Document;
  readonly url?: string;
}

/**
 * Extracts article metadata from the document using a priority chain:
 * Open Graph → JSON-LD → meta tags → DOM heuristics.
 */
export function extractMetadata(opts?: MetadataExtractorOptions): ArticleMetadata {
  const doc = opts?.doc ?? document;
  const url = opts?.url ?? doc.URL ?? "";

  const jsonLd = parseJsonLd(doc);

  return {
    title: resolveTitle(doc, jsonLd),
    author: resolveAuthor(doc, jsonLd),
    publicationDate: resolvePublicationDate(doc, jsonLd),
    sourceUrl: resolveSourceUrl(doc, url),
    siteName: resolveSiteName(doc, jsonLd, url),
  };
}

// ---------------------------------------------------------------------------
// JSON-LD Parsing
// ---------------------------------------------------------------------------

interface JsonLdData {
  readonly name?: string;
  readonly headline?: string;
  readonly author?: { name?: string } | string;
  readonly datePublished?: string;
  readonly publisher?: { name?: string } | string;
}

function parseJsonLd(doc: Document): JsonLdData | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const articleTypes = new Set(["Article", "NewsArticle", "BlogPosting", "WebPage"]);
  let fallback: JsonLdData | null = null;

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      // Handle both single objects and arrays
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object") {
          // Prefer article-type entries
          if (articleTypes.has(item["@type"])) {
            return item as JsonLdData;
          }
          // Keep first item with headline or name as fallback
          if (!fallback && (item.headline || item.name)) {
            fallback = item as JsonLdData;
          }
        }
      }
    } catch {
      // Invalid JSON — skip this script tag
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Field Resolvers
// ---------------------------------------------------------------------------

/**
 * title: og:title → JSON-LD name/headline → document.title → ""
 */
function resolveTitle(doc: Document, jsonLd: JsonLdData | null): string {
  const ogTitle = getMetaContent(doc, 'meta[property="og:title"]');
  if (ogTitle) return ogTitle;

  const jsonLdTitle = jsonLd?.headline ?? jsonLd?.name;
  if (jsonLdTitle && typeof jsonLdTitle === "string" && jsonLdTitle.trim()) {
    return jsonLdTitle.trim();
  }

  return doc.title?.trim() ?? "";
}

/**
 * author: article:author (OG) → JSON-LD author.name → meta[name="author"] → null
 */
function resolveAuthor(doc: Document, jsonLd: JsonLdData | null): string | null {
  const ogAuthor = getMetaContent(doc, 'meta[property="article:author"]');
  if (ogAuthor) return ogAuthor;

  if (jsonLd?.author) {
    const author = jsonLd.author;
    if (typeof author === "string" && author.trim()) {
      return author.trim();
    }
    if (typeof author === "object" && author.name && author.name.trim()) {
      return author.name.trim();
    }
  }

  const metaAuthor = getMetaContent(doc, 'meta[name="author"]');
  if (metaAuthor) return metaAuthor;

  return null;
}

/**
 * publicationDate: article:published_time (OG) → JSON-LD datePublished → meta[name="date"] / time[datetime] → null
 */
function resolvePublicationDate(doc: Document, jsonLd: JsonLdData | null): string | null {
  const ogDate = getMetaContent(doc, 'meta[property="article:published_time"]');
  if (ogDate) return ogDate;

  if (jsonLd?.datePublished && typeof jsonLd.datePublished === "string" && jsonLd.datePublished.trim()) {
    return jsonLd.datePublished.trim();
  }

  const metaDate = getMetaContent(doc, 'meta[name="date"]');
  if (metaDate) return metaDate;

  const timeEl = doc.querySelector("time[datetime]");
  if (timeEl) {
    const datetime = timeEl.getAttribute("datetime");
    if (datetime && datetime.trim()) return datetime.trim();
  }

  return null;
}

/**
 * sourceUrl: og:url → canonical link → provided url
 */
function resolveSourceUrl(doc: Document, url: string): string {
  const ogUrl = getMetaContent(doc, 'meta[property="og:url"]');
  if (ogUrl) return ogUrl;

  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) {
    const href = canonical.getAttribute("href");
    if (href && href.trim()) return href.trim();
  }

  return url;
}

/**
 * siteName: og:site_name → JSON-LD publisher.name → meta[name="application-name"] → hostname
 */
function resolveSiteName(doc: Document, jsonLd: JsonLdData | null, url: string): string {
  const ogSiteName = getMetaContent(doc, 'meta[property="og:site_name"]');
  if (ogSiteName) return ogSiteName;

  if (jsonLd?.publisher) {
    const publisher = jsonLd.publisher;
    if (typeof publisher === "string" && publisher.trim()) {
      return publisher.trim();
    }
    if (typeof publisher === "object" && publisher.name && publisher.name.trim()) {
      return publisher.name.trim();
    }
  }

  const appName = getMetaContent(doc, 'meta[name="application-name"]');
  if (appName) return appName;

  return extractHostname(url);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMetaContent(doc: Document, selector: string): string | null {
  const el = doc.querySelector(selector);
  if (!el) return null;
  const content = el.getAttribute("content");
  if (!content || !content.trim()) return null;
  return content.trim();
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
