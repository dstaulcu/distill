/**
 * Typed cross-context messaging system.
 *
 * Closed discriminated union envelope for all inter-context communication.
 * Each message variant has a `kind` string literal, a `payload` field,
 * and an optional `requestId` for correlating async responses.
 */

// ─── Message Envelope ────────────────────────────────────────────────────────

export interface Message<K extends string, P> {
  readonly kind: K;
  readonly payload: P;
  readonly requestId?: string;
}

// ─── Payload Types ───────────────────────────────────────────────────────────

export interface ExtractRequestedPayload {
  readonly tabId: number;
  readonly selector?: string;
}

export interface ExtractResultPayload {
  readonly ok: boolean;
  readonly article?: {
    readonly title: string;
    readonly author: string | null;
    readonly publicationDate: string | null;
    readonly sourceUrl: string;
    readonly siteName: string;
    readonly bodyMarkdown: string;
    readonly bodyCharacterCount: number;
  };
  readonly confidence?: "high" | "medium" | "low";
  readonly stalePattern?: boolean;
  readonly reason?: string;
  readonly detail?: string;
}

export interface ExportRequestedPayload {
  readonly tabId: number;
  readonly includeSummary?: boolean;
  readonly includeQA: boolean;
  readonly destinations: ReadonlyArray<{ readonly kind: "download" } | { readonly kind: "clipboard" }>;
}

export interface ExportResultPayload {
  readonly ok: boolean;
  readonly filename?: string;
  readonly outcomes?: ReadonlyArray<{
    readonly destination: { readonly kind: "download" } | { readonly kind: "clipboard" };
    readonly ok: boolean;
    readonly reason?: string;
    readonly detail?: string;
  }>;
  readonly reason?: string;
  readonly detail?: string;
}

