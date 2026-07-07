/**
 * Builds a composite system prompt from a SkillDefinition and optional extracted article.
 *
 * Format:
 *   [personality content, no header]
 *   ---
 *   ## Knowledge
 *   [skill knowledge]
 *   ---
 *   ## Page Context
 *   Title: {title}
 *   URL: {url}
 *   [body markdown, ≤50k chars]
 *   ---
 *   ## Commands
 *   [skill commands]
 *   ---
 *   ## [Extra sections]
 *
 * Rules:
 * - Empty sections are omitted entirely (no empty `---` blocks)
 * - Activation is NEVER included
 * - Page Context is omitted when article is null/undefined
 * - The 50,000-char truncation applies to the body only
 * - Page Context goes between Knowledge and Commands
 */

import type { SkillDefinition, ExtractedArticle } from "./types";

export const MAX_PAGE_CONTENT_CHARS = 50_000;

export interface CompositePromptInput {
  readonly skill?: SkillDefinition;
  readonly skills?: readonly SkillDefinition[];
  readonly article?: ExtractedArticle | null;
  readonly articles?: ReadonlyArray<ExtractedArticle>;
}

export function buildCompositePrompt(input: CompositePromptInput): string {
  const skills = input.skills ?? (input.skill ? [input.skill] : []);
  if (skills.length === 0) return "";

  // Resolve articles: prefer explicit `articles` array, fall back to single `article`
  const articles: ReadonlyArray<ExtractedArticle> =
    input.articles ?? (input.article ? [input.article] : []);

  const sections: string[] = [];

  // Personality: first skill is base, subsequent add perspective
  const personalities = skills.map((s) => s.personality.trim()).filter(Boolean);
  if (personalities.length > 0) {
    const merged = personalities.length === 1
      ? personalities[0]
      : personalities[0] + personalities.slice(1).map((p) => `\n\nYou also incorporate the following perspective:\n${p}`).join("");
    sections.push(merged);
  }

  // Knowledge: concatenate all
  const knowledgeParts = skills.map((s) => s.knowledge.trim()).filter(Boolean);
  if (knowledgeParts.length > 0) {
    sections.push(`## Knowledge\n${knowledgeParts.join("\n\n")}`);
  }

  // Page Context (one or more articles)
  if (articles.length === 1) {
    const a = articles[0];
    const truncatedBody = a.bodyMarkdown.slice(0, MAX_PAGE_CONTENT_CHARS);
    sections.push(`## Page Context\nTitle: ${a.title}\nURL: ${a.sourceUrl}\n\n${truncatedBody}`);
  } else if (articles.length > 1) {
    const subsections = articles.map((a) => {
      const truncatedBody = a.bodyMarkdown.slice(0, MAX_PAGE_CONTENT_CHARS);
      return `### ${a.title}\nURL: ${a.sourceUrl}\n\n${truncatedBody}`;
    });
    sections.push(`## Page Context\n\n${subsections.join("\n\n")}`);
  }

  // Commands: union all
  const commandParts = skills.map((s) => s.commands.trim()).filter(Boolean);
  if (commandParts.length > 0) {
    sections.push(`## Commands\n${commandParts.join("\n\n")}`);
  }

  // Extras: merge by section name
  const extrasMap = new Map<string, string[]>();
  for (const skill of skills) {
    for (const [name, content] of Object.entries(skill.extras)) {
      if (content.trim()) {
        const existing = extrasMap.get(name) ?? [];
        existing.push(content.trim());
        extrasMap.set(name, existing);
      }
    }
  }
  for (const [name, parts] of extrasMap) {
    sections.push(`## ${name}\n${parts.join("\n\n")}`);
  }

  return sections.join("\n\n---\n");
}
