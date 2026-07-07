# Distill v3

A Firefox extension (Manifest V3) that extracts web page content, generates AI summaries via a sidebar, supports follow-up Q&A chat with streaming responses, and exports unified Markdown documents.

## Features

- **AI-Powered Summarization** — Automatically summarizes the active page when the sidebar opens, with structured output (Findings, Key Points, Action Items)
- **Follow-up Q&A Chat** — Ask questions about the page content with full conversation context and streaming token delivery
- **Content Extraction** — Smart heuristic detection via `@mozilla/readability` with manual element picker recovery
- **Markdown Export** — Unified documents combining frontmatter, summary, Q&A, and cleaned page content
- **Auto-Export Scheduling** — Periodic content capture for configured sites using `browser.alarms`
- **Site Patterns** — Configurable CSS selectors per-site for reliable extraction across different layouts
- **API Key Storage** — keys live outside settings, AES-GCM obfuscated at rest in `browser.storage.local` (protects against casual inspection of storage dumps; the encryption key itself is stored locally, so this is not protection against code with storage access)

## Requirements

- Firefox 109+ (first version with MV3 support)
- Node.js 18+
- An OpenAI-compatible API endpoint (any provider supporting `/v1/chat/completions`)

## Build & Development

```bash
# Install dependencies
npm install

# Development build with hot reload
npm run dev

# Production build
npm run build

# Run tests (single run)
npm test

# Run tests in watch mode
npm run test:watch
```

### Loading in Firefox

1. Run `npm run build` to produce the `dist/` folder
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on" and select `dist/manifest.json`

## Configuration

After installing, open the extension's Settings page (right-click toolbar icon → "Manage Extension" → "Options") to configure:

| Setting | Description |
|---------|-------------|
| AI Base URL | OpenAI-compatible endpoint (e.g., `https://api.openai.com`) |
| Model ID | Model identifier (e.g., `gpt-4`, `gpt-4o`) |
| API Key | Encrypted at rest via AES-GCM SecureStore |
| Filename Pattern | Tokens: `YYYY`, `MM`, `DD`, `slugified-title` |
| Site Patterns | URL match patterns + CSS content selectors (max 50) |
| Auto-Export | Per-origin interval (1–120 min), destination, mode; change detection via FNV-1a hash of the full exported content |

## Architecture

### System Context (Enterprise Viewpoint)

```mermaid
graph TB
    subgraph "User Environment"
        User[User / Researcher]
        Firefox[Firefox Browser]
    end

    subgraph "Distill Extension"
        EXT[Distill v3 Extension]
    end

    subgraph "External Services"
        AI[OpenAI-Compatible API]
        FS[Local Filesystem]
    end

    User -->|"Opens sidebar, asks questions"| Firefox
    Firefox -->|"Hosts extension"| EXT
    EXT -->|"Streaming SSE /v1/chat/completions"| AI
    EXT -->|"browser.downloads.download()"| FS
    EXT -->|"Reads page DOM"| Firefox
```

### Logical Component View

```mermaid
graph TB
    subgraph "Background Script (Persistent)"
        BG[Background Entry]
        CC[Chat Controller]
        SC[Streaming AI Client]
        AC[AI Client]
        SM[Settings Manager]
        SS[SecureStore]
        EM[Export Manager]
        FR[Frontmatter Renderer]
        FG[Filename Generator]
        SPM[Site Pattern Matcher]
        TS[Tab State Manager]
        AES[Auto Export Scheduler]
    end

    subgraph "Content Script"
        CE[Content Extractor]
        RW[Readability Wrapper]
        MC[Markdown Converter]
        ME[Metadata Extractor]
        EP[Element Picker]
        SG[Selector Generator]
    end

    subgraph "UI Layer"
        SB[Sidebar]
        ATT[Active Tab Tracker]
        SET[Settings Page]
    end

    subgraph "External"
        AI[OpenAI-Compatible API]
        BS[browser.storage APIs]
    end

    SB -->|"Port: chat"| CC
    SB -->|"runtime.sendMessage"| BG
    ATT -->|"tabs.onActivated / onUpdated"| SB
    SET -->|"runtime.sendMessage"| BG
    BG -->|"tabs.sendMessage"| CE
    CC --> SC
    SC -->|"SSE stream"| AI
    AC -->|"HTTP"| AI
    SM --> BS
    SS --> BS
    TS -.->|"in-memory Map"| TS
    AES -.->|"browser.alarms"| AES
    CE --> RW
    CE --> MC
    CE --> ME
    EP --> SG
```

