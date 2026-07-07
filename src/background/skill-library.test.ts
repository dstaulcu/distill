/**
 * Unit tests for the skill library manager (SF-3).
 *
 * Covers CRUD, limits, cascade deletion, activation resolution, and the
 * legacy single-skill migration.
 */

import { describe, it, expect } from "vitest";
import { createSkillLibraryManager, migrateSkillLibrary } from "./skill-library";
import type { StorageAdapter, StorageSetResult } from "@shared/storage";
import type { SkillDefinition, SkillLibrary } from "@shared/types";

function createMockStorage(): StorageAdapter & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<StorageSetResult> {
      data.set(key, value);
      return { ok: true };
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
    subscribe() {
      return () => {};
    },
  };
}

function makeSkill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    personality: `You are ${name}.`,
    knowledge: "",
    commands: "",
    activation: "",
    extras: {},
    systemPrompt: `You are ${name}.`,
  };
}

describe("SF-3 skill library CRUD", () => {
  it("adds a skill with a generated id and persists it", async () => {
    const storage = createMockStorage();
    const manager = createSkillLibraryManager(storage);

    const stored = await manager.addSkill(makeSkill("Pirate"));

    expect(stored.id).toBeTruthy();
    const library = await manager.getLibrary();
    expect(library.skills).toHaveLength(1);
    expect(library.skills[0].name).toBe("Pirate");
  });

  it("replaces a same-named skill, keeping its id and addedAt", async () => {
    const manager = createSkillLibraryManager(createMockStorage());

    const first = await manager.addSkill(makeSkill("Pirate"));
    const updated = await manager.addSkill({ ...makeSkill("Pirate"), description: "v2" });

    expect(updated.id).toBe(first.id);
    expect(updated.addedAt).toBe(first.addedAt);
    const library = await manager.getLibrary();
    expect(library.skills).toHaveLength(1);
    expect(library.skills[0].description).toBe("v2");
  });

  it("enforces the 20-skill limit", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    for (let i = 0; i < 20; i++) {
      await manager.addSkill(makeSkill(`Skill ${i}`));
    }

    await expect(manager.addSkill(makeSkill("One Too Many"))).rejects.toThrow(/full/);
  });

  it("removing a skill cascades: personas lose the reference, empty personas are deleted", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    const a = await manager.addSkill(makeSkill("A"));
    const b = await manager.addSkill(makeSkill("B"));
    const both = await manager.addPersona("Both", "", [a.id, b.id]);
    const onlyA = await manager.addPersona("OnlyA", "", [a.id]);

    await manager.removeSkill(a.id);

    const library = await manager.getLibrary();
    expect(library.skills.map((s) => s.name)).toEqual(["B"]);
    const bothAfter = library.personas.find((p) => p.id === both.id);
    expect(bothAfter?.skillIds).toEqual([b.id]);
    expect(library.personas.find((p) => p.id === onlyA.id)).toBeUndefined();
  });

  it("removing the active skill deactivates it", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    const skill = await manager.addSkill(makeSkill("Active"));
    await manager.activateSkill(skill.id);

    await manager.removeSkill(skill.id);

    const library = await manager.getLibrary();
    expect(library.active).toEqual({ kind: "none" });
  });

  it("enforces the 10-persona limit", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    const skill = await manager.addSkill(makeSkill("S"));
    for (let i = 0; i < 10; i++) {
      await manager.addPersona(`P${i}`, "", [skill.id]);
    }

    await expect(manager.addPersona("Overflow", "", [skill.id])).rejects.toThrow(/limit/);
  });
});

describe("SF-3 activation resolution", () => {
  it("resolves the active skill", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    const skill = await manager.addSkill(makeSkill("Solo"));
    await manager.activateSkill(skill.id);

    const active = await manager.getActiveSkills();
    expect(active.map((s) => s.name)).toEqual(["Solo"]);
  });

  it("resolves a persona to all of its skills in order", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    const a = await manager.addSkill(makeSkill("A"));
    const b = await manager.addSkill(makeSkill("B"));
    const persona = await manager.addPersona("AB", "", [a.id, b.id]);
    await manager.activatePersona(persona.id);

    const active = await manager.getActiveSkills();
    expect(active.map((s) => s.name)).toEqual(["A", "B"]);
  });

  it("returns empty after deactivation and for unknown ids", async () => {
    const manager = createSkillLibraryManager(createMockStorage());
    const skill = await manager.addSkill(makeSkill("S"));
    await manager.activateSkill(skill.id);
    await manager.deactivate();

    expect(await manager.getActiveSkills()).toEqual([]);
    await expect(manager.activateSkill("nope")).rejects.toThrow(/not found/);
    await expect(manager.activatePersona("nope")).rejects.toThrow(/not found/);
  });
});

describe("SF-3 legacy migration", () => {
  it("migrates an old single-skill entry into the library and activates it", async () => {
    const storage = createMockStorage();
    storage.data.set("distill_active_skill", makeSkill("Legacy"));

    await migrateSkillLibrary(storage);

    const library = storage.data.get("distill_skill_library") as SkillLibrary;
    expect(library.skills).toHaveLength(1);
    expect(library.skills[0].name).toBe("Legacy");
    expect(library.active.kind).toBe("skill");
    expect(storage.data.has("distill_active_skill")).toBe(false);
  });

  it("creates an empty library when nothing exists", async () => {
    const storage = createMockStorage();

    await migrateSkillLibrary(storage);

    const library = storage.data.get("distill_skill_library") as SkillLibrary;
    expect(library).toEqual({ schemaVersion: 1, skills: [], personas: [], active: { kind: "none" } });
  });

  it("is idempotent — an existing library is never overwritten", async () => {
    const storage = createMockStorage();
    const manager = createSkillLibraryManager(storage);
    await manager.addSkill(makeSkill("Existing"));
    // A stray legacy entry must not clobber the library
    storage.data.set("distill_active_skill", makeSkill("Stray"));

    await migrateSkillLibrary(storage);

    const library = storage.data.get("distill_skill_library") as SkillLibrary;
    expect(library.skills.map((s) => s.name)).toEqual(["Existing"]);
  });
});
