/**
 * Parses skill markdown files into SkillDefinition objects.
 *
 * A skill file has YAML frontmatter (between `---` markers) with `name` and
 * `description` fields, followed by markdown sections identified by `##` headers.
 * Known sections: Personality, Knowledge, Commands, Activation.
 * All other `##` sections are preserved as extras.
 */

import type { SkillDefinition, SkillParseResult } from "./types";

/**
 * Parses raw skill file content into a SkillDefinition.
 * Returns `{ ok: true, skill }` on success or `{ ok: false, errors }` with
 * specific messages identifying missing/invalid fields.
 */
export function parseSkillFile(raw: string): SkillParseResult {
  const errors: string[] = [];

  // --- Parse YAML frontmatter ---
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return { ok: false, errors: ["Missing or invalid YAML frontmatter"] };
  }

  const frontmatterBlock = frontmatterMatch[1];
  const name = extractFrontmatterField(frontmatterBlock, "name");
  const description = extractFrontmatterField(frontmatterBlock, "description");

  if (!name) {
    errors.push("Missing required frontmatter field: name");
  }
  if (!description) {
    errors.push("Missing required frontmatter field: description");
  }

  // --- Extract sections ---
  const bodyStart = frontmatterMatch[0].length;
  const body = raw.slice(bodyStart);

  const sections = extractSections(body);

  const personality = sections.get("Personality") ?? "";
  const knowledge = sections.get("Knowledge") ?? "";
  const commands = sections.get("Commands") ?? "";
  const activation = sections.get("Activation") ?? "";

  if (!personality.trim()) {
    errors.push("Missing required section: Personality");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Build extras from non-known sections
  const knownSections = new Set(["Personality", "Knowledge", "Commands", "Activation"]);
  const extras: Record<string, string> = {};
  for (const [sectionName, content] of sections) {
    if (!knownSections.has(sectionName)) {
      extras[sectionName] = content.trim();
    }
  }

  const skill: SkillDefinition = {
    name: name!,
    description: description!,
    personality: personality.trim(),
    knowledge: knowledge.trim(),
    commands: commands.trim(),
    activation: activation.trim(),
    extras,
    systemPrompt: buildSkillSystemPrompt({
      name: name!,
      description: description!,
      personality: personality.trim(),
      knowledge: knowledge.trim(),
      commands: commands.trim(),
      activation: activation.trim(),
      extras,
      systemPrompt: "", // placeholder, will be overwritten
    }),
  };

  return { ok: true, skill };
}

/**
 * Builds the system prompt from a SkillDefinition.
 * Concatenates personality, knowledge, commands, and extras with `---` separators.
 * Omits empty sections. NEVER includes activation.
 */
export function buildSkillSystemPrompt(skill: SkillDefinition): string {
  const parts: string[] = [];

  // Personality is always the base (no header)
  if (skill.personality) {
    parts.push(skill.personality);
  }

  // Knowledge section
  if (skill.knowledge) {
    parts.push(`## Knowledge\n${skill.knowledge}`);
  }

  // Commands section
  if (skill.commands) {
    parts.push(`## Commands\n${skill.commands}`);
  }

  // Extra sections
  for (const [sectionName, content] of Object.entries(skill.extras)) {
    if (content.trim()) {
      parts.push(`## ${sectionName}\n${content.trim()}`);
    }
  }

  return parts.join("\n---\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a single field value from YAML frontmatter text using regex.
 * Handles both quoted and unquoted values.
 */
function extractFrontmatterField(
  frontmatter: string,
  field: string,
): string | null {
  // Match: field: "value" or field: 'value' or field: value
  const regex = new RegExp(
    `^${field}:\\s*(?:"([^"]*?)"|'([^']*?)'|(.+?))\\s*$`,
    "m",
  );
  const match = frontmatter.match(regex);
  if (!match) return null;

  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return value || null;
}

/**
 * Extracts all `## SectionName` sections from the body markdown.
 * Returns a Map of section name → content (untrimmed lines after the header).
 */
function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headerRegex = /^## (.+)$/gm;
  const matches: Array<{ name: string; index: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(body)) !== null) {
    matches.push({ name: m[1].trim(), index: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length
      ? body.lastIndexOf("\n##", matches[i + 1].index)
      : body.length;

    // Content is everything between this header's end and the next header start
    const content = body.slice(start, end).replace(/^\r?\n/, "");
    sections.set(matches[i].name, content);
  }

  return sections;
}
