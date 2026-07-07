# Requirements — Distill v3

## Overview

Distill is a Firefox browser extension (Manifest V3) that extracts the readable content of any web page, generates an AI summary via a sidebar chat interface, supports follow-up Q&A with streaming responses, and exports a unified Markdown document. It targets Firefox 109+ and uses `browser.*` promise APIs exclusively.

---

## 1. Extension Structure

**1.1** The extension SHALL run across four isolated browser contexts: a persistent background page, a per-tab content script, a sidebar panel, and an options page.

**1.2** The extension action icon SHALL toggle the sidebar panel via `browser.sidebarAction.toggle()`.

**1.3** The manifest SHALL declare `manifest_version: 3`, target Firefox 109+ (`gecko.strict_min_version: "109.0"`), and request the `storage`, `activeTab`, `downloads`, and `alarms` permissions plus `<all_urls>` host permissions.

**1.4** All four contexts SHALL communicate only via typed message passing — one-shot messages for request/response and a long-lived port named `"chat"` for the sidebar↔background streaming protocol.

---

## 2. Content Extraction

**2.1** When a new page loads in the active tab, the sidebar SHALL send an `init` message to the background, which SHALL extract the page content and reply with a `contextLoaded` message containing the article title, URL, extraction confidence (`high` | `medium` | `low`), whether a saved selector pattern exists for the site, and the estimated word count.

**2.2** Extraction SHALL use Mozilla's Readability library to isolate the main article body, then convert the resulting HTML to Markdown via Turndown + GFM plugin.

**2.3** When a saved CSS selector pattern exists for the current site's hostname, the content script SHALL first apply that selector to scope extraction; if the selector matches nothing it SHALL fall back to Readability and flag the pattern as stale.

**2.4** When confidence is `low`, the sidebar SHALL display a hint offering the user the ability to select a content element with the element picker.

**2.5** The element picker SHALL overlay the page with a highlight and let the user click any element to generate a CSS selector; upon selection it SHALL save that selector as a site pattern and re-extract.

**2.6** Extraction SHALL NOT occur on `about:`, `moz-extension:`, or `chrome:` URLs; those SHALL result in a `contextError`.

**2.7** The extraction attempt SHALL time out after 10 seconds if the content script does not respond.

**2.8** The background SHALL support a 500 ms settling delay after tab navigation before attempting extraction to allow the content script to initialize.

**2.9** The content script SHALL compute `bodyCharacterCount` as the character count of the extracted Markdown body; the background SHALL derive a word count as `Math.round(bodyCharacterCount / 5)` and include it in `contextLoaded`.

---

## 3. Multi-Tab Conversation Context

**3.1** Each sidebar session SHALL maintain a context tab set: zero, one, or many browser tabs whose extracted content is included in AI prompts.

**3.2** When the active tab URL is `about:blank`, the sidebar SHALL enter **persona-chat** mode with an empty context set (no extraction, no Summarize button, chat input enabled).

**3.3** The user SHALL be able to add any open browser tab to the context via a tab picker chip strip; the background SHALL extract and store the content of each added tab.

**3.4** The user SHALL be able to remove any context tab via a dismiss button on its chip; the controller SHALL delete the tab's content from the context set.

**3.5** When a tab fails to extract, the controller SHALL send a `contextTabFailed` message so the sidebar can display an error without blocking the rest of the context set.

**3.6** When the user navigates the active tab to a new URL, the sidebar SHALL reset its local state and request a new `init` from the background, discarding the prior context set.

**3.7** The controller SHALL cache the conversation and context for each tab by `tabId`; revisiting a tab within the same browser session SHALL restore the conversation without re-extracting.

---

## 4. AI Summarization

**4.1** Summarization SHALL only begin when the user explicitly clicks the **Summarize** button; the extension SHALL NOT auto-summarize on page load.

**4.2** The background SHALL stream the summarization response token-by-token to the sidebar via `streamToken` port messages; the sidebar SHALL append tokens to the partial content in-place without a full DOM rebuild.

