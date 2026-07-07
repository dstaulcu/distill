import { describe, it, expect } from "vitest";
import { parseSkillFile, buildSkillSystemPrompt } from "./skill-parser";
import type { SkillDefinition } from "./types";

const VALID_SKILL = `---
name: Dave
description: A helpful meeting stand-in
---

## Personality
You are Dave, a friendly stand-in for all-hands meetings.

## Knowledge
Dave knows the company org chart and recent announcements.

## Commands
/recap - Summarize the meeting so far
/action - List action items

## Activation
Hey everyone! Dave here, ready to help with today's meeting.
`;

describe("parseSkillFile", () => {
  it("parses a valid skill file correctly", () => {
    const result = parseSkillFile(VALID_SKILL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.skill.name).toBe("Dave");
    expect(result.skill.description).toBe("A helpful meeting stand-in");
    expect(result.skill.personality).toBe(
      "You are Dave, a friendly stand-in for all-hands meetings.",
    );
    expect(result.skill.knowledge).toBe(
      "Dave knows the company org chart and recent announcements.",
    );
    expect(result.skill.commands).toBe(
      "/recap - Summarize the meeting so far\n/action - List action items",
    );
    expect(result.skill.activation).toBe(
      "Hey everyone! Dave here, ready to help with today's meeting.",
    );
    expect(result.skill.extras).toEqual({});
  });

  it("returns error when frontmatter is missing", () => {
    const raw = `## Personality\nSome personality text`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Missing or invalid YAML frontmatter");
  });

  it("returns error when name is missing from frontmatter", () => {
    const raw = `---
description: Some description
---

## Personality
Some personality content.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Missing required frontmatter field: name");
  });

  it("returns error when description is missing from frontmatter", () => {
    const raw = `---
name: TestSkill
---

## Personality
Some personality content.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      "Missing required frontmatter field: description",
    );
  });

  it("returns error when Personality section is missing", () => {
    const raw = `---
name: TestSkill
description: A test
---

## Knowledge
Some knowledge.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Missing required section: Personality");
  });

  it("returns error when Personality section is empty", () => {
    const raw = `---
name: TestSkill
description: A test
---

## Personality

## Knowledge
Some knowledge.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Missing required section: Personality");
  });

  it("returns multiple errors when multiple fields are missing", () => {
    const raw = `---
description: A test
---

## Knowledge
Some knowledge.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Missing required frontmatter field: name");
    expect(result.errors).toContain("Missing required section: Personality");
  });

  it("preserves extra sections", () => {
    const raw = `---
name: TestSkill
description: A test
---

## Personality
Hi there.

## CustomSection
Custom content here.

## AnotherExtra
More custom.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.extras["CustomSection"]).toBe("Custom content here.");
    expect(result.skill.extras["AnotherExtra"]).toBe("More custom.");
  });

  it("handles quoted frontmatter values", () => {
    const raw = `---
name: "Quoted Name"
description: 'Single quoted desc'
---

## Personality
Content here.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.name).toBe("Quoted Name");
    expect(result.skill.description).toBe("Single quoted desc");
  });

  it("handles skill with empty optional sections", () => {
    const raw = `---
name: Minimal
description: Minimal skill
---

## Personality
Just personality.
`;
    const result = parseSkillFile(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.knowledge).toBe("");
    expect(result.skill.commands).toBe("");
    expect(result.skill.activation).toBe("");
  });
});

describe("buildSkillSystemPrompt", () => {
  it("includes personality without a header", () => {
    const skill: SkillDefinition = {
      name: "Test",
      description: "Test skill",
      personality: "You are Test.",
      knowledge: "",
      commands: "",
      activation: "",
      extras: {},
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toBe("You are Test.");
  });

  it("includes knowledge section with header and separator", () => {
    const skill: SkillDefinition = {
      name: "Test",
      description: "Test skill",
      personality: "You are Test.",
      knowledge: "Some knowledge",
      commands: "",
      activation: "",
      extras: {},
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toBe("You are Test.\n---\n## Knowledge\nSome knowledge");
  });

  it("omits empty sections", () => {
    const skill: SkillDefinition = {
      name: "Test",
      description: "Test skill",
      personality: "You are Test.",
      knowledge: "",
      commands: "/help - Show help",
      activation: "Hello!",
      extras: {},
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toBe("You are Test.\n---\n## Commands\n/help - Show help");
    expect(prompt).not.toContain("Knowledge");
  });

  it("never includes activation content", () => {
    const skill: SkillDefinition = {
      name: "Test",
      description: "Test skill",
      personality: "You are Test.",
      knowledge: "Know stuff",
      commands: "/cmd",
      activation: "Hello! I'm your assistant.",
      extras: {},
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).not.toContain("Activation");
    expect(prompt).not.toContain("Hello! I'm your assistant.");
  });

  it("includes extras with their section names", () => {
    const skill: SkillDefinition = {
      name: "Test",
      description: "Test skill",
      personality: "You are Test.",
      knowledge: "",
      commands: "",
      activation: "",
      extras: { "Style Guide": "Use formal English." },
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toBe(
      "You are Test.\n---\n## Style Guide\nUse formal English.",
    );
  });

  it("assembles all sections in correct order", () => {
    const skill: SkillDefinition = {
      name: "Full",
      description: "Full skill",
      personality: "Personality content",
      knowledge: "Knowledge content",
      commands: "Commands content",
      activation: "Greeting",
      extras: { "Extra One": "Extra content" },
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    const expected = [
      "Personality content",
      "---",
      "## Knowledge\nKnowledge content",
      "---",
      "## Commands\nCommands content",
      "---",
      "## Extra One\nExtra content",
    ].join("\n");
    expect(prompt).toBe(expected);
  });

  it("omits extra sections that are empty or whitespace-only", () => {
    const skill: SkillDefinition = {
      name: "Test",
      description: "Test",
      personality: "Base prompt",
      knowledge: "",
      commands: "",
      activation: "",
      extras: { "Blank": "  ", "Filled": "Has content" },
      systemPrompt: "",
    };
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).not.toContain("## Blank");
    expect(prompt).toContain("## Filled\nHas content");
  });
});
