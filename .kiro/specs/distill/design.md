# Design — Distill v3

## Extension Architecture

Four isolated browser contexts communicate exclusively via message passing:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│                                                                      │
│  ┌──────────────────────┐     port "chat"     ┌──────────────────┐  │
│  │  Sidebar             │ ◄──────────────────► │  Background      │  │
│  │  sidebar.ts          │   typed port msgs    │  main.ts         │  │
│  │  active-tab-tracker  │                      │  controller.ts   │  │
│  └──────────────────────┘                      │  export mgr      │  │
│                                                │  auto-export     │  │
│  ┌──────────────────────┐  one-shot msgs       │  settings mgr    │  │
│  │  Content Script      │ ◄──────────────────► │  skill library   │  │
│  │  main.ts             │  extractRequested    │  secure store    │  │
│  │  extractor/          │  pickerActivate      │  tab state       │  │
│  │  element-picker      │                      └──────────────────┘  │
│  └──────────────────────┘                                            │
│                                                                      │
│  ┌──────────────────────┐  one-shot msgs                             │
│  │  Options Page        │ ──────────────────►  Background            │
│  │  options.ts          │  settingsChanged     (same as above)       │
│  └──────────────────────┘  connectionTest                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Source Layout

```
src/
  global.d.ts                    # browser namespace type override
  shared/
    types.ts                     # Result<T,R>, Settings, ExtractedArticle, TabState, SkillDefinition, …
    messages.ts                  # One-shot message envelope, MessagePayloadMap, helpers
    port-protocol.ts             # SidebarToControllerMessage, ControllerToSidebarMessage, type guards
    composite-prompt.ts          # buildCompositePrompt(skills, articles) → string
    skill-parser.ts              # parseSkillFile(raw) → SkillParseResult
    url-utils.ts                 # URL helpers (slugify, etc.)
    storage.ts                   # Storage key constants
  background/
    main.ts                      # Entry point: wires all modules, routes messages and ports
    tab-state.ts                 # createTabStateManager() — in-memory map of tabId → TabState
    secure-store.ts              # createSecureStore() — read/write secrets via storage.local
    skill-library.ts             # createSkillLibraryManager() — CRUD + activation
    skill-state.ts               # Skill activation state helpers
    settings/
      manager.ts                 # createSettingsManager() — load/validate/update settings
      defaults.ts                # DEFAULT_SETTINGS, BUILTIN_SITE_PATTERNS
    chat/
      controller.ts              # createChatController() — port lifecycle, init/summarize/sendMessage/…
      streaming-client.ts        # createStreamingClient() — SSE streaming over fetch
    ai/
      client.ts                  # createAiClient() — testConnection()
    export/
      manager.ts                 # createExportManager() — assemble + dispatch Markdown
    render/
      frontmatter.ts             # renderFrontmatter() — YAML header generation
      filename.ts                # generateFilename() — pattern-based filename generation
    auto-export/
      scheduler.ts               # createAutoExportScheduler() — alarm-based periodic export
      hasher.ts                  # hashContent() — MD5 for change detection
      filename.ts                # Auto-export filename helpers
    site-patterns/
      matcher.ts                 # matchSitePattern() — URL glob matching
  content/
    main.ts                      # Content script entry: routes extractRequested + pickerActivate
    extractor/
      extract.ts                 # extract() — top-level orchestrator
      readability-wrapper.ts     # extractWithReadability()
      dom-to-markdown.ts         # domToMarkdown() — Turndown + GFM
      metadata.ts                # extractMetadata() — title, author, dates, site name
    selector-generator.ts        # generateSelector() — CSS selector from clicked element
    element-picker.ts            # createElementPicker() — overlay + click capture
  sidebar/
    sidebar.ts                   # Sidebar UI: state machine + render functions
    sidebar.css                  # All sidebar styles
    active-tab-tracker.ts        # createActiveTabTracker() — onActivated/onUpdated tracking
  options/
    options.ts                   # Options page: settings + library UI
    options.css                  # Options page styles
```

---

## Data Models

### `Settings` (persisted in `browser.storage.sync` under key `"settings"`)

