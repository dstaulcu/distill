# REQUIREMENTS.md — Distill v3

> **Provenance.** Reconstructed 2026-07-02 by reading the full source tree and validating it
> against the original design spec in `.kiro/specs/distill/` (partially stale: requirement
> numbers cited in code comments, e.g. "Requirements: 14.4", refer to an older revision).
> All ambiguities found during reconstruction were resolved with the owner in an interview
> on 2026-07-03/04 — see [Resolved decisions](#resolved-decisions) at the bottom.
> **This file is the source of truth for intended behavior.** Where current code disagrees
> with a criterion below, the code is wrong (tracked in the Phase 2 audit), not the criterion.

## Purpose

Distill is a Firefox extension (Manifest V3, Firefox 109+) that extracts the readable content
of web pages, generates AI summaries through a sidebar chat with streaming responses (against
any OpenAI-compatible `/v1/chat/completions` endpoint), supports follow-up Q&A, and exports
unified Markdown documents — manually or on a schedule.

Deployment contexts (both must stay working):

- **Home**: Ollama backend — no API key; the empty-key path must work.
- **Work (fork)**: OpenAI-compatible service **requiring** an API key — the key path must
  genuinely authenticate.

Runtime constraints that apply everywhere:

- Four isolated contexts (persistent background page, per-tab content script, per-window
  sidebar, options page) communicate **only** via typed message passing: one-shot
  `runtime`/`tabs` messages (`@shared/messages.ts`) and a long-lived port named `"chat"`
  (`@shared/port-protocol.ts`).
- `browser.*` promise APIs exclusively; permissions `storage`, `activeTab`, `downloads`,
  `alarms`; host permissions `<all_urls>`.

---

## Core features

These must never break. Criteria are stated as observable behavior.

### CF-1 Content extraction

- **1.1** Given the sidebar opens (or the active tab changes) on an `http(s)` page, the
  background extracts the page and the sidebar receives `contextLoaded` with the article
  title, URL, extraction confidence (`high` | `medium` | `low`), whether a **user-saved**
  selector pattern exists for the site (built-in patterns do not count), and a word count
  (`Math.round(bodyCharacterCount / 5)`).
- **1.2** Extraction isolates the main article body with Mozilla Readability on a *clone* of
  the document, then converts HTML → Markdown via Turndown + GFM. Confidence is `high` when
  extracted text > 500 chars, `medium` ≥ 100, `low` otherwise.
- **1.3** Given a saved CSS selector pattern matches the current URL, extraction is scoped to
  that selector; if Readability on the scoped fragment yields < 100 chars of text, the raw
  `innerHTML` of the selected element is used instead.
- **1.4** Given a saved selector matches the URL but matches **no element** in the document,
  extraction falls back to whole-document Readability, and **only the user pattern that
  matched this URL** is flagged stale (surfaced as a "⚠ Stale" badge in the options page).
  Stale patterns continue to be matched on later visits — staleness is advisory, not
  disabling; the per-page Readability fallback handles repeat failures.
- **1.5** Given the tab URL starts with `about:`, `moz-extension:`, or `chrome:` (or the tab
  is inaccessible), extraction is refused and the sidebar shows a friendly "no page" state,
  not an error.
- **1.6** Given the content script does not respond within **10 seconds**, extraction fails
  with an error result (no hang). After tab navigation, the background waits **500 ms**
  before extracting so the content script can initialize.
- **1.7** Article metadata (title, author, publication date, source URL, site name) is
  resolved per-field through the priority chain: Open Graph → JSON-LD → meta tags → DOM
  heuristics.

### CF-2 AI summarization

- **2.1** Summarization starts **only** when the user clicks the Summarize button — never
  automatically on page load.
- **2.2** The response streams token-by-token to the sidebar (`streamStart` →
  `streamToken`* → `streamEnd`); the sidebar patches the partial-content DOM node in place
  rather than re-rendering per token.
- **2.3** With no skill active, the system prompt is the user's custom prompt from settings,
  or (if unset) the default prompt requiring **Findings / Key Points / Action Items**
  sections in Markdown.
- **2.4** Given extraction succeeded, the pre-summary view shows the article title and a
  `~N min read` badge where `N = max(1, ceil(wordCount / 200))`; after the first summary, a
  `✓ ~N min saved` hint appears.
- **2.5** The user can abort mid-stream; content streamed before the abort is retained in the
  conversation (marked partial) **and stays visible in the sidebar immediately** — for
  summaries exactly as for chat replies.
- **2.6** Given the AI endpoint is not configured, extraction and export still work; the
  sidebar shows a non-blocking configuration warning with a link to Settings, and
  Summarize/Q&A fail gracefully with a config error rather than a network error.
- **2.7** If no token arrives for **30 seconds** mid-stream, the request fails with a
  timeout error that carries the partial content received so far.

### CF-3 Q&A chat

- **3.1** After a summary exists (or in persona-chat mode), the user can send follow-up
  messages (≤ **2000** characters); each reply streams via the same protocol as CF-2.
- **3.2** Every request includes: the system prompt, the page content of all context tabs
  (each truncated to **50,000** chars), the full prior conversation in order, and the new
  user message last. A retried message appears **exactly once** in the prompt.
- **3.3** On stream error the sidebar shows the reason **alongside the existing
  conversation** (not replacing it) with a Retry button. The controller is the single
  source of truth for retry eligibility: retry is allowed while consecutive failures < 3,
  counted identically for summarize and Q&A paths; the sidebar obeys the controller's
  `canRetry` and keeps no independent count. Any success resets the failure count.
  A retried stream renders in the sidebar exactly like a first-attempt stream.
- **3.4** Conversations are cached per `tabId` for the browser session: revisiting a tab with
  an unchanged URL restores the conversation without re-extracting; navigating the active
  tab to a new URL resets it.
- **3.5** Chat content rendered to HTML (messages, streaming partials) is sanitized: HTML
  special characters **including quotes** are escaped, and links render only with `http:` /
  `https:` schemes — `javascript:` URLs and attribute injection must not execute.

### CF-4 Markdown export

- **4.1** Clicking Export produces a single Markdown document assembled in order:
  YAML frontmatter → `## Summary` (when included and available) → `## Q&A` (when included
  and non-empty) → `## Content` (always). The summary is the first assistant message of the
  conversation; Q&A is everything after it, formatted as `### Q:` / `### A:` heading blocks
  (canonical format — do not change silently; existing exports rely on it).
- **4.2** Frontmatter contains the configured subset of `title`, `author`, `source_url`,
  `publication_date`, `capture_date`, `site_name`, in configured order; fields with
  null/empty values are omitted; values containing `:`, `#`, quotes, newlines, or
  leading/trailing whitespace are double-quoted with JSON-compatible escaping. An empty
  configured field list is an error.
- **4.3** The filename comes from the configured pattern (default
  `YYYY-MM-DD-slugified-title`, UTC date parts, `.md` appended, total ≤ 100 chars, slug
  truncated without trailing hyphen). A title with no alphanumeric characters is an error
  when the pattern uses the slug token.
- **4.4** Destinations are **download** (`browser.downloads.download`) and **clipboard**
  (delegated to the sidebar via port message, 5 s timeout). The sidebar Export button uses
  the configured `export.defaultDestination`. Multiple destinations may be requested in one
  export; each outcome is reported independently and one failing does not block the others.
- **4.5** Export re-extracts the page at export time; extraction failure fails the export
  with a reason.

### CF-5 Settings & credentials

- **5.1** Settings (versioned `schemaVersion: 1`: AI config, export config, site patterns,
  auto-export configs) persist under key `"settings"` in `browser.storage.sync`, falling
  back to `browser.storage.local` when sync quota is exceeded — **on reads as well as
  writes**: `get()` returns the local copy when sync has none, so settings survive
  browser/extension restarts regardless of which store they landed in.
- **5.2** Updates are validated before persisting: base URL must start with `http(s)://`
  when non-empty; filename pattern non-empty; ≤ 50 user site patterns; auto-export interval
  an integer in [1, 120]. Invalid updates are rejected with per-field errors and persist
  nothing. **All settings writes — including from the options page — go through the
  settings manager**, which broadcasts changes to all contexts (an open sidebar sees new
  settings without reconnecting).
- **5.3** API keys are never stored in plaintext inside settings: the settings object holds
  only an opaque `apiKeyRef`; the key material lives separately in `browser.storage.local`,
  AES-GCM encrypted with a locally stored key. (Documented honestly as obfuscation-level
  protection — it prevents plaintext appearing in storage dumps, not access by code that
  can read extension storage.) Entering a key in the options page and saving **must** make
  subsequent AI requests send it as the Bearer token; leaving the key empty must keep
  keyless endpoints (Ollama) working.
- **5.4** The options page Test Connection button sends a minimal chat-completion request to
  the configured endpoint and reports success/failure inline within 10 s.

### CF-6 Site patterns & element picker

- **6.1** A site pattern pairs a WebExtension URL match pattern (`*://host/*` syntax;
  scheme `*|http|https`, host exact / `*.domain` / `*`, path `*` wildcards) with a CSS
  selector; source is `builtin` or `user`. Matching applies only to `http(s)` URLs.
- **6.2** **User patterns always take precedence over built-in patterns** when both match,
  regardless of storage order. There is exactly **one** canonical built-in list: the
  Medium pattern (`*://*.medium.com/*` → `article`) and the generic fallback
  (`*://*/*` → the rich selector chain
  `article, [role='article'], main article, .post-content, .article-body, .entry-content, main, body`).
- **6.3** When extraction confidence is `low`, the sidebar offers the element picker. The
  picker overlays the page, highlights the hovered element with tag/dimensions, and on click
  generates a stable CSS selector (`#id` → `data-testid`/`data-id` → positional path) that
  matches exactly one element.
- **6.4** A successful pick saves the selector as a user pattern for `*://<hostname>/*` and
  triggers re-extraction, which must then use the picked selector (per 6.2).
- **6.5** The options page lists user patterns with add/edit/delete, validates selector
  syntax, shows a stale badge for patterns flagged by 1.4, and shows a **live selector
  preview** (first ~500 chars of matched text from the active tab) while editing.

---

## Secondary features

Convenience features; regressions matter but are not release-blocking.

### SF-1 Multi-tab conversation context

- The sidebar shows a chip strip of context tabs; `＋` opens a picker of open tabs
  (excluding privileged pages and tabs already in context). Adding a tab extracts it and
  includes it in subsequent prompts; failures surface per-tab without blocking others;
  chips can be dismissed to remove a tab from context. Multi-article prompts render one
  titled subsection per article.

### SF-2 Persona-chat mode

- When the active tab is `about:blank` (or the user clicks "new chat" ✦), the sidebar enters
  persona-chat: no extraction, chat input always enabled, empty context set, conversation
  cached per tab like CF-3.4.

### SF-3 Skills & personas

- A skill file is Markdown with YAML frontmatter (`name`, `description` required) and `##`
  sections: `Personality` (required), `Knowledge`, `Commands`, `Activation`, plus arbitrary
  extras. Parse errors are reported to the user listing each missing field.
- The library (≤ 20 skills, ≤ 10 personas) persists in `browser.storage.local` under
  `distill_skill_library`; re-uploading a same-named skill replaces it, keeping its id. A
  persona is a named set of skill ids; deleting a skill removes it from personas and deletes
  personas left empty; deleting the active skill/persona deactivates it.
- Activating a skill/persona replaces the system prompt with the composite prompt:
  merged personalities (base + "You also incorporate…" suffixes) → `## Knowledge` →
  `## Page Context` (title, URL, body ≤ 50k chars per article) → `## Commands` → merged
  extras, joined by `---` separators, empty sections omitted, **Activation content never
  included in the prompt**.
- Activation/deactivation clears the current conversation; if the (first) skill has an
  `Activation` section, its content becomes the first assistant message. Activation state
  persists across sessions and an idempotent migration converts the legacy single-skill
  storage format on startup.
- Sidebar: dropdown to activate none/skill/persona, upload of `.md` files (≤ 512 KB).
  Options page: upload, list, delete skills; create/edit/delete personas.

### SF-4 Auto-export

- Per-origin config: enabled flag, interval (1–120 min), destination, mode (`content-only` |
  `full` = with Q&A), `skipIfUnchanged`. Enabling from the sidebar uses 15 min / download /
  content-only / skip-unchanged defaults. The options-page editor exposes the enabled
  toggle (a rule can be disabled without deleting it).
- Scheduling uses `browser.alarms` with name `auto-export-<tabId>`: scheduled when a tab
  whose origin has an enabled config finishes loading; cancelled when the tab closes or its
  origin changes; a disabled/removed config makes subsequent alarms no-ops.
- On each alarm: re-extract; with `skipIfUnchanged`, skip the export when the content hash
  equals the last **successfully exported** hash. The hash is FNV-1a (32-bit) over the
  **full** exported Markdown content (canonical algorithm — fast, non-cryptographic, fit
  for change detection). `lastHash` is updated **only after a successful export**, so a
  failed export is retried at the next alarm. Extraction/export failures increment a
  failure counter but never cancel the alarm.
- Auto-export filenames are `YYYY-MM-DD-HHmm-<slug>.md` (UTC) so periodic captures don't
  overwrite each other.
- The sidebar footer shows a toggle and, when active, last-capture and next-fire times as
  relative timestamps.

### SF-5 Bot avatar

- The user can upload an image (MIME `image/*`, ≤ 1 MB) shown beside the sidebar title;
  it persists as a data URI under `distill_bot_avatar` and can be removed. Validation errors
  display inline and do not overwrite the existing avatar.

### SF-6 Options-page conveniences

- Model dropdown populated from `GET <base>/v1/models` (silent failure, manual entry always
  possible; the saved model is appended as "(not found on server)" if absent).

### SF-7 Help menu (version & links)

- The sidebar header shows a Help control in every phase (loading, error, config-error
  included, not just when content is loaded). Opening it displays the installed extension
  version (read from the manifest) plus links to the project's GitHub Issues and Releases
  pages, opened in a new tab. It is purely static — no network call checks for a newer
  release. Opening/closing follows the same explicit toggle-button / close-button
  convention as the tab picker (SF-1); there is no outside-click-to-close.

---

## Testing requirements

- Every module with injected dependencies has unit tests (`*.test.ts`, vitest + jsdom);
  core algorithms have property-based tests (`*.prop.test.ts`, fast-check); cross-module
  flows have integration tests (`*.integration.test.ts`).
- No direct `browser.*` calls in tests — all external deps injected.
- `npm test` runs the entire suite and must pass with zero failures.

---

## Resolved decisions

Owner interview, 2026-07-03/04. Each Q refers to the ambiguity list from the original
reconstruction; the decisions are already folded into the criteria above.

| Q | Decision |
|---|----------|
| Q1 | API-key path must work (work fork requires it): options → background message → SecureStore; empty key keeps Ollama working. |
| Q2 | User patterns always win over builtins; one canonical builtin list using the rich fallback selector chain. |
| Q3 | Change-detection hash: FNV-1a over the **full** content (drop the 10k truncation); FNV-1a is canonical, not MD5. |
| Q4 | `lastHash` updates only after a **successful** export. |
| Q5 | Exported Q&A format stays `### Q:` / `### A:`; spec updated to match code. |
| Q6 | Controller is single source of truth for retry (< 3 consecutive failures, both paths identical); no sidebar-side counter; no duplicate message in the retried prompt. |
| Q7 | Fix retry rendering (streams render from any state reached via retry) **and** errors display alongside the conversation. |
| Q8 | Cancelled summaries keep the partial visible immediately, like chat aborts. |
| Q9 | Sanitize the markdown renderer in place: escape quotes, allow only `http(s):` link schemes. |
| Q10 | Options page routes all writes through the settings manager; add the missing auto-export enabled toggle. |
| Q11 | Keep SecureStore mechanism; correct documentation to "obfuscation-level" honesty. |
| Q12 | Settings `get()` falls back to reading `storage.local` when sync has nothing. |
| Q13 | Implement the `selectorPreview` message end-to-end (typed kind + content-script handler). |
| Q14 | Delete dead `skill-state.ts` and sidebar `lastFailedMessage`; fix the streaming-client timer leak (cancel timeout when read wins). |
| Q15 | `hasSavedPattern` means "a **user** pattern exists for this site". |
| Q16 | Stale flagging targets only the user pattern that matched the URL; matcher still matches stale patterns; badge is the signal. |
| Q17 | Sidebar Export button honors `export.defaultDestination`. |
| Q18 | Stale in-code requirement citations updated opportunistically to CF-x/SF-x IDs when files are touched. |
