/**
 * Port protocol types for the long-lived connection between sidebar and background.
 *
 * The sidebar connects to the background via browser.runtime.connect("chat")
 * and exchanges typed messages for streaming updates, session management,
 * and auto-export control.
 */

// ─── Sidebar → Controller Messages ──────────────────────────────────────────

export type SidebarToControllerMessage =
  | { readonly type: "init"; readonly tabId: number; readonly url?: string }
  | { readonly type: "summarize" }
  | { readonly type: "sendMessage"; readonly text: string }
  | { readonly type: "abort" }
  | { readonly type: "retry" }
  | { readonly type: "autoExportEnable"; readonly config: AutoExportPortConfig }
  | { readonly type: "autoExportDisable"; readonly origin: string }
  | { readonly type: "autoExportStatusRequest"; readonly tabId: number }
  | { readonly type: "loadSkill"; readonly raw: string }
  | { readonly type: "clearSkill" }
  | { readonly type: "getLibrary" }
  | { readonly type: "activateSkill"; readonly skillId: string }
  | { readonly type: "activatePersona"; readonly personaId: string }
  | { readonly type: "deactivate" }
  | { readonly type: "addContextTab"; readonly tabId: number }
  | { readonly type: "removeContextTab"; readonly tabId: number }
  | { readonly type: "getOpenTabs" };

// ─── Controller → Sidebar Messages ──────────────────────────────────────────

export type ControllerToSidebarMessage =
  | { readonly type: "contextLoaded"; readonly title: string; readonly url: string; readonly confidence: "high" | "medium" | "low"; readonly hasSavedPattern: boolean; readonly wordCount: number }
  | { readonly type: "contextError"; readonly reason: string; readonly canRetry: boolean }
  | { readonly type: "conversationRestored"; readonly messages: ReadonlyArray<PortConversationMessage> }
  | { readonly type: "streamStart" }
  | { readonly type: "streamToken"; readonly token: string }
  | { readonly type: "streamEnd"; readonly fullContent: string }
  | { readonly type: "streamError"; readonly reason: string; readonly partialContent: string; readonly canRetry: boolean }
  | { readonly type: "configError"; readonly reason: string }
  | { readonly type: "autoExportStatus"; readonly status: PortAutoExportStatus | null }
  | { readonly type: "skillLoaded"; readonly name: string; readonly description: string; readonly activation: string | null }
  | { readonly type: "skillCleared" }
  | { readonly type: "skillError"; readonly errors: readonly string[] }
  | { readonly type: "libraryState"; readonly library: SkillLibrarySnapshot }
  | { readonly type: "activationChanged"; readonly active: ActiveSelectionPort; readonly names: readonly string[] }
  | { readonly type: "personaModeReady"; readonly messages?: ReadonlyArray<PortConversationMessage> }
  | { readonly type: "contextTabAdded"; readonly tabId: number; readonly url: string; readonly title: string; readonly confidence: "high" | "medium" | "low" | null }
  | { readonly type: "contextTabFailed"; readonly tabId: number; readonly url: string; readonly title: string; readonly reason: string }
  | { readonly type: "contextTabRemoved"; readonly tabId: number }
  | { readonly type: "openTabs"; readonly tabs: ReadonlyArray<{ readonly tabId: number; readonly title: string; readonly url: string }> };

// ─── Skill Library Types ────────────────────────────────────────────────────

export interface SkillLibrarySnapshot {
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description: string }[];
  readonly personas: readonly { readonly id: string; readonly name: string; readonly description: string; readonly skillNames: readonly string[] }[];
  readonly active: ActiveSelectionPort;
}

export type ActiveSelectionPort =
  | { readonly kind: "none" }
  | { readonly kind: "skill"; readonly skillId: string }
  | { readonly kind: "persona"; readonly personaId: string };

// ─── Supporting Types ────────────────────────────────────────────────────────

export interface PortConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly isPartial?: boolean;
}

export interface AutoExportPortConfig {
  readonly origin: string;
  readonly intervalMinutes: number;
  readonly destination: { readonly kind: "download" } | { readonly kind: "clipboard" };
  readonly mode: "content-only" | "full";
  readonly skipIfUnchanged: boolean;
}

export interface PortAutoExportStatus {
  readonly tabId: number;
  readonly origin: string;
  readonly lastCaptureTime: string | null;
  readonly nextFireTime: number;
  readonly lastHash: string | null;
  readonly consecutiveFailures: number;
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

/**
 * Validates that a value is a valid SidebarToControllerMessage.
 */
export function isSidebarToControllerMessage(value: unknown): value is SidebarToControllerMessage {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return false;
  }
  const validTypes: ReadonlyArray<string> = [
    "init",
    "summarize",
    "sendMessage",
    "abort",
    "retry",
    "autoExportEnable",
    "autoExportDisable",
    "autoExportStatusRequest",
    "loadSkill",
    "clearSkill",
    "getLibrary",
    "activateSkill",
    "activatePersona",
    "deactivate",
    "addContextTab",
    "removeContextTab",
    "getOpenTabs",
  ];
  return validTypes.includes(obj.type);
}

/**
 * Validates that a value is a valid ControllerToSidebarMessage.
 */
export function isControllerToSidebarMessage(value: unknown): value is ControllerToSidebarMessage {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return false;
  }
  const validTypes: ReadonlyArray<string> = [
    "contextLoaded",
    "contextError",
    "conversationRestored",
    "streamStart",
    "streamToken",
    "streamEnd",
    "streamError",
    "configError",
    "autoExportStatus",
    "skillLoaded",
    "skillCleared",
    "skillError",
    "libraryState",
    "activationChanged",
    "personaModeReady",
    "contextTabAdded",
    "contextTabFailed",
    "contextTabRemoved",
    "openTabs",
  ];
  return validTypes.includes(obj.type);
}