```typescript
interface Settings {
  schemaVersion: 1;
  ai: {
    baseUrl: string;        // OpenAI-compatible base URL, e.g. "http://localhost:11434/v1"
    modelId: string;        // e.g. "llama3.2"
    apiKeyRef: string|null; // key into secure store; null = no key required
    systemPrompt: string;   // custom system prompt (overridden by skills)
  };
  export: {
    filenamePattern: string;          // default "YYYY-MM-DD-slugified-title"
    defaultDestination: ExportDestination;
    frontmatterFields: string[];      // ordered subset of known fields
  };
  sitePatterns: SitePattern[];
  autoExportConfigs: AutoExportConfig[];
}
```

### `SkillLibrary` (persisted in `browser.storage.local` under key `"distill_skill_library"`)

```typescript
interface SkillLibrary {
  schemaVersion: 1;
  skills: StoredSkill[];         // StoredSkill = SkillDefinition + { id, addedAt }
  personas: Persona[];           // { id, name, description, skillIds[], createdAt, updatedAt }
  active: ActiveSelection;       // { kind:"none" } | { kind:"skill", skillId } | { kind:"persona", personaId }
}
```

### `TabState` (in-memory, keyed by `tabId`)

```typescript
interface TabState {
  url: string;
  title: string;
  summary: string | null;
  conversation: Conversation;      // { tabId, url, title, messages[], createdAt, updatedAt }
  extractionConfidence: "high"|"medium"|"low"|null;
  consecutiveFailures: number;
}
```

### `ExtractedArticle`

```typescript
interface ExtractedArticle {
  title: string;
  author: string|null;
  publicationDate: string|null;
  sourceUrl: string;
  siteName: string;
  bodyMarkdown: string;
  bodyCharacterCount: number;   // character count of bodyMarkdown (used for word count estimate)
}
```

---

## Messaging Protocols

### One-Shot Messages (`browser.runtime.sendMessage` / `browser.tabs.sendMessage`)

Envelope: `{ kind: K, payload: P, requestId?: string }`

| kind | direction | purpose |
|---|---|---|
| `extractRequested` | background→content | trigger extraction, optional `selector` |
| `extractResult` | content→background | `{ ok, article?, confidence?, stalePattern?, reason?, detail? }` |
| `exportRequested` | sidebar→background | `{ tabId, includeQA, destinations[] }` |
| `exportResult` | background→sidebar | per-destination outcomes |
| `pickerActivate` | background→content | start element picker on `tabId` |
| `pickerResult` | content→background | `{ ok, selector?, previewText?, reason? }` |
| `settingsChanged` | options→background | full settings payload |
| `connectionTest` | options→background | `{ baseUrl, apiKey, modelId }` |
| `connectionTestResult` | background→options | `{ ok, reason?, detail? }` |
| `patternSave` | options→background | `{ origin, urlMatchPattern, contentSelector }` |
| `clipboardWrite` | background→sidebar | delegate clipboard write to sidebar context |
| `clipboardResult` | sidebar→background | success/failure of clipboard write |
| `autoExportConfigSave` | options→background | save/update auto-export config |
| `autoExportConfigDelete` | options→background | remove auto-export config |
| `autoExportStatusQuery` | sidebar→background | request current scheduler status |
| `autoExportStatusResult` | background→sidebar | `{ status: AutoExportStatus | null }` |

### Long-Lived Port (`browser.runtime.connect("chat")`)

**Sidebar → Controller** (`SidebarToControllerMessage`, discriminated on `type`):

| type | payload |
|---|---|
| `init` | `{ tabId, url? }` — url is `"about:blank"` for persona mode |
| `summarize` | _(none)_ — user clicked Summarize |
| `sendMessage` | `{ text }` |
| `abort` | _(none)_ |
| `retry` | _(none)_ |
| `loadSkill` | `{ raw }` — raw markdown skill file content |
| `clearSkill` | _(none)_ |
| `getLibrary` | _(none)_ |
| `activateSkill` | `{ skillId }` |
| `activatePersona` | `{ personaId }` |
| `deactivate` | _(none)_ |
| `addContextTab` | `{ tabId }` |
| `removeContextTab` | `{ tabId }` |
| `getOpenTabs` | _(none)_ |
| `autoExportEnable` | `{ config: AutoExportPortConfig }` |
| `autoExportDisable` | `{ origin }` |
| `autoExportStatusRequest` | `{ tabId }` |

