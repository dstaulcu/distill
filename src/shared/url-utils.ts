/**
 * URL comparison helpers for session management.
 *
 * Used by the Active Tab Tracker and Background Script to determine
 * whether a navigation should reset the current session.
 *
 * - Fragment-only changes preserve the session.
 * - Origin, pathname, or query changes reset the session.
 */

/**
 * Returns true if two URLs differ only in fragment (hash).
 * Used to determine whether a navigation should reset the session.
 *
 * Compares origin + pathname + search (query string). If those are
 * identical, the navigation is considered same-page regardless of
 * any fragment difference.
 *
 * Returns false if either URL is malformed.
 */
export function isSamePageNavigation(oldUrl: string, newUrl: string): boolean {
  try {
    const oldParsed = new URL(oldUrl);
    const newParsed = new URL(newUrl);

    return (
      oldParsed.origin === newParsed.origin &&
      oldParsed.pathname === newParsed.pathname &&
      oldParsed.search === newParsed.search
    );
  } catch {
    return false;
  }
}

/**
 * Canonicalizes a URL by stripping the fragment for comparison purposes.
 * Returns origin + pathname + search (query string) without the hash.
 *
 * Returns the original string unchanged if it cannot be parsed.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
