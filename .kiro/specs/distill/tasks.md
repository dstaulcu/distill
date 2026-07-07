# Tasks — Distill v3

Implementation order follows dependency layers: shared types → content extraction → background modules → sidebar → options → tests.

---

## Phase 1: Project Scaffold

- [ ] 1. Initialize npm project with TypeScript, Vite, and vitest
  - `npm init -y` + install dev deps: `typescript`, `vite`, `vite-plugin-web-extension`, `vitest`, `jsdom`, `@vitest/globals`, `fast-check`
  - Install runtime deps: `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`
  - Configure `tsconfig.json` with `strict: true`, `moduleResolution: bundler`, path aliases for `@shared`, `@background`, `@content`, `@sidebar`, `@options`
  - Configure `vite.config.ts` using `vite-plugin-web-extension` pointing at `manifest.json`
  - Configure `vitest.config.ts` with `environment: "jsdom"`, `globals: true`, same path aliases

- [ ] 2. Create `manifest.json`
  - `manifest_version: 3`, name `"Distill"`, version `"3.0.0"`
  - `browser_specific_settings.gecko.id: "distill@example.com"`, `strict_min_version: "109.0"`
  - Permissions: `storage`, `activeTab`, `downloads`, `alarms`; host permissions: `<all_urls>`
  - `background.scripts: ["src/background/main.ts"]`
  - `content_scripts`: matches `<all_urls>`, js `["src/content/main.ts"]`
  - `sidebar_action.default_panel: "src/sidebar/sidebar.html"`
  - `options_ui.page: "src/options/options.html"`, `open_in_tab: true`
  - `action` (browser action to toggle sidebar)

- [ ] 3. Create `src/global.d.ts`
  - Declare `browser` namespace (Firefox WebExtensions API) — use `webextension-polyfill` types or declare minimal `browser.*` shapes used by the project

---

## Phase 2: Shared Types and Utilities

- [ ] 4. Create `src/shared/types.ts`
  - `Result<T, R>` discriminated union
  - `Settings`, `AiConfig`, `ExportConfig`, `SitePattern`, `ExportDestination`, `AutoExportConfig`, `AutoExportMode`
  - `Conversation`, `ConversationMessage`
  - `ExtractedArticle` (with `bodyCharacterCount`)
  - `TabContextEntry`, `TabState`
  - `SkillDefinition`, `SkillParseResult`, `StoredSkill`, `Persona`, `ActiveSelection`, `SkillLibrary`

- [ ] 5. Create `src/shared/messages.ts`
  - `Message<K, P>` envelope interface
  - All payload interfaces: `ExtractRequestedPayload`, `ExtractResultPayload`, `ExportRequestedPayload`, `ExportResultPayload`, `ClipboardWritePayload`, `ClipboardResultPayload`, `PickerActivatePayload`, `PickerResultPayload`, `ConnectionTestPayload`, `ConnectionTestResultPayload`, `PatternSavePayload`, `PatternSaveResultPayload`, `SettingsChangedPayload`, `AutoExportConfigSavePayload`, `AutoExportConfigDeletePayload`, `AutoExportStatusQueryPayload`, `AutoExportStatusResultPayload`
  - `MessagePayloadMap` mapping kind strings to payload types
  - Helpers: `buildMessage()`, `isAnyMessage()`, `isMessageOfKind()`, `sendToBackground()`, `sendToTab()`

- [ ] 6. Create `src/shared/port-protocol.ts`
  - `SidebarToControllerMessage` discriminated union (all `type` variants listed in design)
  - `ControllerToSidebarMessage` discriminated union (all `type` variants listed in design)
  - `PortConversationMessage`, `AutoExportPortConfig`, `PortAutoExportStatus`
  - `SkillLibrarySnapshot`, `ActiveSelectionPort`
  - `isSidebarToControllerMessage()`, `isControllerToSidebarMessage()` type guards
  - `contextLoaded` MUST include `readonly wordCount: number`

- [ ] 7. Create `src/shared/url-utils.ts`
  - `slugify(text)` — lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing `-`
  - Any other URL helpers needed by filename generation

- [ ] 8. Create `src/shared/skill-parser.ts`
  - `parseSkillFile(raw)` — parse YAML frontmatter (regex-based, no external YAML library required), extract `name` and `description`
  - `extractSections(body)` — parse `## SectionName` sections into a `Map<string, string>`
  - Validate required fields: `name`, `description`, `Personality`
  - Build `SkillDefinition` with `systemPrompt` (from `buildSkillSystemPrompt`)
  - `buildSkillSystemPrompt(skill)` — concatenate personality + knowledge + commands + extras with `---` separators, omit empty sections, NEVER include activation