**Controller → Sidebar** (`ControllerToSidebarMessage`, discriminated on `type`):

| type | payload |
|---|---|
| `contextLoaded` | `{ title, url, confidence, hasSavedPattern, wordCount }` |
| `contextError` | `{ reason, canRetry }` |
| `conversationRestored` | `{ messages[] }` — session cache hit |
| `personaModeReady` | `{ messages? }` — about:blank init |
| `streamStart` | _(none)_ |
| `streamToken` | `{ token }` |
| `streamEnd` | `{ fullContent }` |
| `streamError` | `{ reason, partialContent, canRetry }` |
| `configError` | `{ reason }` — non-blocking AI config warning |
| `skillLoaded` | `{ name, description, activation }` |
| `skillCleared` | _(none)_ |
| `skillError` | `{ errors[] }` |
| `libraryState` | `{ library: SkillLibrarySnapshot }` |
| `activationChanged` | `{ active, names[] }` |
| `contextTabAdded` | `{ tabId, url, title, confidence }` |
| `contextTabFailed` | `{ tabId, url, title, reason }` |
| `contextTabRemoved` | `{ tabId }` |
| `openTabs` | `{ tabs: [{tabId, title, url}[]] }` |
| `autoExportStatus` | `{ status: PortAutoExportStatus | null }` |

---

## Sidebar State Machine

```
                     ┌─────────┐
            init     │ loading │
         ──────────► │         │
                     └────┬────┘
                          │
           ┌──────────────┼─────────────────────┐
           │              │                      │
     contextError   contextLoaded        personaModeReady
           │              │                      │
           ▼              ▼                      ▼
      ┌─────────┐    ┌─────────┐         ┌──────────────┐
      │  error  │    │  ready  │         │ persona-chat  │
      └─────────┘    └────┬────┘         └──────┬───────┘
                          │ (messages=[])        │
                    summarize btn           sendMessage
                          │                      │
                          ▼                      ▼
                   ┌───────────┐         ┌─────────────┐
                   │summarizing│         │  streaming  │
                   └─────┬─────┘         └──────┬──────┘
                         │                      │
                    streamEnd              streamEnd
                         │                      │
                         ▼                      ▼
                   ┌─────────┐         ┌──────────────┐
                   │  ready  │         │ persona-chat  │
                   │(msgs≠[])│         │  (msgs≠[])   │
                   └─────────┘         └──────────────┘
```

Additional transitions:
- Any state + `configError` before `ready`: → `config-error`
- `ready` / `summarizing` / `persona-chat` + `configError`: set non-blocking `configWarning`, stay in phase
- `about:blank` URL → `persona-chat` (not `error`)
- Tab change → full reset to `loading`
- `conversationRestored` → `ready` with messages

---

## Content Extraction Pipeline

```
content script main.ts
  ├── receives extractRequested { tabId, selector? }
  └── calls extract({ contentSelector?, doc, url })
        ├── Path A: selector provided
        │     ├── querySelector(selector) → found?
        │     │     ├── YES: createScopedDocument(element) → extractWithReadability → domToMarkdown
        │     │     │         confidence = "high"
        │     │     └── NO:  extractWithReadability(doc) → domToMarkdown
        │     │               confidence = readability confidence, stalePattern = true
        │     └── extractMetadata(doc) → { title, author, publicationDate, sourceUrl, siteName }
        └── Path B: no selector
              └── extractWithReadability(doc) → domToMarkdown → extractMetadata
                    confidence = "high" | "medium" | "low" (from Readability article length)
```

**Confidence levels** (from Readability):
- `high`: `textContent.length >= 500`
- `medium`: `textContent.length >= 100`
- `low`: below 100 chars (triggers picker hint in sidebar)