**4.3** The default system prompt SHALL structure the summary with **Findings**, **Key Points**, and **Action Items** sections in Markdown.

**4.4** When one or more skills are active, the composite skill system prompt SHALL replace the default system prompt (see §7).

**4.5** The sidebar SHALL display an estimated reading time badge (`~N min read`, where N = `ceil(wordCount / 200)`) in the pre-summary state, using the word count from `contextLoaded`.

**4.6** After the first summary appears, the sidebar SHALL display a `✓ ~N min saved` hint below the conversation.

**4.7** The user SHALL be able to abort an in-progress stream at any time; partial content generated before abort SHALL be retained.

**4.8** When the AI endpoint is not yet configured, the background SHALL send a non-blocking `configError` warning after extraction completes; summarization and Q&A SHALL fail gracefully until the endpoint is configured.

---

## 5. Q&A Chat

**5.1** After the initial summary is displayed, the user SHALL be able to send follow-up messages; each reply SHALL stream back via the same `streamToken` / `streamEnd` protocol.

**5.2** The full conversation history SHALL be included in the context for every subsequent message so the AI has memory of prior turns.

**5.3** The AI context for Q&A SHALL include: system prompt (or composite skill prompt), page content from all context tabs, prior conversation messages, and the new user message.

**5.4** The user message input SHALL accept up to 2000 characters.

**5.5** On stream error, the sidebar SHALL display a Retry button; after 3 consecutive failures, retry SHALL be disabled.

**5.6** The user SHALL be able to abort mid-stream; the partial response SHALL be saved to conversation history as a partial message.

---

## 6. Export

**6.1** The user SHALL be able to export the page content (plus optionally the summary and Q&A) as a single Markdown document.

**6.2** Exported documents SHALL begin with YAML frontmatter containing a configurable subset of: `title`, `author`, `source_url`, `publication_date`, `capture_date`, `site_name`.

**6.3** Frontmatter values containing YAML-special characters (`:`, `#`, quotes, newlines) SHALL be double-quoted using JSON-compatible escaping.

**6.4** The export filename SHALL be generated from a configurable pattern (default `YYYY-MM-DD-slugified-title`).

