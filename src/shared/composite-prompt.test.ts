import { describe, it, expect } from "vitest";
import { buildCompositePrompt, MAX_PAGE_CONTENT_CHARS } from "./composite-prompt";
import type { SkillDefinition, ExtractedArticle } from "./types";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "Test Skill",
    description: "A test skill",
    personality: "You are a helpful test assistant.",
    knowledge: "Some knowledge content.",
    commands: "Reply concisely.",
    activation: "Hello! I'm your test assistant.",
    extras: {},
    systemPrompt: "",
    ...overrides,
  };
}

function makeArticle(overrides: Partial<ExtractedArticle> = {}): ExtractedArticle {
  return {
    title: "Test Article",
    author: "Author",
    publicationDate: "2024-01-01",
    sourceUrl: "https://example.com/article",
    siteName: "Example",
    bodyMarkdown: "This is the article body content.",
    bodyCharacterCount: 33,
    ...overrides,
  };
}

describe("buildCompositePrompt", () => {
  describe("with article present", () => {
    it("includes Page Context block between Knowledge and Commands", () => {
      const skill = makeSkill();
      const article = makeArticle();

      const result = buildCompositePrompt({ skill, article });

      expect(result).toContain("## Page Context");
      expect(result).toContain("Title: Test Article");
      expect(result).toContain("URL: https://example.com/article");
      expect(result).toContain("This is the article body content.");

      // Verify ordering: Knowledge before Page Context before Commands
      const knowledgeIdx = result.indexOf("## Knowledge");
      const pageCtxIdx = result.indexOf("## Page Context");
      const commandsIdx = result.indexOf("## Commands");

      expect(knowledgeIdx).toBeLessThan(pageCtxIdx);
      expect(pageCtxIdx).toBeLessThan(commandsIdx);
    });

    it("includes personality content without a header", () => {
      const skill = makeSkill({ personality: "You are Dave." });
      const article = makeArticle();

      const result = buildCompositePrompt({ skill, article });

      expect(result).toContain("You are Dave.");
      expect(result).not.toContain("## Personality");
    });
  });

  describe("without article", () => {
    it("omits Page Context block when article is null", () => {
      const skill = makeSkill();

      const result = buildCompositePrompt({ skill, article: null });

      expect(result).not.toContain("## Page Context");
      expect(result).not.toContain("Title:");
      expect(result).not.toContain("URL:");
    });

    it("omits Page Context block when article is undefined", () => {
      const skill = makeSkill();

      const result = buildCompositePrompt({ skill });

      expect(result).not.toContain("## Page Context");
    });

    it("still includes personality, knowledge, and commands", () => {
      const skill = makeSkill();

      const result = buildCompositePrompt({ skill, article: null });

      expect(result).toContain("You are a helpful test assistant.");
      expect(result).toContain("## Knowledge");
      expect(result).toContain("## Commands");
    });
  });

  describe("empty sections omitted", () => {
    it("omits Knowledge section when empty", () => {
      const skill = makeSkill({ knowledge: "" });

      const result = buildCompositePrompt({ skill, article: null });

      expect(result).not.toContain("## Knowledge");
    });

    it("omits Commands section when empty", () => {
      const skill = makeSkill({ commands: "" });

      const result = buildCompositePrompt({ skill, article: null });

      expect(result).not.toContain("## Commands");
    });

    it("omits personality when empty (starts with next section)", () => {
      const skill = makeSkill({ personality: "" });

      const result = buildCompositePrompt({ skill, article: null });

      expect(result.startsWith("## Knowledge")).toBe(true);
    });

    it("omits extras with empty content", () => {
      const skill = makeSkill({ extras: { "References": "", "Notes": "Some notes" } });

      const result = buildCompositePrompt({ skill, article: null });

      expect(result).not.toContain("## References");
      expect(result).toContain("## Notes");
      expect(result).toContain("Some notes");
    });

    it("does not produce empty --- blocks", () => {
      const skill = makeSkill({ knowledge: "", commands: "" });

      const result = buildCompositePrompt({ skill, article: null });

      // Should not have consecutive separators (i.e. ---\n\n---)
      expect(result).not.toMatch(/---\n\n---/);
    });
  });

  describe("activation never included", () => {
    it("does not include activation content in the output", () => {
      const skill = makeSkill({
        activation: "Hello! I'm your specialized assistant ready to help.",
      });

      const result = buildCompositePrompt({ skill, article: makeArticle() });

      expect(result).not.toContain(
        "Hello! I'm your specialized assistant ready to help."
      );
      expect(result).not.toContain("## Activation");
    });

    it("does not include activation even when other sections reference similar text", () => {
      const activationText = "Greetings! I am the all-hands meeting bot.";
      const skill = makeSkill({ activation: activationText });

      const result = buildCompositePrompt({ skill, article: null });

      expect(result).not.toContain(activationText);
    });
  });

  describe("body truncation at 50k chars", () => {
    it("truncates body to MAX_PAGE_CONTENT_CHARS", () => {
      const longBody = "x".repeat(MAX_PAGE_CONTENT_CHARS + 5000);
      const article = makeArticle({ bodyMarkdown: longBody });
      const skill = makeSkill();

      const result = buildCompositePrompt({ skill, article });

      // The body in the output should be exactly MAX_PAGE_CONTENT_CHARS long
      const pageCtxStart = result.indexOf("## Page Context");
      const bodyStart = result.indexOf("\n\n", pageCtxStart + "## Page Context\nTitle: ".length) + 2;
      const nextSeparator = result.indexOf("\n\n---\n", bodyStart);
      const bodyInOutput = result.slice(bodyStart, nextSeparator);

      expect(bodyInOutput.length).toBe(MAX_PAGE_CONTENT_CHARS);
    });

    it("does not truncate body under 50k chars", () => {
      const body = "a".repeat(1000);
      const article = makeArticle({ bodyMarkdown: body });
      const skill = makeSkill();

      const result = buildCompositePrompt({ skill, article });

      expect(result).toContain(body);
    });

    it("MAX_PAGE_CONTENT_CHARS equals 50000", () => {
      expect(MAX_PAGE_CONTENT_CHARS).toBe(50000);
    });
  });

  describe("extras sections", () => {
    it("includes non-empty extras after commands", () => {
      const skill = makeSkill({
        extras: { "References": "See docs at /wiki" },
      });

      const result = buildCompositePrompt({ skill, article: null });

      const commandsIdx = result.indexOf("## Commands");
      const extrasIdx = result.indexOf("## References");

      expect(extrasIdx).toBeGreaterThan(commandsIdx);
      expect(result).toContain("See docs at /wiki");
    });
  });
});