### Information Flow: Summary & Chat

```mermaid
sequenceDiagram
    participant User
    participant Sidebar
    participant Background
    participant ContentScript
    participant AIEndpoint

    User->>Sidebar: Opens sidebar / switches tab
    Sidebar->>Background: Port connect ("chat") + init { tabId }
    Background->>Background: Check session cache

    alt Cached session
        Background->>Sidebar: conversationRestored { messages }
    else New session
        Background->>ContentScript: extractRequested { tabId, selector }
        ContentScript->>Background: extractResult { article }
        Background->>Sidebar: contextLoaded { title, url }
        Background->>AIEndpoint: POST /v1/chat/completions (stream)
        loop SSE tokens
            AIEndpoint-->>Background: delta.content
            Background->>Sidebar: streamToken { token }
        end
        Background->>Sidebar: streamEnd { fullContent }
    end

    User->>Sidebar: Follow-up question
    Sidebar->>Background: sendMessage { text }
    Background->>AIEndpoint: POST /v1/chat/completions (context + history)
    loop SSE tokens
        AIEndpoint-->>Background: delta.content
        Background->>Sidebar: streamToken { token }
    end
    Background->>Sidebar: streamEnd { fullContent }
```

### Information Flow: Export Pipeline

```mermaid
sequenceDiagram
    participant User
    participant Sidebar
    participant Background
    participant ContentScript

    User->>Sidebar: Clicks Export
    Sidebar->>Background: exportRequested { destinations, includeQA }
    Background->>ContentScript: extractRequested { tabId }
    ContentScript->>Background: extractResult { article }
    Background->>Background: Assemble: frontmatter → summary → Q&A → content
    Background->>Background: Generate filename (pattern + slug + date)

    alt Download
        Background->>Background: browser.downloads.download()
    else Clipboard
        Background->>Sidebar: clipboardWrite { content }
        Sidebar->>Sidebar: navigator.clipboard.writeText()
        Sidebar->>Background: clipboardResult { ok }
    end

    Background->>Sidebar: exportResult { outcomes, filename }
```

### Process View: Auto-Export Scheduling

```mermaid
sequenceDiagram
    participant TabEvents as browser.tabs
    participant Background
    participant Scheduler as Auto Export Scheduler
    participant Alarms as browser.alarms
    participant ContentScript
    participant Export as Export Pipeline

    Note over Background: Tab loads page with configured origin
    TabEvents->>Background: onUpdated { status: "complete", url }
    Background->>Scheduler: scheduleForTab(tabId, origin)
    Scheduler->>Alarms: alarms.create("auto-export-${tabId}", { periodInMinutes })

    Note over Alarms: Alarm fires at configured interval
    Alarms->>Scheduler: onAlarm { name }
    Scheduler->>ContentScript: extractContent(tabId)
    ContentScript->>Scheduler: extractResult { article }

    alt "skip if unchanged" enabled
        Scheduler->>Scheduler: hashContent(body) → compare
        alt Content changed
            Scheduler->>Export: export(article, config)
        else Unchanged
            Scheduler->>Scheduler: Skip, update status
        end
    else Always export
        Scheduler->>Export: export(article, config)
    end

    Note over TabEvents: Navigation away or tab close
    TabEvents->>Background: onUpdated/onRemoved
    Background->>Scheduler: cancelForTab(tabId)
    Scheduler->>Alarms: alarms.clear("auto-export-${tabId}")
```

### Deployment View: Extension Contexts

```mermaid
graph LR
    subgraph "Firefox Process"
        subgraph "Extension Background Page"
            BG[background/main.ts]
            BG --- CC[chat/controller]
            BG --- SM[settings/manager]
            BG --- EM[export/manager]
            BG --- AES[auto-export/scheduler]
            BG --- SS[secure-store]
        end

        subgraph "Content Script (per tab)"
            CS[content/main.ts]
            CS --- EX[extractor/extract]
            CS --- EP[element-picker]
        end

        subgraph "Sidebar Document (per window)"
            SB[sidebar/sidebar.ts]
            SB --- ATT[active-tab-tracker]
        end

        subgraph "Options Tab"
            OPT[options/options.ts]
        end
    end

    BG <-->|"runtime.onConnect (port)"| SB
    BG <-->|"runtime.sendMessage"| OPT
    BG <-->|"tabs.sendMessage"| CS
    BG <-->|"browser.storage"| Storage[(browser.storage)]
    BG <-->|"fetch (SSE)"| API[AI Endpoint]
```