export interface SettingsChangedPayload {
  readonly schemaVersion: number;
  readonly ai: {
    readonly baseUrl: string;
    readonly modelId: string;
    readonly apiKeyRef: string | null;
    readonly systemPrompt: string;
  };
  readonly export: {
    readonly filenamePattern: string;
    readonly defaultDestination: { readonly kind: "download" } | { readonly kind: "clipboard" };
    readonly frontmatterFields: ReadonlyArray<string>;
  };
  readonly sitePatterns: ReadonlyArray<{
    readonly id: string;
    readonly source: "builtin" | "user";
    readonly urlMatchPattern: string;
    readonly contentSelector: string;
    readonly stale?: boolean;
  }>;
  readonly autoExportConfigs: ReadonlyArray<{
    readonly origin: string;
    readonly enabled: boolean;
    readonly intervalMinutes: number;
    readonly destination: { readonly kind: "download" } | { readonly kind: "clipboard" };
    readonly mode: "content-only" | "full";
    readonly skipIfUnchanged: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
}

export interface ClipboardWritePayload {
  readonly content: string;
}

export interface ClipboardResultPayload {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PickerActivatePayload {
  readonly tabId: number;
}

export interface PickerResultPayload {
  readonly ok: boolean;
  readonly selector?: string;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface ConnectionTestPayload {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
}

export interface ConnectionTestResultPayload {
  readonly ok: boolean;
  readonly reason?: string;
  readonly detail?: string;
}

export interface PatternSavePayload {
  readonly origin: string;
  readonly urlMatchPattern: string;
  readonly contentSelector: string;
}

export interface PatternSaveResultPayload {
  readonly ok: boolean;
  readonly reason?: string;
  readonly detail?: string;
}

export interface AutoExportConfigSavePayload {
  readonly origin: string;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly destination: { readonly kind: "download" } | { readonly kind: "clipboard" };
  readonly mode: "content-only" | "full";
  readonly skipIfUnchanged: boolean;
}

export interface AutoExportConfigDeletePayload {
  readonly origin: string;
}

export interface AutoExportStatusQueryPayload {
  readonly tabId: number;
}

export interface SettingsSaveResultPayload {
  readonly ok: boolean;
  readonly errors?: ReadonlyArray<{ readonly field: string; readonly message: string }>;
}

export interface ApiKeySavePayload {
  readonly apiKey: string;
}

export interface ApiKeySaveResultPayload {
  readonly ok: boolean;
  readonly ref?: string;
  readonly reason?: string;
  readonly detail?: string;
}

export interface SelectorPreviewPayload {
  readonly selector: string;
}

export interface SelectorPreviewResultPayload {
  readonly ok: boolean;
  readonly text?: string;
  readonly reason?: string;
}

export interface AutoExportStatusResultPayload {
  readonly status: {
    readonly tabId: number;
    readonly origin: string;
    readonly lastCaptureTime: string | null;
    readonly nextFireTime: number;
    readonly lastHash: string | null;
    readonly consecutiveFailures: number;
  } | null;
}

// ─── Message Map (kind → payload) ───────────────────────────────────────────

export interface MessagePayloadMap {
  extractRequested: ExtractRequestedPayload;
  extractResult: ExtractResultPayload;
  exportRequested: ExportRequestedPayload;
  exportResult: ExportResultPayload;
  settingsChanged: SettingsChangedPayload;
  clipboardWrite: ClipboardWritePayload;
  clipboardResult: ClipboardResultPayload;
  pickerActivate: PickerActivatePayload;
  pickerResult: PickerResultPayload;
  connectionTest: ConnectionTestPayload;
  connectionTestResult: ConnectionTestResultPayload;
  patternSave: PatternSavePayload;
  patternSaveResult: PatternSaveResultPayload;
  autoExportConfigSave: AutoExportConfigSavePayload;
  autoExportConfigDelete: AutoExportConfigDeletePayload;
  autoExportStatusQuery: AutoExportStatusQueryPayload;
  autoExportStatusResult: AutoExportStatusResultPayload;
  settingsSaveResult: SettingsSaveResultPayload;
  apiKeySave: ApiKeySavePayload;
  apiKeySaveResult: ApiKeySaveResultPayload;
  selectorPreview: SelectorPreviewPayload;
  selectorPreviewResult: SelectorPreviewResultPayload;
}

// ─── Derived Types ───────────────────────────────────────────────────────────

export type MessageKind = keyof MessagePayloadMap;

export type MessageOf<K extends MessageKind> = Message<K, MessagePayloadMap[K]>;

export type AnyMessage = {
  [K in MessageKind]: MessageOf<K>;
}[MessageKind];

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Constructs a validated message envelope from a kind and payload.
 */
export function buildMessage<K extends MessageKind>(
  kind: K,
  payload: MessagePayloadMap[K],
  requestId?: string,
): MessageOf<K> {
  const msg: MessageOf<K> = requestId != null
    ? { kind, payload, requestId } as MessageOf<K>
    : { kind, payload } as MessageOf<K>;
  return msg;
}

/**
 * Validates that a value is a valid message envelope.
 * Returns true if the value is a non-null object with a string `kind`
 * and a `payload` property present.
 */
export function isAnyMessage(value: unknown): value is AnyMessage {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== "string") {
    return false;
  }
  if (!("payload" in obj)) {
    return false;
  }
  return true;
}

/**
 * Type-narrows an unknown value to a specific message variant by kind.
 */
export function isMessageOfKind<K extends MessageKind>(
  value: unknown,
  kind: K,
): value is MessageOf<K> {
  if (!isAnyMessage(value)) {
    return false;
  }
  return value.kind === kind;
}

/**
 * Sends a one-shot message to the background script via browser.runtime.sendMessage.
 */
export async function sendToBackground<K extends MessageKind>(
  kind: K,
  payload: MessagePayloadMap[K],
  requestId?: string,
): Promise<unknown> {
  const msg = buildMessage(kind, payload, requestId);
  return browser.runtime.sendMessage(msg);
}

/**
 * Sends a one-shot message to a specific tab's content script via browser.tabs.sendMessage.
 */
export async function sendToTab<K extends MessageKind>(
  tabId: number,
  kind: K,
  payload: MessagePayloadMap[K],
  requestId?: string,
): Promise<unknown> {
  const msg = buildMessage(kind, payload, requestId);
  return browser.tabs.sendMessage(tabId, msg);
}

// ─── Typed Port ──────────────────────────────────────────────────────────────

export interface TypedPort {
  readonly name: string;
  postMessage<K extends MessageKind>(kind: K, payload: MessagePayloadMap[K], requestId?: string): void;
  onMessage(handler: (msg: AnyMessage) => void): void;
  onDisconnect(handler: () => void): void;
  disconnect(): void;
}

/**
 * Connects to the background via browser.runtime.connect, wrapping the raw port
 * in a typed interface that constrains postMessage to the message union and
 * filters inbound messages through envelope validation.
 */
export function connect(name: string, onMessage?: (msg: AnyMessage) => void): TypedPort {
  const port = browser.runtime.connect({ name });

  const messageHandlers: Array<(msg: AnyMessage) => void> = [];
  const disconnectHandlers: Array<() => void> = [];

  if (onMessage) {
    messageHandlers.push(onMessage);
  }

  port.onMessage.addListener((raw: unknown) => {
    if (!isAnyMessage(raw)) {
      // Discard invalid messages silently
      return;
    }
    for (const handler of messageHandlers) {
      handler(raw);
    }
  });

  port.onDisconnect.addListener(() => {
    for (const handler of disconnectHandlers) {
      handler();
    }
  });

  return {
    name,
    postMessage<K extends MessageKind>(kind: K, payload: MessagePayloadMap[K], requestId?: string): void {
      const msg = buildMessage(kind, payload, requestId);
      port.postMessage(msg);
    },
    onMessage(handler: (msg: AnyMessage) => void): void {
      messageHandlers.push(handler);
    },
    onDisconnect(handler: () => void): void {
      disconnectHandlers.push(handler);
    },
    disconnect(): void {
      port.disconnect();
    },
  };
}
