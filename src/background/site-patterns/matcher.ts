/**
 * Site Pattern Matcher
 *
 * Evaluates URL match patterns against the current page URL to determine
 * which site pattern applies. User-defined patterns are evaluated first,
 * then built-in patterns. First match wins (array order).
 *
 * URL match patterns use the WebExtension match pattern syntax:
 *   <scheme>://<host>/<path>
 *   - scheme: *, http, https
 *   - host: *.example.com, example.com, *
 *   - path: any path with * wildcards
 */

import type { SitePattern } from "@shared/types";

// ---------------------------------------------------------------------------
// Public Interface
// ---------------------------------------------------------------------------

export interface SitePatternMatcherOptions {
  readonly patterns: ReadonlyArray<SitePattern>;
  readonly url: string;
}

export type MatchResult =
  | { readonly ok: true; readonly pattern: SitePattern }
  | { readonly ok: false };

// ---------------------------------------------------------------------------
// Built-in Patterns
// ---------------------------------------------------------------------------

export const BUILTIN_MEDIUM_PATTERN: SitePattern = {
  id: "builtin-medium",
  source: "builtin",
  urlMatchPattern: "*://*.medium.com/*",
  contentSelector: "article",
};

export const BUILTIN_GENERIC_FALLBACK_PATTERN: SitePattern = {
  id: "builtin-generic-fallback",
  source: "builtin",
  urlMatchPattern: "*://*/*",
  contentSelector:
    "article, [role='article'], main article, .post-content, .article-body, .entry-content, main, body",
};

export const BUILTIN_PATTERNS: ReadonlyArray<SitePattern> = [
  BUILTIN_MEDIUM_PATTERN,
  BUILTIN_GENERIC_FALLBACK_PATTERN,
];

// ---------------------------------------------------------------------------
// Match Pattern Parsing & Matching
// ---------------------------------------------------------------------------

interface ParsedMatchPattern {
  readonly schemePattern: string;
  readonly hostPattern: string;
  readonly pathPattern: string;
}

/**
 * Parses a WebExtension match pattern string into its components.
 * Returns null if the pattern is malformed.
 *
 * Valid format: <scheme>://<host>/<path>
 */
function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  const schemeEnd = pattern.indexOf("://");
  if (schemeEnd === -1) return null;

  const scheme = pattern.slice(0, schemeEnd);
  if (scheme !== "*" && scheme !== "http" && scheme !== "https") return null;

  const rest = pattern.slice(schemeEnd + 3);
  const pathStart = rest.indexOf("/");
  if (pathStart === -1) return null;

  const host = rest.slice(0, pathStart);
  const path = rest.slice(pathStart);

  if (host.length === 0) return null;

  return {
    schemePattern: scheme,
    hostPattern: host,
    pathPattern: path,
  };
}

/**
 * Tests whether a URL matches a parsed match pattern.
 */
function urlMatchesParsedPattern(
  url: URL,
  parsed: ParsedMatchPattern,
): boolean {
  // Scheme matching
  if (parsed.schemePattern !== "*") {
    if (url.protocol !== `${parsed.schemePattern}:`) return false;
  } else {
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  }

  // Host matching
  if (!hostMatches(url.hostname, parsed.hostPattern)) return false;

  // Path matching (url.pathname + url.search)
  const urlPath = url.pathname + url.search;
  if (!pathMatches(urlPath, parsed.pathPattern)) return false;

  return true;
}

/**
 * Matches a hostname against a host pattern.
 * Supports:
 *   - Exact match: "example.com"
 *   - Wildcard subdomain: "*.example.com" (matches any subdomain including nested)
 *   - All hosts: "*"
 */
function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;

  if (pattern.startsWith("*.")) {
    const baseDomain = pattern.slice(2);
    // Match the base domain itself or any subdomain
    return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
  }

  return hostname === pattern;
}

/**
 * Matches a URL path against a path pattern with * wildcards.
 * Each * matches zero or more characters.
 */
function pathMatches(path: string, pattern: string): boolean {
  // Convert the pattern to a regex
  // Escape regex special chars except *, then replace * with .*
  const regexStr =
    "^" +
    pattern
      .split("*")
      .map(escapeRegex)
      .join(".*") +
    "$";

  return new RegExp(regexStr).test(path);
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Main Matcher Function
// ---------------------------------------------------------------------------

/**
 * Evaluates site patterns against a URL and returns the first match.
 *
 * User-source patterns from `opts.patterns` are evaluated first in array
 * order, then the canonical BUILTIN_PATTERNS. Builtin-source entries inside
 * `opts.patterns` (seeded into stored settings by older versions) are ignored
 * so user patterns always win and exactly one builtin list applies (CF-6.2).
 *
 * Returns `{ ok: true, pattern }` if a match is found, or `{ ok: false }`
 * if no pattern matches (which should be rare given the generic fallback).
 */
export function matchSitePattern(opts: SitePatternMatcherOptions): MatchResult {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(opts.url);
  } catch {
    return { ok: false };
  }

  // Only match http/https URLs
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false };
  }

  const userPatterns = opts.patterns.filter((p) => p.source === "user");
  const allPatterns = [...userPatterns, ...BUILTIN_PATTERNS];

  for (const pattern of allPatterns) {
    if (patternMatchesParsedUrl(pattern, parsedUrl)) {
      return { ok: true, pattern };
    }
  }

  return { ok: false };
}

/**
 * Tests whether a single site pattern's URL match pattern applies to a URL.
 * Malformed patterns and non-http(s) URLs never match.
 */
export function patternMatchesUrl(pattern: SitePattern, url: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return false;
  }
  return patternMatchesParsedUrl(pattern, parsedUrl);
}

function patternMatchesParsedUrl(pattern: SitePattern, parsedUrl: URL): boolean {
  const parsed = parseMatchPattern(pattern.urlMatchPattern);
  if (parsed === null) return false; // Skip malformed patterns
  return urlMatchesParsedPattern(parsedUrl, parsed);
}
