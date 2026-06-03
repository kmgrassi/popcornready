import { promises as fs } from "fs";
import path from "path";
import {
  AssetGenerationJob,
  CharacterConsistencyReview,
  CharacterProfile,
  CharacterReference,
  CharacterReferenceQuality,
  CharacterReferenceRole,
  Clip,
  CompositionPlan,
  Project,
} from "@popcorn/shared/types";
import { ensureBeatIds } from "@popcorn/shared/edit-graph";
import type { Asset } from "@popcorn/shared/assets/types";
import { poolAssets } from "./assets/pool";
import {
  buildProvenanceGraph,
  computeCandidateStaleSet,
  freezeFingerprints,
} from "./provenance";
import type { ProvenanceGraph, StaleCandidate } from "./provenance";

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
    compositions: [],
    assetGenerationJobs: [],
    critic: null,
    chat: [],
    updatedAt: new Date().toISOString(),
  };
}

function ensureCollections(p: Project): Project {
  p.characterProfiles ||= [];
  p.characterReferences ||= [];
  p.compositions ||= [];
  p.assetGenerationJobs ||= [];
  p.assets ||= [];
  p.selections ||= [];
  // Migration: backfill stable beat ids for plans persisted before Beat.id.
  if (p.plan) ensureBeatIds(p.plan);
  return p;
}

export async function getProject(): Promise<Project> {
  try {
    const raw = await fs.readFile(PROJECT_FILE, "utf8");
    return ensureCollections(JSON.parse(raw) as Project);
  } catch {
    const p = emptyProject();
    await saveProject(p);
    return p;
  }
}

export async function saveProject(p: Project): Promise<Project> {
  p.updatedAt = new Date().toISOString();
  // Freeze provenance fingerprints onto any newly-pooled assets (write-once), so
  // the candidate-stale walk has a baseline to compare the current plan against.
  if (p.assets && p.assets.length) {
    p.assets = freezeFingerprints(p.assets, p.plan);
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROJECT_FILE, JSON.stringify(p, null, 2), "utf8");
  return p;
}

// Provenance read API (provenance-graph lane, task #7) — the surface the
// orchestrator/agent reasons over. The candidate set is a *signal*: it names
// assets whose inputs drifted from the current plan, never an auto-regeneration.
//
// Reads build over the UNIFIED pool (`poolAssets`): explicit pooled assets
// (keyframes, character anchor) PLUS the generated beat videos that still live
// in `clips[]`, projected via `clipToAsset`. Until Clip/Asset convergence (the
// store-consolidation lane) the generated clips are not pooled explicitly, so
// without this projection the graph would omit clip nodes and their
// `generatedBy.inputs.firstFrameAssetId` keyframe edges entirely. (Clips carry
// no frozen fingerprint baseline yet, so they appear as graph nodes/edges but
// not as stale candidates — full clip staleness arrives with convergence.)
export async function getProvenanceGraph(): Promise<ProvenanceGraph> {
  const p = await getProject();
  return buildProvenanceGraph(poolAssets(p));
}

export async function getStaleCandidates(): Promise<StaleCandidate[]> {
  const p = await getProject();
  return computeCandidateStaleSet(poolAssets(p), p.plan);
}

export async function addClip(clip: Clip): Promise<Project> {
  const p = await getProject();
  p.clips.push(clip);
  return saveProject(p);
}

// Append a self-describing asset to the project-scoped pool (append-only; never
// deletes). Used by the keyframe/anchor flows (asset-pool PRs D/E).
export async function addAsset(asset: Asset): Promise<Project> {
  const p = await getProject();
  p.assets ??= [];
  if (!p.assets.some((existing) => existing.id === asset.id)) {
    p.assets.push(asset);
  }
  return saveProject(p);
}

export async function createCharacterProfile(
  input: CreateCharacterProfileInput
): Promise<{ project: Project; character: CharacterProfile }> {
  const p = ensureCollections(await getProject());
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
  const p = ensureCollections(await getProject());
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
  const p = ensureCollections(await getProject());
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
  const p = ensureCollections(await getProject());
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
  const p = ensureCollections(await getProject());
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
  const p = ensureCollections(await getProject());
  p.characterReferences = p.characterReferences!.filter(
    (r) => !(r.id === referenceId && r.characterProfileId === characterId)
  );
  return saveProject(p);
}

export async function updateGeneratedAssetReview(
  assetId: string,
  review: CharacterConsistencyReview
): Promise<Project> {
  const p = ensureCollections(await getProject());
  const clip = p.clips.find((candidate) => candidate.id === assetId);
  if (!clip) throw new Error(`Generated asset not found: ${assetId}`);
  const binding = clip.generatedBy?.characterBinding || clip.characterBinding;
  if (!binding) {
    throw new Error("Generated asset has no character binding to review.");
  }
  binding.consistencyReview = review;
  if (clip.characterBinding && clip.characterBinding !== binding) {
    clip.characterBinding.consistencyReview = review;
  }
  return saveProject(p);
}

export async function saveComposition(
  composition: CompositionPlan,
  jobs: AssetGenerationJob[]
): Promise<{ project: Project; composition: CompositionPlan }> {
  const p = ensureCollections(await getProject());
  p.compositions!.push(composition);
  p.assetGenerationJobs!.push(...jobs);
  await saveProject(p);
  return { project: p, composition };
}

export async function getComposition(
  compositionId: string
): Promise<{ composition: CompositionPlan; jobs: AssetGenerationJob[] } | null> {
  const p = ensureCollections(await getProject());
  const composition = p.compositions!.find((c) => c.id === compositionId);
  if (!composition) return null;
  const jobs = p.assetGenerationJobs!.filter(
    (j) => j.compositionId === compositionId
  );
  return { composition, jobs };
}

export async function findCompositionByIdempotencyKey(
  key: string
): Promise<CompositionPlan | null> {
  const p = ensureCollections(await getProject());
  return p.compositions!.find((c) => c.idempotencyKey === key) || null;
}