### Technology Stack

```mermaid
graph TD
    subgraph "Runtime"
        FF[Firefox 109+ MV3]
        API[browser.* Promise APIs]
    end

    subgraph "Build"
        Vite[Vite 6]
        VPWE[vite-plugin-web-extension]
        TS[TypeScript 5.6 strict]
    end

    subgraph "Libraries"
        Read["@mozilla/readability"]
        TD[turndown + GFM plugin]
    end

    subgraph "Testing"
        VT[Vitest 2.1]
        FC[fast-check 3.22]
        JSDOM[jsdom 25]
    end

    Vite --> VPWE
    VPWE --> FF
    TS --> Vite
    Read --> FF
    TD --> FF
    VT --> FC
    VT --> JSDOM
```

## Project Structure

```
src/
├── background/           # Persistent background script
│   ├── main.ts           # Entry point, message routing, event wiring
│   ├── ai/              # Non-streaming AI client (connection test)
│   ├── auto-export/     # Scheduler, hasher, filename generator
│   ├── chat/            # Chat controller, streaming SSE client
│   ├── export/          # Export manager (document assembly)
│   ├── render/          # Frontmatter renderer, filename generator
│   ├── settings/        # Settings manager, defaults, validation
│   ├── site-patterns/   # URL pattern matcher
│   ├── secure-store.ts  # AES-GCM encrypted key storage
│   └── tab-state.ts     # In-memory per-tab state
├── content/             # Content scripts (injected into pages)
│   ├── main.ts          # Message handler entry point
│   ├── extractor/       # Readability wrapper, Markdown converter, metadata
│   ├── element-picker.ts # Visual element selection overlay
│   └── selector-generator.ts # Stable CSS selector generation
├── sidebar/             # Sidebar UI (per-window)
│   ├── sidebar.ts       # Chat interface, state machine
│   ├── active-tab-tracker.ts # Window-aware tab tracking
│   ├── sidebar.html
│   └── sidebar.css
├── options/             # Settings page
│   ├── options.ts
│   ├── options.html
│   └── options.css
└── shared/              # Cross-context utilities
    ├── messages.ts      # Typed message envelope system
    ├── port-protocol.ts # Sidebar ↔ controller port types
    ├── storage.ts       # Storage adapter interfaces
    ├── types.ts         # Result unions, data models, settings
    └── url-utils.ts     # URL comparison utilities
```

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| Dependency injection | Factory functions with options objects; all externals injectable |
| Result unions over exceptions | `{ ok: true, ... } \| { ok: false, reason, detail }` for expected failures |
| Typed messaging | Closed discriminated union envelope with compile-time narrowing |
| Security | API keys never stored inside settings; AES-GCM obfuscated at rest; sanitized markdown rendering in the sidebar |
| Testability | ~890 tests (unit + property-based + integration) with injectable deps throughout |
| Firefox-native | `browser.*` promise APIs, `sidebar_action`, persistent background page |

## Testing

The project uses a three-tier testing strategy:

- **Unit tests** (`*.test.ts`) — Focused behavior verification with mocked dependencies
- **Property-based tests** (`*.prop.test.ts`) — Universal correctness properties via `fast-check`
- **Integration tests** (`*.integration.test.ts`) — End-to-end flows across module boundaries

```bash
# Run all tests
npm test

# Run only the core-feature regression suite (tests tagged with CF- ids)
npm run test:regression

# Typecheck
npm run typecheck

# Run specific test file
npx vitest run src/background/chat/controller.test.ts

# Run property tests only
npx vitest run prop.test
```

Intended behavior is specified in [`REQUIREMENTS.md`](REQUIREMENTS.md) — core-feature tests
reference its CF-x acceptance criteria in their `describe` names, which is what makes the
regression filter (`vitest run -t CF-`) work.

## License

Private — not published to any registry.
