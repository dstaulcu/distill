# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source of truth & process rules

**`REQUIREMENTS.md` is the source of truth for intended behavior.** Core features are CF-1…CF-6
(numbered acceptance criteria); secondary features are SF-1…SF-7. When code and REQUIREMENTS.md
disagree, the code is wrong — unless you change REQUIREMENTS.md first.

Non-negotiable rules for every change:

1. **Every new feature ships with its own unit tests**, written against observable behavior at
   module boundaries (not implementation details).
2. **Nothing is done until `npm test` (full suite) passes** — and a change is not "done" if it
   only passes the regression subset.
3. **A change to a core feature requires updating the matching CF-x acceptance criterion in
   REQUIREMENTS.md first**, then the tests, then the code.
4. **Bug fixes are verified failing-then-passing**: write the test that proves the bug, watch it
   fail, fix, watch it pass.
5. Tests that verify a CF criterion put the ID in their `describe` name (e.g.
   `describe("CF-4.2 renderFrontmatter", …)`) — that is what makes the regression filter work.
6. Don't silently change observable behavior; if a fix changes something users may rely on,
   flag it. Report test results honestly, including failures.

## Commands

```bash
npm run dev             # Development build with hot reload (vite)
npm run build           # Production build → dist/
npm test                # Full suite (vitest run) — the gate for "done"
npm run test:regression # Core-feature regression suite only (vitest run -t CF-)
npm run test:watch      # Watch mode
npm run typecheck       # tsc --noEmit — must stay clean (vite build does NOT typecheck)

# Run a single test file
npx vitest run src/background/chat/controller.test.ts

# Run property-based tests only
npx vitest run prop.test
```

Load in Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `dist/manifest.json`.

## Architecture

### Extension Contexts

Four isolated contexts communicate only via typed message passing:

1. **Background (persistent page)** — `src/background/main.ts` is thin wiring; the logic lives in
   factory modules: extraction service (`extraction.ts`), chat controller, settings manager,
   secure store + credentials, export pipeline, auto-export scheduler, skill library.
2. **Content Script (per tab)** — `src/content/main.ts`: DOM extraction (Readability → Markdown),
   element picker, selector generation, selector preview.
3. **Sidebar (per window)** — `src/sidebar/sidebar.ts`: chat UI state machine, active-tab
   tracking, clipboard delivery for exports, sanitized markdown rendering (`markdown.ts`).
4. **Options page** — `src/options/options.ts`. Persists settings **through the background**
   (`settingsChanged` / `autoExportConfigSave` / `apiKeySave` messages), never by writing
   settings to storage directly.

### Messaging System

- **One-shot messages**: typed via `@shared/messages.ts` (closed union on `kind`). Use
  `buildMessage()`, `isMessageOfKind()`, `sendToBackground()`, `sendToTab()`.
- **Long-lived port** (`browser.runtime.connect("chat")`): typed via `@shared/port-protocol.ts`
  (union on `type`) for streaming tokens, session management, skills, auto-export control.
  The sidebar port also receives one-shot-style `clipboardWrite` envelopes for CF-4.4.

### Key Design Patterns

- **Factory functions with injected deps** (`createX(opts)`) everywhere — this is what makes the
  test suite run without a browser. Entry points (`background/main.ts`, `content/main.ts`,
  `sidebar/sidebar.ts`) are tested via a global `browser` mock + dynamic import (see
  `content/main.test.ts` for the canonical pattern).
- **Result unions over exceptions**: `{ ok: true, … } | { ok: false, reason, detail }`.
- **Readonly interfaces throughout**; path aliases `@shared/*`, `@background/*`, `@content/*`,
  `@sidebar/*`, `@options/*` (tsconfig + vite + vitest configs).

### Behavior notes that are easy to get wrong

- **Site patterns**: user patterns ALWAYS beat builtins; the only builtin list lives in
  `site-patterns/matcher.ts` (`BUILTIN_PATTERNS`) — settings hold user patterns only, and
  legacy builtin entries in stored settings are deliberately ignored (CF-6.2).
- **API keys**: settings hold only `apiKeyRef`; the key is stored via `secure-store.ts` through
  `credentials.ts` (`apiKeySave` message). Empty key = keyless endpoint (Ollama at home); the
  work fork requires the key path to genuinely authenticate (CF-5.3). No Authorization header
  is sent when the key is empty.
- **Auto-export skip-if-unchanged**: FNV-1a hash over the FULL content; `lastHash` is recorded
  only after a successful export (SF-4).
- **Retry**: the controller is the single source of truth (< 3 consecutive failures); the
  sidebar keeps no counter, and a retried message appears exactly once in the prompt (CF-3.2/3.3).
- **Markdown rendering** (`sidebar/markdown.ts`) is a security boundary: quotes are escaped and
  only http(s) links become anchors (CF-3.5). Never render untrusted text via innerHTML
  without it.

### Skills System

Skills are user-loaded markdown files with YAML frontmatter (`name`, `description`) and `##`
sections (Personality required; Knowledge, Commands, Activation, extras). Parsed by
`@shared/skill-parser.ts`, composed by `@shared/composite-prompt.ts` (Activation is NEVER in the
prompt). Library CRUD in `@background/skill-library.ts` (`distill_skill_library` in
storage.local); the controller re-reads active skills before each request so options-page
changes apply immediately.

## Testing

Three-tier strategy with vitest (jsdom, globals on):

- `*.test.ts` — unit tests with mocked deps
- `*.prop.test.ts` — property-based tests (fast-check); excluded from the regression filter by
  convention (no CF- tag) to keep it fast
- `*.integration.test.ts` — cross-module flows

All external deps (browser APIs, fetch, crypto) are injected. The suite must pass in full and
`npm run typecheck` must stay clean before any change is considered done.

## Key Dependencies

- `@mozilla/readability` — content extraction (always run on a clone; it mutates the DOM)
- `turndown` + `turndown-plugin-gfm` — HTML → Markdown
- `vite-plugin-web-extension` — builds from `manifest.json`
- `fast-check` — property-based testing

## Reference

- `REQUIREMENTS.md` — intended behavior (source of truth) + resolved design decisions Q1–Q18
- `AUDIT.md` — the 2026-07 audit that drove the current test coverage and defect fixes
- `README.md` — user-facing docs, Mermaid architecture diagrams, configuration reference
- `.kiro/specs/distill/` — the ORIGINAL spec; partially stale, superseded by REQUIREMENTS.md