**6.5** Export destinations SHALL include **Download** (via `browser.downloads.download`) and **Clipboard** (via the sidebar's document.execCommand or clipboard API, delegated through the port).

**6.6** Multiple destinations MAY be requested in a single export; each outcome SHALL be reported independently.

**6.7** The export manager SHALL re-extract content at export time if no cached content is available for the tab.

---

## 7. Skills System

**7.1** A **skill** is a user-supplied Markdown file with YAML frontmatter (`name`, `description`) and `##` sections: `Personality` (required), `Knowledge`, `Commands`, `Activation`, and arbitrary extras.

**7.2** The background SHALL parse skill files and validate that `name`, `description`, and `Personality` are present; parse errors SHALL be reported as `skillError` messages to the sidebar.

**7.3** Skills SHALL be stored in `browser.storage.local` under the key `distill_skill_library` as a versioned `SkillLibrary` object containing skills, personas, and an active selection.

**7.4** When a skill is activated, the controller SHALL build a composite system prompt: `Personality` content (no header) → `Knowledge` section → `Page Context` section (article title, URL, body ≤50 000 chars) → `Commands` section → extra sections, separated by `\n\n---\n`.

**7.5** Multiple skills MAY be composed: personalities are merged (base + "You also incorporate…" suffixes), knowledge and commands are concatenated, page context sections are combined, extra sections are merged by name.

**7.6** A **persona** is a named combination of one or more skill IDs; activating a persona activates all its skills as a composed set.

**7.7** When a skill has an `Activation` section, its content SHALL be sent as the first assistant message in the conversation upon activation.

**7.8** The options page SHALL allow loading skill files, viewing the library, creating/editing/deleting personas, and activating skills or personas.

---

## 8. Auto-Export

**8.1** The user SHALL be able to enable auto-export for any site origin; the configuration SHALL specify an interval in minutes, destination (download or clipboard), mode (`content-only` or `full`), and a `skipIfUnchanged` flag.

**8.2** Auto-export SHALL use `browser.alarms` with the alarm name `auto-export-{tabId}`.

**8.3** When `skipIfUnchanged` is true, the scheduler SHALL compute an MD5 hash of the exported content and skip export if the hash matches the last captured hash.

**8.4** When a tab finishes loading (`onUpdated` status `complete`), the background SHALL check whether the tab's origin has an enabled auto-export config and schedule or cancel the alarm accordingly.

**8.5** When a tab is closed, its auto-export alarm SHALL be cancelled.

**8.6** If the tab's origin changes while an auto-export alarm is active, the alarm SHALL be cancelled.

**8.7** The sidebar SHALL display auto-export status (last capture time, next fire time) when auto-export is active for the current tab.

---

## 9. Site Patterns

**9.1** A **site pattern** is a URL match pattern (`*://hostname/*`) paired with a CSS content selector; patterns have a `source` of `builtin` or `user`.

**9.2** Built-in patterns SHALL be seeded on first use: one for `*.medium.com` targeting `article`, and a generic fallback targeting `article` on all URLs.

**9.3** User-created patterns SHALL be saved to settings and applied at extraction time.

**9.4** The options page SHALL allow users to view, add, edit, and delete site patterns.

**9.5** When Readability is used as a fallback because a saved selector no longer matches, the pattern SHALL be marked `stale: true` in settings.

---

## 10. Settings

**10.1** Settings SHALL be persisted in `browser.storage.sync` (with a fallback read from `browser.storage.local`) under the key `"settings"`.

**10.2** The settings schema SHALL be versioned (`schemaVersion: 1`).

**10.3** Settings SHALL include: AI config (`baseUrl`, `modelId`, `apiKeyRef`, `systemPrompt`), export config (`filenamePattern`, `defaultDestination`, `frontmatterFields`), site patterns, and auto-export configs.

**10.4** API keys SHALL be stored separately in a secure store (using `browser.storage.local` with a `distill_secrets_` prefix) and referenced by a key ref rather than stored inline in settings.

**10.5** The options page SHALL provide a **Test Connection** button that sends a minimal API request to validate the AI endpoint configuration; the result SHALL be displayed inline.

**10.6** The options page SHALL allow the user to configure the AI base URL, model ID, API key, custom system prompt, export filename pattern, frontmatter fields, export destination, site patterns, auto-export rules, skills, and personas.

---

## 11. Projection Mode

**11.1** The sidebar SHALL support a **projection mode** toggle that hides non-essential controls to present a clean reading/chat view.

**11.2** In projection mode, ONLY the following elements SHALL be hidden: the skill chooser button (`btn-choose-skill`), avatar controls (`avatar-controls`), and avatar error messages (`avatar-error`).

**11.3** All other UI elements — including context chips, config warnings, low-confidence hints, auto-export status, and skill errors — SHALL remain visible in projection mode.

**11.4** Projection mode SHALL persist across tab changes via `browser.storage.local` under key `distill_projection_mode`.

---

## 12. Bot Avatar

**12.1** The user SHALL be able to upload a custom image as the bot avatar, displayed next to assistant messages.

**12.2** The avatar image SHALL be stored as a data URI in `browser.storage.local` under `distill_bot_avatar`.

**12.3** Avatar validation SHALL reject files that are not image MIME types or exceed a reasonable size limit; errors SHALL be displayed inline.

---

## 13. Testing

**13.1** All modules with injected dependencies SHALL have unit tests using `vitest` with the `jsdom` environment.

**13.2** Core algorithms SHALL have property-based tests using `fast-check` to verify invariants across random inputs.

**13.3** Cross-module flows (settings → controller, extraction → export) SHALL have integration tests.

**13.4** Tests SHALL use dependency injection throughout — no direct `browser.*` API calls in test code; all external deps are injected and mocked.

**13.5** The test suite SHALL pass in full (`npm test`) with no failures.