- [ ] 9. Create `src/shared/composite-prompt.ts`
  - `buildCompositePrompt({ skill?, skills?, article?, articles? })` → string
  - Merge personalities, knowledge, commands, extras across multiple skills
  - Inject page context section (`## Page Context`) between knowledge and commands
  - Multi-article format: one `### Title\nURL: …\n\nbodyMarkdown` subsection per article
  - Truncate each article body to 50 000 chars
  - Omit empty sections entirely

---

## Phase 3: Content Script

- [ ] 10. Create `src/content/extractor/metadata.ts`
  - `extractMetadata({ doc, url })` → `{ title, author, publicationDate, sourceUrl, siteName }`
  - Sources: `<meta>` tags (og:title, og:site_name, article:author, article:published_time), `<title>`, `<h1>`, `document.URL`

- [ ] 11. Create `src/content/extractor/readability-wrapper.ts`
  - `extractWithReadability({ doc, url })` → `{ ok: true, result: { content, textContent }, confidence } | { ok: false }`
  - Confidence: `high` (textContent ≥ 500 chars), `medium` (≥ 100), `low` (< 100)
  - Clone document before passing to Readability (Readability mutates the DOM)

- [ ] 12. Create `src/content/extractor/dom-to-markdown.ts`
  - `domToMarkdown(html)` → `{ markdown, bodyCharacterCount }`
  - Use Turndown with GFM plugin (tables, strikethrough, task lists)
  - `bodyCharacterCount` = `markdown.length`

- [ ] 13. Create `src/content/extractor/extract.ts`
  - `extract(opts?)` → `ExtractionResult`
  - Path A (selector provided): `querySelector` → found → scoped Readability → domToMarkdown; not found → Readability fallback + `stalePattern: true`
  - Path B (no selector): Readability → domToMarkdown
  - `createScopedDocument(element, url)` helper — wraps element innerHTML in minimal HTML doc
  - Append `extractMetadata()` to all paths

- [ ] 14. Create `src/content/selector-generator.ts`
  - `generateSelector(element)` → CSS selector string
  - Priority: `#id` → `[data-testid]` / `[data-id]` → positional nth-child path
  - Must produce a selector that matches exactly one element in the document

- [ ] 15. Create `src/content/element-picker.ts`
  - `createElementPicker()` → `{ activate(), deactivate() }`
  - Overlay approach: on `activate()`, add a highlight `div` that follows mouse; on click, call `generateSelector(element)` and resolve with the result
  - Clean up listeners and overlay on `deactivate()` or after selection

- [ ] 16. Create `src/content/main.ts`
  - Listen for `extractRequested` → call `extract({ contentSelector, doc: document, url })` → return `extractResult`
  - Listen for `pickerActivate` → call `createElementPicker().activate()` → return `pickerResult`

---

## Phase 4: Background Modules

- [ ] 17. Create `src/background/settings/defaults.ts`
  - `BUILTIN_SITE_PATTERNS`: medium.com → `article`, generic `*://*/*` → `article`
  - `DEFAULT_SETTINGS` object with `schemaVersion: 1`, empty AI config, default export config, builtin patterns, empty auto-export configs
  - `SETTINGS_STORAGE_KEY = "settings"`

- [ ] 18. Create `src/background/settings/manager.ts`
  - `createSettingsManager()` → `SettingsManager` with `get()`, `update(partial)`, `reset()`
  - Load from `storage.sync`; fallback to `storage.local`; merge with defaults
  - `update()` validates and merges partial updates; returns `{ ok, errors? }`
  - Validation: URL pattern format, positive interval values, etc.

- [ ] 19. Create `src/background/secure-store.ts`
  - `createSecureStore()` → `{ getSecret(ref), setSecret(ref, value), deleteSecret(ref) }`
  - Storage key: `distill_secrets_{ref}` in `storage.local`

- [ ] 20. Create `src/background/tab-state.ts`
  - `createTabStateManager()` → `TabStateManager` with `get(tabId)`, `set(tabId, state)`, `update(tabId, partial)`, `remove(tabId)`
  - In-memory `Map<number, TabState>`