**DOM → Markdown** uses Turndown with the GFM plugin for tables, strikethrough, and task lists.

---

## Composite Prompt Assembly

`buildCompositePrompt({ skills, articles })` produces the system prompt when skills are active:

```
[Personality of skill 1]
["\n\nYou also incorporate the following perspective:\n" + Personality of skill N, for N > 1]

---
## Knowledge
[knowledge of all skills concatenated]

---
## Page Context
[if 1 article]:  Title: {title}\nURL: {url}\n\n{bodyMarkdown ≤50k}
[if N articles]: ### {title}\nURL: {url}\n\n{bodyMarkdown ≤50k}  (one subsection per article)

---
## Commands
[commands of all skills concatenated]

---
## {ExtraSection}
[extra section content, merged by name across skills]
```

Empty sections are omitted. The `Activation` section is NEVER included in system prompts.

When no skills are active, the controller uses `settings.ai.systemPrompt` or a default summarization prompt. Page content for Q&A (no-skill mode) is injected as a `user` context message followed by an `assistant` acknowledgement, before the conversation history.

---

## Chat Controller — Key Flows

### `handleInit(tabId, url?)`
1. Clear context tabs map, abort any in-flight request.
2. If `url === "about:blank"`: check tab state cache → `personaModeReady` (with cached messages, or fresh).
3. Otherwise: check tab state cache. If hit and URL matches → `conversationRestored` + rebuild context tab entry.
4. If miss: 500ms delay → `extractContent(tabId)` → on success: `contextLoaded`, initialize `TabState`. On failure: `contextError`.
5. After extraction: if AI not configured, send non-blocking `configError` (no return; extraction still succeeds).

### `handleSummarize()`
1. Check AI config; if missing → `configError`.
2. If context tabs empty → `streamError`.
3. `ensureContextContent()` (lazy re-extract any tab whose content is null).
4. `buildContextArticles()` → `streamSummarization(settings, articles)`.
5. Stream: `streamStart` → `streamToken` × N → `streamEnd` / `streamError`.
6. On success: update `TabState.summary` and append assistant message to conversation.

### `handleSendMessage(text)` / `doSendMessage(text, isRetry)`
1. Build system prompt (composite if skills active, else default).
2. If no skills and articles present: inject page content as user/assistant context exchange.
3. Append full conversation history from `TabState`.
4. Add new user message; record in `TabState` (only if not retry).
5. Stream response → `streamEnd` → append assistant message to `TabState`.

### Context Tab Handlers
- `handleAddContextTab(tabId)`: extract → `contextTabAdded` or `contextTabFailed`.
- `handleRemoveContextTab(tabId)`: delete from map → `contextTabRemoved`.
- `handleGetOpenTabs()`: call `queryOpenTabs()` → `openTabs`.

---

## Export Pipeline

```
ExportManager.export({ tabId, includeQA, destinations })
  ├── extractContent(tabId)                  ← re-extracts if no cache
  ├── renderFrontmatter({ article, captureDate, fields })
  ├── generateFilename({ article, captureDate, pattern })
  ├── assemble Markdown:
  │     {frontmatter}
  │     # {title}
  │     {bodyMarkdown}
  │     [## Summary\n{summary}]              ← if includeSummary and summary exists
  │     [## Q&A\n{conversation messages}]    ← if includeQA and messages exist
  └── dispatch to each destination:
        "download" → browser.downloads.download (via injected deliverToDownload)
        "clipboard" → clipboardWrite port message → sidebar executes → clipboardResult
```

---

## Auto-Export Scheduler

- Alarm name: `auto-export-{tabId}`
- Internal state: `Map<tabId, { origin, lastCaptureTime, nextFireTime, lastHash, consecutiveFailures }>`
- `scheduleForTab(tabId, origin)`: reads config → `browser.alarms.create`
- `handleAlarm(alarm)`: parse tabId → load config → extractContent → optionally hash → exportContent → update state
- `skipIfUnchanged`: compute `hashContent(markdown)` (MD5) → compare to `lastHash` → skip if equal
- Max consecutive failures tracked; failures do not cancel the alarm (it retries on next fire)

