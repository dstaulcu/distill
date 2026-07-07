import type { SkillDefinition, StoredSkill, Persona, ActiveSelection, SkillLibrary } from "@shared/types";
import { createLocalStorageAdapter, type StorageAdapter } from "@shared/storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "distill_skill_library";
const OLD_STORAGE_KEY = "distill_active_skill";
const MAX_SKILLS = 20;
const MAX_PERSONAS = 10;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SkillLibraryManager {
  getLibrary(): Promise<SkillLibrary>;
  addSkill(skill: SkillDefinition): Promise<StoredSkill>;
  removeSkill(id: string): Promise<void>;
  updateSkill(id: string, skill: SkillDefinition): Promise<StoredSkill>;
  addPersona(name: string, description: string, skillIds: string[]): Promise<Persona>;
  removePersona(id: string): Promise<void>;
  updatePersona(id: string, patch: { name?: string; description?: string; skillIds?: string[] }): Promise<Persona>;
  activateSkill(id: string): Promise<void>;
  activatePersona(id: string): Promise<void>;
  deactivate(): Promise<void>;
  getActiveSkills(): Promise<SkillDefinition[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSkillLibraryManager(storage?: StorageAdapter): SkillLibraryManager {
  const store = storage ?? createLocalStorageAdapter();

  async function load(): Promise<SkillLibrary> {
    const data = await store.get<SkillLibrary>(STORAGE_KEY);
    if (data && typeof data === "object" && data.schemaVersion === 1) {
      return data;
    }
    return { schemaVersion: 1, skills: [], personas: [], active: { kind: "none" } };
  }

  async function save(library: SkillLibrary): Promise<void> {
    await store.set(STORAGE_KEY, library);
  }

  function generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return {
    async getLibrary(): Promise<SkillLibrary> {
      return load();
    },

    async addSkill(skill: SkillDefinition): Promise<StoredSkill> {
      const library = await load();
      // Replace if same name exists
      const existingIndex = library.skills.findIndex((s) => s.name === skill.name);
      const id = existingIndex >= 0 ? library.skills[existingIndex].id : generateId("skill");
      const stored: StoredSkill = {
        ...skill,
        id,
        addedAt: existingIndex >= 0 ? library.skills[existingIndex].addedAt : new Date().toISOString(),
      };

      let skills: StoredSkill[];
      if (existingIndex >= 0) {
        skills = [...library.skills];
        skills[existingIndex] = stored;
      } else {
        if (library.skills.length >= MAX_SKILLS) {
          throw new Error(`Skill library is full (max ${MAX_SKILLS})`);
        }
        skills = [...library.skills, stored];
      }

      await save({ ...library, skills });
      return stored;
    },

    async removeSkill(id: string): Promise<void> {
      const library = await load();
      const skills = library.skills.filter((s) => s.id !== id);

      // Remove from personas that reference it
      let personas = library.personas.map((p) => {
        const filtered = p.skillIds.filter((sid) => sid !== id);
        return filtered.length === p.skillIds.length ? p : { ...p, skillIds: filtered, updatedAt: new Date().toISOString() };
      });
      // Delete empty personas
      personas = personas.filter((p) => p.skillIds.length > 0);

      // Deactivate if the removed skill was active
      let active = library.active;
      if (active.kind === "skill" && active.skillId === id) {
        active = { kind: "none" };
      } else if (active.kind === "persona") {
        const personaId = active.personaId;
        const persona = personas.find((p) => p.id === personaId);
        if (!persona) {
          active = { kind: "none" };
        }
      }

      await save({ ...library, skills, personas, active });
    },

    async updateSkill(id: string, skill: SkillDefinition): Promise<StoredSkill> {
      const library = await load();
      const index = library.skills.findIndex((s) => s.id === id);
      if (index < 0) throw new Error("Skill not found");

      const stored: StoredSkill = { ...skill, id, addedAt: library.skills[index].addedAt };
      const skills = [...library.skills];
      skills[index] = stored;

      await save({ ...library, skills });
      return stored;
    },

    async addPersona(name: string, description: string, skillIds: string[]): Promise<Persona> {
      const library = await load();
      if (library.personas.length >= MAX_PERSONAS) {
        throw new Error(`Persona limit reached (max ${MAX_PERSONAS})`);
      }
      const now = new Date().toISOString();
      const persona: Persona = {
        id: generateId("persona"),
        name,
        description,
        skillIds,
        createdAt: now,
        updatedAt: now,
      };
      await save({ ...library, personas: [...library.personas, persona] });
      return persona;
    },

    async removePersona(id: string): Promise<void> {
      const library = await load();
      const personas = library.personas.filter((p) => p.id !== id);
      let active = library.active;
      if (active.kind === "persona" && active.personaId === id) {
        active = { kind: "none" };
      }
      await save({ ...library, personas, active });
    },

    async updatePersona(id: string, patch: { name?: string; description?: string; skillIds?: string[] }): Promise<Persona> {
      const library = await load();
      const index = library.personas.findIndex((p) => p.id === id);
      if (index < 0) throw new Error("Persona not found");

      const existing = library.personas[index];
      const updated: Persona = {
        ...existing,
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        skillIds: patch.skillIds ?? existing.skillIds,
        updatedAt: new Date().toISOString(),
      };
      const personas = [...library.personas];
      personas[index] = updated;

      await save({ ...library, personas });
      return updated;
    },

    async activateSkill(id: string): Promise<void> {
      const library = await load();
      if (!library.skills.some((s) => s.id === id)) throw new Error("Skill not found");
      await save({ ...library, active: { kind: "skill", skillId: id } });
    },

    async activatePersona(id: string): Promise<void> {
      const library = await load();
      if (!library.personas.some((p) => p.id === id)) throw new Error("Persona not found");
      await save({ ...library, active: { kind: "persona", personaId: id } });
    },

    async deactivate(): Promise<void> {
      const library = await load();
      await save({ ...library, active: { kind: "none" } });
    },

    async getActiveSkills(): Promise<SkillDefinition[]> {
      const library = await load();
      const active = library.active;
      if (active.kind === "none") return [];
      if (active.kind === "skill") {
        const skill = library.skills.find((s) => s.id === active.skillId);
        return skill ? [skill] : [];
      }
      // persona
      const persona = library.personas.find((p) => p.id === active.personaId);
      if (!persona) return [];
      return persona.skillIds
        .map((sid) => library.skills.find((s) => s.id === sid))
        .filter((s): s is StoredSkill => s != null);
    },
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export async function migrateSkillLibrary(storage?: StorageAdapter): Promise<void> {
  const store = storage ?? createLocalStorageAdapter();

  const existing = await store.get<SkillLibrary>(STORAGE_KEY);
  if (existing && typeof existing === "object" && existing.schemaVersion === 1) return;

  const oldSkill = await store.get<SkillDefinition>(OLD_STORAGE_KEY);

  let library: SkillLibrary = {
    schemaVersion: 1,
    skills: [],
    personas: [],
    active: { kind: "none" },
  };

  if (oldSkill && typeof oldSkill === "object" && typeof oldSkill.name === "string" && oldSkill.name) {
    const stored: StoredSkill = {
      ...oldSkill,
      id: `skill-migrated-${Date.now()}`,
      addedAt: new Date().toISOString(),
    };
    library = {
      schemaVersion: 1,
      skills: [stored],
      personas: [],
      active: { kind: "skill", skillId: stored.id },
    };
  }

  await store.set(STORAGE_KEY, library);
  await store.remove(OLD_STORAGE_KEY);
}