- [ ] 21. Create `src/background/site-patterns/matcher.ts`
  - `matchSitePattern({ patterns, url })` → `{ ok: true, pattern } | { ok: false }`
  - Match against `urlMatchPattern` using glob-to-regexp or manual `*` wildcard expansion
  - Return first matching pattern (user patterns take priority over builtin)

- [ ] 22. Create `src/background/render/frontmatter.ts`
  - `renderFrontmatter({ article, captureDate, fields })` → `FrontmatterResult`
  - `FIELD_MAP`: title, author, source_url, publication_date, capture_date, site_name
  - `needsQuoting(value)`: true if contains `:`, `#`, quotes, newlines, or has leading/trailing whitespace
  - `quoteValue(value)`: `JSON.stringify(value)`
  - Omit fields with null/undefined/empty values

- [ ] 23. Create `src/background/render/filename.ts`
  - `generateFilename({ article, captureDate, pattern })` → `{ ok: true, filename } | { ok: false }`
  - Pattern tokens: `YYYY`, `MM`, `DD`, `slugified-title`
  - Append `.md` extension
  - Sanitize result for filesystem safety

- [ ] 24. Create `src/background/ai/client.ts`
  - `createAiClient({ baseUrl, apiKey, model })` → `{ testConnection() }`
  - `testConnection()`: send a minimal chat completion request (1 token max); return `Result`

- [ ] 25. Create `src/background/chat/streaming-client.ts`
  - `createStreamingClient({ baseUrl, apiKey })` → `StreamingAiClient`
  - `streamChatCompletion({ model, messages, signal, onToken })` → `StreamResult`
  - Implement SSE parsing over `fetch` with `AbortSignal`
  - Parse `data: {"choices":[{"delta":{"content":"..."}}]}` lines
  - Accumulate `partialContent`; on stream end return `{ ok: true, content }`
  - On abort: return `{ ok: false, reason: "aborted", partialContent }`
  - On network/parse error: return `{ ok: false, reason: "stream-error", detail, partialContent }`

- [ ] 26. Create `src/background/auto-export/hasher.ts`
  - `hashContent(content)` → hex string
  - Use MD5 (can use `md5` npm package or manual implementation)

- [ ] 27. Create `src/background/auto-export/filename.ts`
  - Auto-export specific filename helpers (timestamp-based, distinct from manual export)

- [ ] 28. Create `src/background/auto-export/scheduler.ts`
  - `createAutoExportScheduler({ alarms, extractContent, exportContent, getAutoExportConfig, hashContent? })` → `AutoExportScheduler`
  - Alarm name: `auto-export-{tabId}`
  - `scheduleForTab(tabId, origin)`: load config → `alarms.create(name, { periodInMinutes })`; initialize status entry
  - `cancelForTab(tabId)`: `alarms.clear(name)`; remove status entry
  - `handleAlarm(alarm)`: parse tabId → check config still enabled → extractContent → hash (if skipIfUnchanged) → exportContent → update status
  - `getStatus(tabId)` / `isActiveForTab(tabId)` from internal map

- [ ] 29. Create `src/background/skill-state.ts`
  - Helpers for reading/writing active skill selection to storage

- [ ] 30. Create `src/background/skill-library.ts`
  - `createSkillLibraryManager()` → `SkillLibraryManager`
  - `addSkill(skill)`: assign `id` (uuid or timestamp-based), save to library
  - `activateSkill(id)` / `activatePersona(id)` / `deactivate()`
  - `getActiveSkills()` → `SkillDefinition[]` (resolved from active selection)
  - `getLibrary()` → `SkillLibrary`
  - `createPersona(name, description, skillIds[])` / `updatePersona(id, ...)` / `deletePersona(id)`
  - Storage key: `distill_skill_library`
  - `migrateSkillLibrary()` — idempotent migration from any older single-skill storage format

- [ ] 31. Create `src/background/export/manager.ts`
  - `createExportManager({ extractContent, getSettings, getConversation, deliverToDownload?, deliverToClipboard?, getCaptureDate? })` → `ExportManager`
  - `export(req)`:
    1. Re-extract if needed (for content)
    2. `renderFrontmatter` → `generateFilename`
    3. Assemble Markdown: frontmatter + `# title` + body + optional summary section + optional Q&A section
    4. Dispatch to each requested destination
  - Summary section header: `## Summary`; Q&A section header: `## Q&A`
  - Q&A format: each message as `**User:** text\n\n**Assistant:** text`