---

## Active Tab Tracker (Sidebar)

```typescript
createActiveTabTracker(windowId, onActiveTabChanged)
  // Listens to:
  //   browser.tabs.onActivated  — fires when user switches tabs in this window
  //   browser.tabs.onUpdated    — fires when a tab's URL/status changes
  //
  // Calls onActiveTabChanged(tabId, url) when the active tab changes URL or identity
  // Filters: only events for tabs in this sidebar's windowId
```

The sidebar uses this to detect navigation and trigger `resetLocalNav()` + new `init` message.

---

## Sidebar Rendering

The sidebar uses a full-teardown-and-rebuild `render()` function on each state change (`app.innerHTML = ""`), with one performance exception: `streamToken` messages patch the partial content element in-place to avoid 15–25 full DOM rebuilds per second during streaming.

### Context Chip Strip

Rendered in `ready` (messages ≠ []) and `renderReadyNoSummary()` states:

```
[tab title ×] [tab title ×] [＋]
```

- Each chip shows truncated title (22 chars), tooltip with full title + URL, and a dismiss `×` button.
- `＋` button requests `getOpenTabs` and opens a dropdown listing currently open tabs not already in context.
- Clicking a dropdown item sends `addContextTab`.

### Reading Time Micro-Moment

In `renderReadyNoSummary()` (pre-summarize state):
- Article title rendered as `.page-info-title`
- `~N min read` badge rendered as `.page-info-reading-time` (indigo pill)
- `N = ceil(wordCount / 200)`, minimum 1

After summarization (ready + messages):
- `✓ ~N min saved` rendered as `.time-saved-hint` (green, below messages)

### Projection Mode

CSS class `body.projection-mode` hides only:
```css
body.projection-mode .btn-choose-skill,
body.projection-mode .avatar-controls,
body.projection-mode .avatar-error { display: none; }
```

All other elements remain visible.

---

## Storage Keys

| Key | Storage | Contents |
|---|---|---|
| `settings` | `storage.sync` (+ local fallback) | `Settings` object |
| `distill_skill_library` | `storage.local` | `SkillLibrary` object |
| `distill_secrets_{ref}` | `storage.local` | API key string |
| `distill_projection_mode` | `storage.local` | `boolean` |
| `distill_bot_avatar` | `storage.local` | Data URI string |

---

## Build & Toolchain

| Tool | Role |
|---|---|
| `vite` + `vite-plugin-web-extension` | Bundles extension from `manifest.json` |
| `TypeScript` | Strict mode; path aliases `@shared/*`, `@background/*`, `@content/*`, `@sidebar/*`, `@options/*` |
| `vitest` | Test runner (jsdom environment, globals enabled) |
| `fast-check` | Property-based testing |
| `@mozilla/readability` | Content extraction |
| `turndown` + `turndown-plugin-gfm` | HTML → Markdown |

### Path Aliases

Configured in both `tsconfig.json` and `vite.config.ts` / `vitest.config.ts`:

```
@shared/*   → src/shared/*
@background/* → src/background/*
@content/*  → src/content/*
@sidebar/*  → src/sidebar/*
@options/*  → src/options/*
```

### Commands

```bash
npm run dev        # dev build with hot reload
npm run build      # production build → dist/
npm test           # vitest run (all 825 tests)
npm run test:watch # watch mode

# Load in Firefox: about:debugging → Load Temporary Add-on → dist/manifest.json
```

---

## Key Design Principles

1. **Dependency injection via factory functions**: all modules export `createX(opts)` with injected deps. No module directly calls `browser.*` APIs in logic — they receive them as `opts`.
2. **Result unions over exceptions**: `{ ok: true, ...T } | { ok: false, reason: R, detail: string }` for all expected failures.
3. **Readonly throughout**: all shared types use `readonly` fields and `ReadonlyArray`.
4. **No auto-summarize**: extraction sends `contextLoaded` only; the user must explicitly click Summarize.
5. **Streaming in-place patch**: `streamToken` bypasses full `render()` and patches only the partial content DOM node.
