import { promises as fs } from "fs";
import path from "path";
import {
  CharacterProfile,
  CharacterReference,
  CharacterReferenceQuality,
  CharacterReferenceRole,
  Clip,
  Project,
} from "./types";

// MVP persistence: a single project in a JSON file. Swap for Postgres later.
const DATA_DIR = path.join(process.cwd(), "data");
const PROJECT_FILE = path.join(DATA_DIR, "project.json");

type CreateCharacterProfileInput = {
  name: string;
  description?: string;
  identityInvariants: string;
  styleInvariants?: string;
  wardrobeInvariants?: string;
  negativePrompt?: string;
  status?: CharacterProfile["status"];
};

type UpdateCharacterProfileInput = Partial<
  Omit<CharacterProfile, "id" | "projectId" | "createdAt" | "updatedAt">
>;

type UpsertCharacterReferenceInput = {
  assetId: string;
  role: CharacterReferenceRole;
  quality?: CharacterReferenceQuality;
  notes?: string;
};

type UpdateCharacterReferenceInput = Partial<
  Pick<CharacterReference, "role" | "quality" | "notes">
>;

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function requireNonBlank(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} cannot be blank.`);
  return trimmed;
}

function emptyProject(): Project {
  return {
    id: "default",
    goal: "",
    plan: null,
    timeline: null,
    clips: [],
    characterProfiles: [],
    characterReferences: [],
    critic: null,
    chat: [],
    updatedAt: new Date().toISOString(),
  };
}

function ensureCharacterCollections(p: Project): Project {
  p.characterProfiles ||= [];
  p.characterReferences ||= [];
  return p;
}

export async function getProject(): Promise<Project> {
  try {
    const raw = await fs.readFile(PROJECT_FILE, "utf8");
    return ensureCharacterCollections(JSON.parse(raw) as Project);
  } catch {
    const p = emptyProject();
    await saveProject(p);
    return p;
  }
}

export async function saveProject(p: Project): Promise<Project> {
  p.updatedAt = new Date().toISOString();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROJECT_FILE, JSON.stringify(p, null, 2), "utf8");
  return p;
}

export async function addClip(clip: Clip): Promise<Project> {
  const p = await getProject();
  p.clips.push(clip);
  return saveProject(p);
}

export async function createCharacterProfile(
  input: CreateCharacterProfileInput
): Promise<{ project: Project; character: CharacterProfile }> {
  const p = ensureCharacterCollections(await getProject());
  const now = new Date().toISOString();
  const character: CharacterProfile = {
    id: newId("char"),
    projectId: p.id,
    name: requireNonBlank(input.name, "name"),
    description: (input.description || "").trim(),
    identityInvariants: requireNonBlank(
      input.identityInvariants,
      "identityInvariants"
    ),
    styleInvariants: input.styleInvariants?.trim() || undefined,
    wardrobeInvariants: input.wardrobeInvariants?.trim() || undefined,
    negativePrompt: input.negativePrompt?.trim() || undefined,
    status: input.status || "draft",
    createdAt: now,
    updatedAt: now,
  };

  p.characterProfiles!.push(character);
  await saveProject(p);
  return { project: p, character };
}

export async function updateCharacterProfile(
  characterId: string,
  input: UpdateCharacterProfileInput
): Promise<{ project: Project; character: CharacterProfile }> {
  const p = ensureCharacterCollections(await getProject());
  const character = p.characterProfiles!.find((c) => c.id === characterId);
  if (!character) throw new Error(`Character profile not found: ${characterId}`);

  if (input.name !== undefined) {
    character.name = requireNonBlank(input.name, "name");
  }
  if (input.description !== undefined) {
    character.description = input.description.trim();
  }
  if (input.identityInvariants !== undefined) {
    character.identityInvariants = requireNonBlank(
      input.identityInvariants,
      "identityInvariants"
    );
  }
  if (input.styleInvariants !== undefined) {
    character.styleInvariants = input.styleInvariants?.trim() || undefined;
  }
  if (input.wardrobeInvariants !== undefined) {
    character.wardrobeInvariants =
      input.wardrobeInvariants?.trim() || undefined;
  }
  if (input.negativePrompt !== undefined) {
    character.negativePrompt = input.negativePrompt?.trim() || undefined;
  }
  if (input.status !== undefined) character.status = input.status;
  character.updatedAt = new Date().toISOString();

  await saveProject(p);
  return { project: p, character };
}

export async function deleteCharacterProfile(characterId: string): Promise<Project> {
  const p = ensureCharacterCollections(await getProject());
  p.characterProfiles = p.characterProfiles!.filter((c) => c.id !== characterId);
  p.characterReferences = p.characterReferences!.filter(
    (r) => r.characterProfileId !== characterId
  );
  return saveProject(p);
}

export async function attachCharacterReference(
  characterId: string,
  input: UpsertCharacterReferenceInput
): Promise<{ project: Project; reference: CharacterReference }> {
  const p = ensureCharacterCollections(await getProject());
  if (!p.characterProfiles!.some((c) => c.id === characterId)) {
    throw new Error(`Character profile not found: ${characterId}`);
  }
  if (!p.clips.some((clip) => clip.id === input.assetId)) {
    throw new Error(`Reference asset not found: ${input.assetId}`);
  }

  const reference: CharacterReference = {
    id: newId("ref"),
    characterProfileId: characterId,
    assetId: input.assetId,
    role: input.role,
    quality: input.quality || "candidate",
    notes: input.notes?.trim() || undefined,
  };
  p.characterReferences!.push(reference);
  await saveProject(p);
  return { project: p, reference };
}

export async function updateCharacterReference(
  characterId: string,
  referenceId: string,
  input: UpdateCharacterReferenceInput
): Promise<{ project: Project; reference: CharacterReference }> {
  const p = ensureCharacterCollections(await getProject());
  const reference = p.characterReferences!.find(
    (r) => r.id === referenceId && r.characterProfileId === characterId
  );
  if (!reference) throw new Error(`Character reference not found: ${referenceId}`);

  if (input.role !== undefined) reference.role = input.role;
  if (input.quality !== undefined) reference.quality = input.quality;
  if (input.notes !== undefined) reference.notes = input.notes.trim() || undefined;
  await saveProject(p);
  return { project: p, reference };
}

export async function promoteCharacterReference(
  characterId: string,
  referenceId: string
): Promise<{ project: Project; reference: CharacterReference }> {
  return updateCharacterReference(characterId, referenceId, {
    quality: "approved",
  });
}

export async function removeCharacterReference(
  characterId: string,
  referenceId: string
): Promise<Project> {
  const p = ensureCharacterCollections(await getProject());
  p.characterReferences = p.characterReferences!.filter(
    (r) => !(r.id === referenceId && r.characterProfileId === characterId)
  );
  return saveProject(p);
}