- [ ] 32. Create `src/background/chat/controller.ts`
  - `createChatController(opts)` → `ChatController` with `handleConnect(port)`
  - All logic scoped inside `handleConnect` closure (one closure per port connection)
  - Closure variables: `currentTabId`, `abortController`, `lastUserMessage`, `contextTabs: Map<number, ContextTabEntry>`, `activeSkills`
  - Implement all handlers per design doc: `handleInit`, `handleSummarize`, `handleSendMessage`, `doSendMessage`, `handleAbort`, `handleRetry`, `handleLoadSkill`, `handleGetLibrary`, `handleActivation`, `handleDeactivate`, `handleAddContextTab`, `handleRemoveContextTab`, `handleGetOpenTabs`
  - `ensureContextContent()`: lazy re-extract any context tab with `content === null`
  - `buildContextArticles()`: collect non-null content entries as `ExtractedArticle[]`
  - `MAX_CONSECUTIVE_FAILURES = 3`, `MAX_PAGE_CONTENT_CHARS = 50_000`
  - `buildDefaultSystemPrompt()` and `buildSummarizationUserMessage(articles)` as module-level helpers

- [ ] 33. Create `src/background/main.ts`
  - Initialize: `settingsManager`, `secureStore`, `tabState`, `skillLibraryManager`
  - Define `extractContent(tabId, selector?)` — tab URL guard, pattern lookup, 10s timeout race, stale pattern marking
  - Initialize `chatController`, `exportManager`, `scheduler`
  - Wire `browser.runtime.onMessage` → dispatch to named handlers for all one-shot message kinds
  - Wire `browser.runtime.onConnect` → intercept auto-export messages, delegate rest to `chatController.handleConnect`
  - Wire `browser.tabs.onRemoved` → `tabState.remove`, `scheduler.cancelForTab`, `sidebarPorts.delete`
  - Wire `browser.tabs.onUpdated` (status `complete`) → check origin for auto-export config → `scheduler.scheduleForTab` or `cancelForTab`
  - Wire `browser.alarms.onAlarm` → `scheduler.handleAlarm`
  - Wire `browser.action.onClicked` → `browser.sidebarAction.toggle()`
  - Clipboard delivery: sidebar port receives `clipboardWrite`, executes `document.execCommand("copy")`, replies `clipboardResult`
  - `migrateSkillLibrary()` on startup

---

## Phase 5: Sidebar

- [ ] 34. Create `src/sidebar/active-tab-tracker.ts`
  - `createActiveTabTracker(windowId, onActiveTabChanged)` → `ActiveTabTracker`
  - Listen to `browser.tabs.onActivated` — filter by windowId → call callback
  - Listen to `browser.tabs.onUpdated` (status `complete`) — filter by windowId + active tab → call callback
  - `destroy()` removes listeners

- [ ] 35. Create `src/sidebar/sidebar.html`
  - Minimal HTML: `<div id="app"></div>` + script tag loading `sidebar.ts`
  - Meta charset + viewport

- [ ] 36. Create `src/sidebar/sidebar.ts`
  - **State machine type** `SidebarState`: `loading | no-page | persona-chat | summarizing | ready | streaming | error | config-error` (exact shapes per design doc)
  - **Module-level state**: `state`, `autoExportStatus`, `port`, `tracker`, `consecutiveFailures`, `lastFailedMessage`, `currentTabId`, `hasSavedPattern`, `lowConfidence`, `pageWordCount`, `configWarning`, `botAvatarDataUri`, `avatarError`, `contextTabs`, `openTabsList`, `showTabPicker`, `activeSkillName`, `activeSkillDescription`, `skillError`, `librarySnapshot`, `projectionMode`
  - **`sendToController(msg)`**: post to port; guard for null port
  - **`resetLocalNav()`**: reset all local nav state to defaults, state → `loading`
  - **`setReadyPhase(msgs?)`**: transition to `ready` or `persona-chat` preserving phase
  - **`activatePicker(onPending, onCancel)`**: send `pickerActivate` message, handle response
  - **`render()`**: full DOM teardown + rebuild; render appropriate component per state; includes header, skill banner, context section in appropriate states, footer
  - **`streamToken` optimization**: patch partial content DOM node in-place; fall through to `render()` only for first token
  - **Port message handler**: switch on `msg.type`, update state/variables, call `render()`
  - **Init sequence**: batch `storage.local.get` for projection mode + bot avatar; connect port; init active tab tracker; send `init` to controller
  - **`renderReadyNoSummary()`**: context strip + article title (`.page-info-title`) + reading time badge (`.page-info-reading-time`) + Summarize button
  - **`renderContextSection()`**: chip strip with dismiss buttons + `＋` add button + dropdown when `showTabPicker`
  - **`renderMessages(messages, partial?)`**: render conversation history + optional streaming partial
  - **Reading time**: `pageWordCount !== null ? Math.max(1, Math.ceil(pageWordCount / 200)) : null`
  - **Time saved hint**: `✓ ~N min saved` in `.time-saved-hint` after summarization (ready + messages)
  - **Projection mode**: CSS class on `document.body`; hidden elements: `.btn-choose-skill`, `.avatar-controls`, `.avatar-error` ONLY

