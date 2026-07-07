/**
 * Shared type definitions for Distill v3.
 *
 * Result unions, data models, and settings interfaces used across
 * all extension contexts (background, content, sidebar, options).
 */

// ---------------------------------------------------------------------------
// Result Unions
// ---------------------------------------------------------------------------

/**
 * Discriminated union for expected operation outcomes.
 * The `ok` field is the sole discriminant for TypeScript control-flow narrowing.
 *
 * Success branch carries the payload T.
 * Failure branch carries a typed `reason` (string literal union R) and a
 * human-readable `detail` string (max 200 chars).
 */
export type Result<T, R extends string> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: R; readonly detail: string };

// ---------------------------------------------------------------------------
// Settings & Configuration
// ---------------------------------------------------------------------------

export interface Settings {
  readonly schemaVersion: 1;
  readonly ai: AiConfig;
  readonly export: ExportConfig;
  readonly sitePatterns: ReadonlyArray<SitePattern>;
  readonly autoExportConfigs: ReadonlyArray<AutoExportConfig>;
}

export interface AiConfig {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKeyRef: string | null;
  readonly systemPrompt: string;
}

export interface ExportConfig {
  readonly filenamePattern: string;
  readonly defaultDestination: ExportDestination;
  readonly frontmatterFields: ReadonlyArray<string>;
}

export interface SitePattern {
  readonly id: string;
  readonly source: "builtin" | "user";
  readonly urlMatchPattern: string;
  readonly contentSelector: string;
  readonly stale?: boolean;
}

export type ExportDestination =
  | { readonly kind: "download" }
  | { readonly kind: "clipboard" };

// ---------------------------------------------------------------------------
// Auto Export
// ---------------------------------------------------------------------------

export interface AutoExportConfig {
  readonly origin: string;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly destination: ExportDestination;
  readonly mode: AutoExportMode;
  readonly skipIfUnchanged: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AutoExportMode = "content-only" | "full";

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface Conversation {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly isPartial?: boolean;
}

// ---------------------------------------------------------------------------
// Extracted Article
// ---------------------------------------------------------------------------

export interface ExtractedArticle {
  readonly title: string;
  readonly author: string | null;
  readonly publicationDate: string | null;
  readonly sourceUrl: string;
  readonly siteName: string;
  readonly bodyMarkdown: string;
  readonly bodyCharacterCount: number;
}

// ---------------------------------------------------------------------------
// Tab Context Entry
// ---------------------------------------------------------------------------

export interface TabContextEntry {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly content: string | null;
  readonly confidence: "high" | "medium" | "low" | null;
}

// ---------------------------------------------------------------------------
// Tab State
// ---------------------------------------------------------------------------

export interface TabState {
  readonly url: string;
  readonly title: string;
  readonly summary: string | null;
  readonly conversation: Conversation;
  readonly extractionConfidence: "high" | "medium" | "low" | null;
  readonly consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Skill Definitions
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly personality: string;
  readonly knowledge: string;
  readonly commands: string;
  readonly activation: string;
  readonly extras: Readonly<Record<string, string>>;
  readonly systemPrompt: string; // derived, excludes activation
}

export type SkillParseResult =
  | { readonly ok: true; readonly skill: SkillDefinition }
  | { readonly ok: false; readonly errors: readonly string[] };

// ---------------------------------------------------------------------------
// Skill Library & Personas
// ---------------------------------------------------------------------------

export interface StoredSkill extends SkillDefinition {
  readonly id: string;
  readonly addedAt: string;
}

export interface Persona {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly skillIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ActiveSelection =
  | { readonly kind: "none" }
  | { readonly kind: "skill"; readonly skillId: string }
  | { readonly kind: "persona"; readonly personaId: string };

export interface SkillLibrary {
  readonly schemaVersion: 1;
  readonly skills: readonly StoredSkill[];
  readonly personas: readonly Persona[];
  readonly active: ActiveSelection;
}
