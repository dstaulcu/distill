# AUDIT.md — Distill v3 (Phase 2)

> **STATUS (2026-07-05): Phase 3 complete.** All defects D1–D24 are fixed (D19 partially:
> the controller now re-reads active skills per request, so options-page library changes
> apply immediately; a live push to an open sidebar's dropdown remains a known limitation).
> Every fix is pinned by tests; the regression suite is `npm run test:regression`.
> This document is retained as the point-in-time Phase 2 audit record.

> Produced 2026-07-04 against the confirmed `REQUIREMENTS.md`. Baseline suite status:
> **54 files / 825 tests / 0 failures** (`npm test`, ~71 s). Every defect below survives a
> fully passing suite — the gaps in the coverage map explain why.

---

## 1. Coverage map

Requirement → implementing code → verifying tests. "Partial" means some criteria of the
feature are tested and the listed gaps are not.

| Req | Implementation | Tests | Status |
|-----|----------------|-------|--------|
| CF-1 Extraction | `content/extractor/*` (extract, readability-wrapper, dom-to-markdown, metadata), `content/main.ts`, `background/main.ts` (`extractContent`, `markPatternStale`), `site-patterns/matcher.ts` | extract .test/.integration, readability-wrapper.test, dom-to-markdown .test/.prop, metadata .test/.prop, matcher .test/.prop, content/main.test | **Partial** — `background/main.ts` is UNTESTED: privileged-page guard (1.5), 10 s timeout (1.6), pattern→selector resolution, stale flagging (1.4 flagging side) |
| CF-2 Summarization | `chat/controller.ts`, `chat/streaming-client.ts`, `sidebar/sidebar.ts` | controller .test/.prop/.integration, streaming-client .test/.prop | **Partial** — all sidebar-side criteria UNTESTED: in-place token patching (2.2), reading-time / time-saved badges (2.4), partial visible after abort (2.5-UI) |
| CF-3 Q&A | `chat/controller.ts`, `sidebar/sidebar.ts` (renderMarkdown, state machine) | controller .test/.prop/.integration | **Partial** — sidebar state machine UNTESTED (3.3 error/retry rendering), `renderMarkdown` sanitization UNTESTED (3.5), retry-no-duplicate (3.2) untested |
| CF-4 Export | `export/manager.ts`, `render/frontmatter.ts`, `render/filename.ts`, `background/main.ts` (clipboard delivery), sidebar footer | manager .test/.prop/.integration, frontmatter .test/.prop, filename .test/.prop | **Partial** — sidebar Export button (4.4 defaultDestination) and `main.ts` clipboard port round-trip UNTESTED |
| CF-5 Settings & credentials | `settings/manager.ts`, `settings/defaults.ts`, `secure-store.ts`, `shared/storage.ts`, `options/options.ts` | manager .test/.prop/.integration, secure-store .test/.prop, options.test (helpers only) | **Partial** — end-to-end key path (5.3) UNTESTED (and broken, D1); options save/load flows UNTESTED; `shared/storage.ts` adapters UNTESTED; restart-survival read fallback (5.1) UNTESTED |
| CF-6 Patterns & picker | `site-patterns/matcher.ts`, `content/selector-generator.ts`, `content/element-picker.ts`, `background/main.ts` (patternSave, picker flow) | matcher .test/.prop, selector-generator .test/.prop, element-picker.test | **Partial** — pick→save→re-extract loop (6.4) UNTESTED; user-over-builtin precedence (6.2) untested (and violated, D2); selector preview (6.5) UNTESTED (dead, D13) |
| SF-1 Multi-tab context | controller, sidebar chip strip | controller .test/.integration (add/remove/multi-article prompt) | **Partial** — sidebar chips/picker UI UNTESTED |
| SF-2 Persona-chat | controller, sidebar | controller.test (persona mode init/restore) | **Partial** — sidebar UNTESTED |
| SF-3 Skills & personas | `shared/skill-parser.ts`, `shared/composite-prompt.ts`, `skill-library.ts`, controller, options | skill-parser.test, composite-prompt.test, controller.skill-e2e.test | **Partial** — `skill-library.ts` has NO dedicated tests (CRUD, limits, cascade-delete, migration covered only incidentally); options library UI UNTESTED |
| SF-4 Auto-export | `auto-export/scheduler.ts`, `hasher.ts`, `filename.ts`, `background/main.ts` (wiring, port handlers) | scheduler .test/.prop/.integration, hasher .test/.prop, filename .test/.prop, config-persistence.integration | **Partial** — `main.ts` wiring (onUpdated schedule/cancel, origin change, port enable/disable) UNTESTED |
| SF-5 Bot avatar | sidebar | — | **UNTESTED** |
| SF-6 Options conveniences | options.ts | options.test (helpers only) | **Mostly untested** |

**Untested modules (no test file at all):** `sidebar/sidebar.ts` (~1,430 lines — the largest
single file in the project), `background/main.ts` (~700 lines of wiring and orchestration),
`background/skill-library.ts`, `shared/storage.ts`.

---

## 2. Defect list (ranked)

IDs are stable for Phase 3 tracking. Each maps to a REQUIREMENTS.md criterion and, where
applicable, the interview decision (Qn).

### Critical — core feature broken or security

- **D1** API key entered in options is silently discarded; `apiKeyRef` is set but the key
  is never stored, so every AI request sends an empty Bearer token. Breaks CF-5.3 / the
  work fork entirely. `options.ts:767-781`. [Q1]
- **D2** User site patterns saved via the element picker are never used: `patternSave`
  appends after the seeded catch-all `*://*/*` builtin and the matcher takes first match
  in array order (`main.ts:359`, `matcher.ts:188`). Also two divergent builtin lists
  (`defaults.ts` vs `matcher.ts`) and the options save path orders differently. Breaks
  CF-6.2/6.4. [Q2]
- **D3** XSS in `sidebar.ts` `renderMarkdown` (~lines 1299-1349): quotes are not escaped
  (attribute injection) and link hrefs are unsanitized (`javascript:`). Untrusted page/AI
  content executes in the privileged sidebar. Violates CF-3.5. [Q9]

### High — data loss or feature dead-ends

- **D4** Sidebar stuck on spinner after Retry: stream messages aren't handled from the
  `loading` phase (`sidebar.ts:182-236`), and `streamError` replaces the conversation
  view. A retry that has nothing to re-send (no last message, no articles) silently does
  nothing while the sidebar spins. Violates CF-3.3. [Q7]
- **D5** `skipIfUnchanged` updates `lastHash` before the export attempt
  (`scheduler.ts:168-176`); a failed export causes the changed content to be skipped
  forever. Violates SF-4. [Q4]
- **D6** Settings saved to `storage.local` after a sync-quota fallback are invisible after
  restart — the fallback flag is in-memory and `get()` reads sync only
  (`settings/manager.ts:69-73`). Violates CF-5.1. [Q12]
- **D7** Options page bypasses the settings manager: direct storage writes, duplicated
  validation, no change broadcast (open sidebar goes stale), auto-export **edits** not
  persisted until "Save Settings", and no enabled toggle in the editor. Violates CF-5.2,
  SF-4. [Q10]
- **D8** Retry duplicates the user message in the AI prompt (history already contains it,
  then it's appended again, `controller.ts:633`); `canRetry` is computed before increment
  in the summarize path but after in the Q&A path (`controller.ts:551-552` vs `710-711`);
  the sidebar keeps a redundant failure counter. Violates CF-3.2/3.3. [Q6]

### Medium — incorrect behavior in edge cases, dead features

- **D9** Change hash covers only the first 10,000 chars (`hasher.ts:7`) — tail-only changes
  are treated as "unchanged". Violates SF-4. [Q3]
- **D10** Cancelling a summary discards the visible partial while the controller saves it —
  it reappears on tab revisit (`sidebar.ts:664-672`). Violates CF-2.5. [Q8]
- **D11** `hasSavedPattern` is always true (catch-all builtin matches everything,
  `main.ts:137-141`), so the picker hint never shows first-time wording. Violates CF-1.1.
  [Q15]
- **D12** `markPatternStale` flags every pattern sharing the failed selector string, across
  all sites, including builtins (`main.ts:115-123`). Violates CF-1.4. [Q16]
- **D13** Options selector preview sends an unregistered `selectorPreview` message no
  handler answers — always "not responding" (`options.ts:603-638`). Violates CF-6.5. [Q13]
- **D14** Streaming client leaks one un-cancelled timer per read whose rejection is
  unobserved (unhandled-rejection noise; `streaming-client.ts:170-173`, `274-281`); plus
  dead `resetTimeout`. [Q14]
- **D15** Sidebar Export button hardcodes download; `export.defaultDestination` is never
  consulted (`sidebar.ts:1122-1128`). Violates CF-4.4. [Q17]
- **D16** Export manager's clipboard fallback loop returns after the first port
  unconditionally (`main.ts:200-207`) — a dead loop that only ever tries one sidebar.
- **D17** Restored sessions report `confidence: cached ?? "high"` — unknown confidence is
  presented as high (`controller.ts:255`).
- **D18** `npx tsc --noEmit` fails: pre-existing type errors in `scheduler.test.ts`,
  `controller.integration.test.ts`, `controller.skill-e2e.test.ts`, `controller.test.ts`;
  there is no typecheck gate so they linger.
- **D19** Options library changes (skill/persona delete, etc.) never notify a connected
  sidebar — its dropdown stays stale until reconnect.

### Low — cosmetic, dead code, doc drift

- **D20** Dead code: `skill-state.ts` module (superseded by skill-library; nothing imports
  it but its tests), sidebar `lastFailedMessage` (written, never read). [Q14]
- **D21** `handleSavePersona` always reports "Persona created" — `editingPersonaId` is
  nulled before the message is chosen (`options.ts:1125-1128`).
- **D22** README drift: "768 tests" (825 actual), `--testPathPattern` is a Jest flag vitest
  doesn't support, "MD5" hash claim (FNV-1a per Q3), and the "AES-GCM encrypted at rest"
  security claim needs the Q11 honesty correction.
- **D23** Stale in-code requirement citations from the old spec revision (update
  opportunistically to CF-x/SF-x). [Q18]
- **D24** Settings manager reports storage failures under the misleading reason
  `"validation-failed"` (`manager.ts:96-104`).

---

## 3. Test infrastructure assessment

**What exists is good.** vitest + jsdom + fast-check, `npm test` runs everything in one
command, three-tier convention (`.test` / `.prop.test` / `.integration.test`), DI throughout
so no browser stubs are needed. 825 tests pass. No changes to the runner are needed.

**Gaps and proposals:**

1. **Typecheck gate.** Add `"typecheck": "tsc --noEmit"` to package.json scripts and fix the
   existing test-file type errors (D18). Done first, so Phase 3 changes can't add new ones.
2. **Sidebar testability.** `sidebar.ts` runs `init()` at import time and holds module-level
   state, so it can't be imported in a test without side effects. Minimal refactor (no
   behavior change): export a `createSidebar(deps)`-style entry consistent with the rest of
   the codebase (or at least gate auto-init behind `document.readyState`/an env check) and
   extract pure functions (`renderMarkdown`, `formatRelativeTime`, state transitions) for
   direct unit testing. This unlocks tests for D3, D4, D10, D15 and SF-5/SF-6.
3. **`background/main.ts` testability.** It wires everything at import. Extract the
   orchestration (`extractContent`, `markPatternStale`, clipboard delivery, auto-export
   port handlers, tab-event handlers) into an exported factory taking injected deps, with
   main.ts reduced to instantiation. Unlocks tests for D2, D5-wiring, D11, D12, D16.
4. **Regression suite convention** (Phase 3 step 4): tag every core-feature test's
   `describe` block with its requirement ID, e.g. `describe("CF-4.2 frontmatter quoting", …)`.
   Add script `"test:regression": "vitest run -t CF-"` — vitest's `-t` name filter makes
   the core suite mechanically runnable, with no file renames and no new tooling. SF tests
   get `SF-` tags the same way but are not part of the regression gate.
5. **No lint.** Out of scope unless you want it; typecheck + tests are the gate.

---

## 4. Proposed Phase 3 order

1. Infrastructure: typecheck script + fix D18; add `test:regression` script.
2. Failing-test-first fixes, severity order: D1 → D2 → D3 (each: write test exposing the
   bug per its CF criterion, watch it fail, fix, watch it pass), then D4–D8, then D9–D17,
   D19, cleanups D20–D24 last.
3. Testability refactors (sidebar factory, main.ts factory) happen just-in-time, before the
   first defect that needs them (D3/D4 for sidebar, D2 for main.ts), each protected by the
   existing suite plus the new tests.
4. Backfill unit tests for the untested modules (`skill-library.ts`, `shared/storage.ts`,
   options save/load flows) and tag all CF tests for the regression suite.
5. Update README (D22), CLAUDE.md (Phase 4), and opportunistic citation cleanup (D23).

**Behavior-change flags (per the "don't silently change observable behavior" rule):** every
fix here was explicitly approved in the Q1–Q18 interview; the ones a user could notice are
D2 (extraction may pick different content once user patterns win and the rich fallback
applies), D9 (auto-export captures more changes), D15 (Export honors the clipboard setting
if configured), and Q5/Q11/Q22 doc corrections. No others alter happy-path output.