- [ ] 37. Create `src/sidebar/sidebar.css`
  - Full styles for all rendered components:
    - Header (title, reset/new-chat buttons, avatar)
    - Context chip strip (`.context-strip`, `.context-chip`, `.context-chip-title`, `.context-chip-remove`, `.context-chip-add`, `.tab-picker-dropdown`, `.tab-picker-item`, `.tab-picker-empty`, `.tab-picker-close`)
    - Page info (`.page-info`, `.page-info-title`, `.page-info-reading-time`, `.time-saved-hint`)
    - Ready no-summary (`.state-ready-no-summary`, `.ready-actions`, `.btn-summarize`)
    - Messages list (`.messages-list`, `.message`, `.message-user`, `.message-assistant`, `.message-content`, `.message-partial`)
    - Summarizing state (`.state-summarizing`, `.partial-content`)
    - Streaming controls
    - Error states
    - Config warning banner
    - Low confidence hint
    - Skill banner + skill section (`.skill-banner`, `.btn-choose-skill`, `.skill-section`)
    - Avatar controls
    - Auto-export section
    - Input area (`.input-area`, `.chat-textarea`)
    - Footer
    - Projection mode rules

---

## Phase 6: Options Page

- [ ] 38. Create `src/options/options.html`
  - Full page HTML with sections for: AI config, export config, site patterns, auto-export, skill library, persona management

- [ ] 39. Create `src/options/options.ts`
  - Load settings from storage (sync → local fallback → defaults)
  - Load skill library from `storage.local`
  - Sections:
    - **AI**: baseUrl, modelId, apiKey (write to secure store), systemPrompt, Test Connection button
    - **Export**: filenamePattern, defaultDestination radio, frontmatterFields checkboxes
    - **Site Patterns**: list with edit/delete, add new row
    - **Auto-Export**: list of configs with enable toggle, interval, destination, mode, skipIfUnchanged; add/remove
    - **Skills**: upload .md file → `parseSkillFile` → `loadSkill` message; list loaded skills with activate/delete
    - **Personas**: create from selected skills; list with activate/edit/delete
  - Save: send `settingsChanged` message to background; settings manager applies it

- [ ] 40. Create `src/options/options.css`
  - Form layout, section headings, table/list styles for patterns and skills

---

## Phase 7: Tests

- [ ] 41. Write unit tests for `src/shared/skill-parser.ts`
  - Valid skill parses to correct `SkillDefinition`
  - Missing `name`, `description`, `Personality` produce correct errors
  - Extras are captured correctly
  - `Activation` content is NOT included in `systemPrompt`

- [ ] 42. Write unit tests for `src/shared/composite-prompt.ts`
  - Single skill + single article produces expected section order
  - Empty sections are omitted
  - Multiple articles produce subsection format
  - Multiple skills merge correctly
  - `Activation` never appears in output

- [ ] 43. Write property-based tests for `src/shared/composite-prompt.ts`
  - Output never contains "Activation" section
  - Non-empty personality always appears in output
  - Page context section present iff articles array is non-empty

- [ ] 44. Write unit tests for `src/content/extractor/extract.ts`
  - Path A with matching selector → `confidence: "high"`
  - Path A with non-matching selector → Readability fallback, `stalePattern: true`
  - Path B → Readability used
  - Empty Readability result → `ok: false`

- [ ] 45. Write unit tests for `src/content/selector-generator.ts`
  - Element with id → `#id` selector
  - Element with `data-testid` → attribute selector
  - Nested element without id → nth-child path

- [ ] 46. Write property-based tests for `src/content/selector-generator.ts`
  - Generated selector matches exactly one element
  - Selector is stable (same element → same selector)
  - Elements with unique IDs produce `#id` format

- [ ] 47. Write unit tests for `src/background/render/frontmatter.ts`
  - All known fields render correctly
  - Values with special chars are quoted
  - Null/empty values are omitted
  - Empty fields array returns error

- [ ] 48. Write property-based tests for `src/background/render/frontmatter.ts`
  - Output is always valid YAML structure (starts/ends with `---`)
  - Values with YAML-special chars are always double-quoted

- [ ] 49. Write unit tests for `src/background/settings/manager.ts`
  - Load defaults when storage empty
  - Partial updates merge correctly
  - Invalid values produce validation errors

- [ ] 50. Write unit tests for `src/background/chat/controller.ts`
  - `init` with new URL → `contextLoaded` (no auto-summarize)
  - `init` with `about:blank` → `personaModeReady`
  - `init` with cached URL → `conversationRestored`
  - `summarize` → `streamStart` → `streamToken` × N → `streamEnd`
  - `summarize` with no context → `streamError`
  - `summarize` with AI unconfigured → `configError`
  - `sendMessage` → streams response, appends to conversation
  - `abort` mid-stream → `streamEnd` with partial content
  - `retry` after error → re-sends last message
  - `retry` disabled after 3 failures
  - `addContextTab` → `contextTabAdded`
  - `addContextTab` on failing tab → `contextTabFailed`
  - `removeContextTab` → `contextTabRemoved`
  - `loadSkill` → `skillLoaded` with activation message
  - `activateSkill` → `activationChanged`
  - Config warning sent after contextLoaded (non-blocking, no return)

- [ ] 51. Write integration tests for `src/background/chat/controller.ts`
  - Full init → explicit summarize → sendMessage flow
  - Init alone produces only `contextLoaded` (no `streamStart`)
  - Multi-tab context: add second tab → messages include both articles

- [ ] 52. Write property-based tests for `src/background/chat/controller.ts`
  - System prompt always starts with a system message
  - Page content included and truncated to 50k chars max
  - All prior conversation messages appear in order
  - New user message is always last in context

- [ ] 53. Write unit tests for `src/background/export/manager.ts`
  - Export includes frontmatter
  - Export without Q&A omits Q&A section
  - Export with Q&A includes all messages
  - Download destination calls `deliverToDownload`
  - Clipboard destination calls `deliverToClipboard`

- [ ] 54. Write unit tests for `src/background/auto-export/scheduler.ts`
  - `scheduleForTab` creates alarm with correct interval
  - `handleAlarm` calls extractContent + exportContent
  - `skipIfUnchanged: true` with same hash skips export
  - `skipIfUnchanged: true` with different hash triggers export
  - `cancelForTab` clears alarm and removes status

- [ ] 55. Write property-based tests for `src/background/auto-export/hasher.ts`
  - Same content always produces same hash
  - Different content produces different hash (collision resistance property)

- [ ] 56. Write unit tests for `src/sidebar/active-tab-tracker.ts`
  - `onActivated` in correct window fires callback
  - `onActivated` in different window is ignored
  - `onUpdated` (status complete) for active tab fires callback

- [ ] 57. Write property-based tests for `src/sidebar/active-tab-tracker.ts`
  - Only events matching the sidebar's windowId update the tracked tab

- [ ] 58. Write integration tests for settings persistence
  - Save → reload produces same settings
  - Partial update merges correctly with existing

- [ ] 59. Write integration tests for auto-export config persistence
  - Enable → disable removes config
  - Multiple origins stored independently

- [ ] 60. Write skill library E2E tests
  - Load skill → activate → messages use skill's system prompt
  - Persona with two skills → composed prompt includes both personalities

---

## Phase 8: Final Polish

- [ ] 61. Verify `npm test` passes with 0 failures

- [ ] 62. Verify `npm run build` produces a valid `dist/` directory

- [ ] 63. Load extension in Firefox via `about:debugging` and manually verify:
  - Sidebar opens on extension icon click
  - Navigating to a news article shows article title + `~N min read` badge
  - Clicking Summarize streams a summary
  - `✓ ~N min saved` hint appears after summarization
  - Follow-up Q&A works with streaming
  - Context chip strip shows the active tab; `＋` opens tab picker
  - Export (download) produces a valid Markdown file with YAML frontmatter
  - Options page saves AI config; Test Connection succeeds against a local endpoint
  - Loading a skill file changes the system prompt and shows activation greeting
  - Projection mode hides only skill chooser and avatar controls
  - `about:blank` shows persona-chat mode with no extraction errors
