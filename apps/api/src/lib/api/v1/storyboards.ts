import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "./auth";
import { ApiError, notFound } from "./errors";
import { getProject } from "./store";
import { getServiceSupabase } from "@/lib/supabase/clients";
import { isMissingRow, throwDatabaseError } from "@/lib/supabase/db-errors";

type StoryboardStatus =
  | "draft"
  | "generating"
  | "ready"
  | "reviewing"
  | "approved"
  | "archived";
type StoryboardItemStatus =
  | "draft"
  | "queued"
  | "generating"
  | "ready"
  | "approved"
  | "rejected"
  | "failed";

const STORYBOARD_STATUSES: StoryboardStatus[] = [
  "draft",
  "generating",
  "ready",
  "reviewing",
  "approved",
  "archived",
];
const ITEM_STATUSES: StoryboardItemStatus[] = [
  "draft",
  "queued",
  "generating",
  "ready",
  "approved",
  "rejected",
  "failed",
];

interface StoryboardRow {
  id: string;
  project_id: string;
  plan_asset_id: string | null;
  status: StoryboardStatus;
  created_by_action_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StoryboardSceneRow {
  id: string;
  project_id: string;
  storyboard_id: string;
  scene_index: number;
  title: string | null;
  summary: string | null;
  setting: string | null;
  mood: string | null;
  duration_sec: number | null;
  scene_asset_id: string | null;
  status: StoryboardItemStatus;
  created_at: string;
  updated_at: string;
}

interface StoryboardBeatRow {
  id: string;
  project_id: string;
  scene_id: string;
  beat_index: number;
  intent: string;
  visual_description: string | null;
  dialogue_summary: string | null;
  narration: string | null;
  duration_sec: number | null;
  status: StoryboardItemStatus;
  beat_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StoryboardPanelRow {
  id: string;
  project_id: string;
  beat_id: string;
  panel_index: number;
  image_asset_id: string | null;
  prompt_asset_id: string | null;
  status: StoryboardItemStatus;
  is_selected: boolean;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BeatAssetRow {
  id: string;
  lineage_id: string;
  version: number;
}

export interface Storyboard {
  id: string;
  projectId: string;
  planAssetId: string | null;
  status: StoryboardStatus;
  createdByActionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardScene {
  id: string;
  projectId: string;
  storyboardId: string;
  sceneIndex: number;
  title: string | null;
  summary: string | null;
  setting: string | null;
  mood: string | null;
  durationSec: number | null;
  sceneAssetId: string | null;
  status: StoryboardItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardBeat {
  id: string;
  projectId: string;
  sceneId: string;
  beatIndex: number;
  intent: string;
  visualDescription: string | null;
  dialogueSummary: string | null;
  narration: string | null;
  durationSec: number | null;
  status: StoryboardItemStatus;
  beatAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardPanel {
  id: string;
  projectId: string;
  beatId: string;
  panelIndex: number;
  imageAssetId: string | null;
  promptAssetId: string | null;
  status: StoryboardItemStatus;
  isSelected: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoryboardInput {
  planAssetId?: string | null;
  status?: StoryboardStatus;
}

interface SceneInput {
  sceneIndex?: number;
  title?: string | null;
  summary?: string | null;
  setting?: string | null;
  mood?: string | null;
  durationSec?: number | null;
  sceneAssetId?: string | null;
  status?: StoryboardItemStatus;
}

interface BeatInput {
  beatIndex?: number;
  intent?: string;
  visualDescription?: string | null;
  dialogueSummary?: string | null;
  narration?: string | null;
  durationSec?: number | null;
  status?: StoryboardItemStatus;
  beatAssetId?: string | null;
}

interface PanelInput {
  panelIndex?: number;
  imageAssetId?: string | null;
  promptAssetId?: string | null;
  status?: StoryboardItemStatus;
  isSelected?: boolean;
  approvedAt?: string | null;
}

function iso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

const throwOnError = (error: Parameters<typeof throwDatabaseError>[1], context: string) =>
  throwDatabaseError(`storyboards.${context}`, error);

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("validation_failed", "Request body must be an object.");
  }
  return body as Record<string, unknown>;
}

function optionalString(
  body: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError("validation_failed", `${key} must be a string or null.`);
  }
  return value;
}

function optionalNonnegativeNumber(
  body: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiError("validation_failed", `${key} must be a non-negative number or null.`);
  }
  return value;
}

function optionalNonnegativeInteger(
  body: Record<string, unknown>,
  key: string
): number | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ApiError("validation_failed", `${key} must be a non-negative integer.`);
  }
  return value as number;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string
): boolean | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new ApiError("validation_failed", `${key} must be a boolean.`);
  }
  return value;
}

function optionalStatus<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(
      "validation_failed",
      `${key} must be one of: ${allowed.join(", ")}.`
    );
  }
  return value as T;
}

export function parseStoryboardInput(body: unknown): StoryboardInput {
  const obj = bodyObject(body);
  return {
    planAssetId: optionalString(obj, "planAssetId"),
    status: optionalStatus(obj, "status", STORYBOARD_STATUSES),
  };
}

export function parseSceneInput(body: unknown): SceneInput {
  const obj = bodyObject(body);
  return {
    sceneIndex: optionalNonnegativeInteger(obj, "sceneIndex"),
    title: optionalString(obj, "title"),
    summary: optionalString(obj, "summary"),
    setting: optionalString(obj, "setting"),
    mood: optionalString(obj, "mood"),
    durationSec: optionalNonnegativeNumber(obj, "durationSec"),
    sceneAssetId: optionalString(obj, "sceneAssetId"),
    status: optionalStatus(obj, "status", ITEM_STATUSES),
  };
}

export function parseBeatInput(body: unknown): BeatInput {
  const obj = bodyObject(body);
  const intent = optionalString(obj, "intent");
  if (intent === null) {
    throw new ApiError("validation_failed", "intent must be a string.");
  }
  return {
    beatIndex: optionalNonnegativeInteger(obj, "beatIndex"),
    intent,
    visualDescription: optionalString(obj, "visualDescription"),
    dialogueSummary: optionalString(obj, "dialogueSummary"),
    narration: optionalString(obj, "narration"),
    durationSec: optionalNonnegativeNumber(obj, "durationSec"),
    status: optionalStatus(obj, "status", ITEM_STATUSES),
    beatAssetId: optionalString(obj, "beatAssetId"),
  };
}

export function parsePanelInput(body: unknown): PanelInput {
  const obj = bodyObject(body);
  return {
    panelIndex: optionalNonnegativeInteger(obj, "panelIndex"),
    imageAssetId: optionalString(obj, "imageAssetId"),
    promptAssetId: optionalString(obj, "promptAssetId"),
    status: optionalStatus(obj, "status", ITEM_STATUSES),
    isSelected: optionalBoolean(obj, "isSelected"),
    approvedAt: optionalString(obj, "approvedAt"),
  };
}

function mapStoryboard(row: StoryboardRow): Storyboard {
  return {
    id: row.id,
    projectId: row.project_id,
    planAssetId: row.plan_asset_id,
    status: row.status,
    createdByActionId: row.created_by_action_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapScene(row: StoryboardSceneRow): StoryboardScene {
  return {
    id: row.id,
    projectId: row.project_id,
    storyboardId: row.storyboard_id,
    sceneIndex: row.scene_index,
    title: row.title,
    summary: row.summary,
    setting: row.setting,
    mood: row.mood,
    durationSec: row.duration_sec,
    sceneAssetId: row.scene_asset_id,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapBeat(row: StoryboardBeatRow): StoryboardBeat {
  return {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    beatIndex: row.beat_index,
    intent: row.intent,
    visualDescription: row.visual_description,
    dialogueSummary: row.dialogue_summary,
    narration: row.narration,
    durationSec: row.duration_sec,
    status: row.status,
    beatAssetId: row.beat_asset_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPanel(row: StoryboardPanelRow): StoryboardPanel {
  return {
    id: row.id,
    projectId: row.project_id,
    beatId: row.beat_id,
    panelIndex: row.panel_index,
    imageAssetId: row.image_asset_id,
    promptAssetId: row.prompt_asset_id,
    status: row.status,
    isSelected: row.is_selected,
    approvedAt: row.approved_at ? iso(row.approved_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function assertProject(auth: AuthContext, projectId: string): Promise<void> {
  await getProject(auth.workspaceId, projectId);
}

async function defaultVisibilityForWorkspace(
  db: SupabaseClient,
  workspaceId: string
): Promise<"public" | "private"> {
  const { data, error } = await db.rpc("owner_tier", { ws_id: workspaceId });
  throwOnError(error, "defaultVisibilityForWorkspace");
  return data === "paid" ? "private" : "public";
}

async function getStoryboardRow(
  db: SupabaseClient,
  projectId: string,
  storyboardId: string
): Promise<StoryboardRow> {
  const { data, error } = await db
    .from("storyboards")
    .select("*")
    .eq("project_id", projectId)
    .eq("id", storyboardId)
    .maybeSingle();
  if (isMissingRow(error) || !data) throw notFound(`Storyboard not found: ${storyboardId}`);
  throwOnError(error, "getStoryboard");
  return data as StoryboardRow;
}

async function getSceneRow(
  db: SupabaseClient,
  projectId: string,
  storyboardId: string,
  sceneId: string
): Promise<StoryboardSceneRow> {
  const { data, error } = await db
    .from("storyboard_scenes")
    .select("*")
    .eq("project_id", projectId)
    .eq("storyboard_id", storyboardId)
    .eq("id", sceneId)
    .maybeSingle();
  if (isMissingRow(error) || !data) throw notFound(`Storyboard scene not found: ${sceneId}`);
  throwOnError(error, "getScene");
  return data as StoryboardSceneRow;
}

async function getBeatRow(
  db: SupabaseClient,
  projectId: string,
  sceneId: string,
  beatId: string
): Promise<StoryboardBeatRow> {
  const { data, error } = await db
    .from("storyboard_beats")
    .select("*")
    .eq("project_id", projectId)
    .eq("scene_id", sceneId)
    .eq("id", beatId)
    .maybeSingle();
  if (isMissingRow(error) || !data) throw notFound(`Storyboard beat not found: ${beatId}`);
  throwOnError(error, "getBeat");
  return data as StoryboardBeatRow;
}

async function getPanelRow(
  db: SupabaseClient,
  projectId: string,
  beatId: string,
  panelId: string
): Promise<StoryboardPanelRow> {
  const { data, error } = await db
    .from("storyboard_panels")
    .select("*")
    .eq("project_id", projectId)
    .eq("beat_id", beatId)
    .eq("id", panelId)
    .maybeSingle();
  if (isMissingRow(error) || !data) throw notFound(`Storyboard panel not found: ${panelId}`);
  throwOnError(error, "getPanel");
  return data as StoryboardPanelRow;
}

async function nextIndex(
  db: SupabaseClient,
  table: "storyboard_scenes" | "storyboard_beats" | "storyboard_panels",
  parentColumn: "storyboard_id" | "scene_id" | "beat_id",
  parentId: string,
  indexColumn: "scene_index" | "beat_index" | "panel_index"
): Promise<number> {
  const { data, error } = await db
    .from(table)
    .select(indexColumn)
    .eq(parentColumn, parentId)
    .order(indexColumn, { ascending: false })
    .limit(1);
  throwOnError(error, `nextIndex ${table}`);
  const row = (data as Array<Record<string, number>>)[0];
  return row ? row[indexColumn] + 1 : 0;
}

async function swapIndex(input: {
  db: SupabaseClient;
  table: "storyboard_scenes" | "storyboard_beats" | "storyboard_panels";
  idColumn?: "id";
  parentColumn: "storyboard_id" | "scene_id" | "beat_id";
  indexColumn: "scene_index" | "beat_index" | "panel_index";
  projectId: string;
  parentId: string;
  rowId: string;
  fromIndex: number;
  toIndex: number;
}): Promise<boolean> {
  if (input.fromIndex === input.toIndex) return true;

  const occupantResult = await input.db
    .from(input.table)
    .select("id")
    .eq("project_id", input.projectId)
    .eq(input.parentColumn, input.parentId)
    .eq(input.indexColumn, input.toIndex)
    .maybeSingle();
  if (isMissingRow(occupantResult.error) || !occupantResult.data) return false;
  throwOnError(occupantResult.error, `swapIndex ${input.table} lookup`);

  const occupantId = (occupantResult.data as { id: string }).id;
  if (occupantId === input.rowId) return true;

  const tempIndex = Math.max(input.fromIndex, input.toIndex) + 1_000_000;
  for (const [rowId, index] of [
    [occupantId, tempIndex],
    [input.rowId, input.toIndex],
    [occupantId, input.fromIndex],
  ] as Array<[string, number]>) {
    const { error } = await input.db
      .from(input.table)
      .update({ [input.indexColumn]: index })
      .eq("project_id", input.projectId)
      .eq("id", rowId);
    throwOnError(error, `swapIndex ${input.table}`);
  }
  return true;
}

async function setSelectedPanel(
  db: SupabaseClient,
  projectId: string,
  beatId: string,
  panelId: string,
  isSelected: boolean
): Promise<void> {
  if (isSelected) {
    const cleared = await db
      .from("storyboard_panels")
      .update({ is_selected: false })
      .eq("project_id", projectId)
      .eq("beat_id", beatId)
      .eq("is_selected", true);
    throwOnError(cleared.error, "clearSelectedPanels");
  }
  const selected = await db
    .from("storyboard_panels")
    .update({ is_selected: isSelected })
    .eq("project_id", projectId)
    .eq("beat_id", beatId)
    .eq("id", panelId);
  throwOnError(selected.error, "setSelectedPanel");
}

async function insertBeatSnapshotAsset(input: {
  db: SupabaseClient;
  auth: AuthContext;
  projectId: string;
  beat: StoryboardBeatRow;
  previousAssetId: string;
}): Promise<string> {
  const previousAsset = await input.db
    .from("assets")
    .select("id,lineage_id,version")
    .eq("project_id", input.projectId)
    .eq("id", input.previousAssetId)
    .eq("kind", "beat")
    .eq("media", "data")
    .maybeSingle();
  if (isMissingRow(previousAsset.error) || !previousAsset.data) {
    throw notFound(`Beat snapshot asset not found: ${input.previousAssetId}`);
  }
  throwOnError(previousAsset.error, "previousBeatAsset");

  const previous = previousAsset.data as BeatAssetRow;
  const now = new Date().toISOString();
  const visibility = await defaultVisibilityForWorkspace(input.db, input.auth.workspaceId);
  const { data, error } = await input.db
    .from("assets")
    .insert({
      schema_version: "asset.v2",
      workspace_id: input.auth.workspaceId,
      project_id: input.projectId,
      lineage_id: previous.lineage_id,
      version: previous.version + 1,
      kind: "beat",
      media: "data",
      status: "ready",
      role: "storyboard_beat",
      content: {
        schema_version: "beat.v1",
        storyboardBeatId: input.beat.id,
        sceneId: input.beat.scene_id,
        intent: input.beat.intent,
        visualDescription: input.beat.visual_description,
        dialogueSummary: input.beat.dialogue_summary,
        narration: input.beat.narration,
        durationSec: input.beat.duration_sec,
      },
      visibility,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();
  throwOnError(error, "insertBeatSnapshotAsset");
  return (data as { id: string }).id;
}

function semanticBeatChanged(before: StoryboardBeatRow, after: StoryboardBeatRow): boolean {
  return (
    before.intent !== after.intent ||
    before.visual_description !== after.visual_description ||
    before.dialogue_summary !== after.dialogue_summary ||
    before.narration !== after.narration ||
    before.duration_sec !== after.duration_sec
  );
}

export async function listStoryboards(input: {
  auth: AuthContext;
  projectId: string;
}): Promise<Storyboard[]> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("storyboards")
    .select("*")
    .eq("project_id", input.projectId)
    .order("created_at", { ascending: false });
  throwOnError(error, "listStoryboards");
  return (data as StoryboardRow[]).map(mapStoryboard);
}

export async function createStoryboard(input: {
  auth: AuthContext;
  projectId: string;
  data: StoryboardInput;
}): Promise<Storyboard> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("storyboards")
    .insert({
      project_id: input.projectId,
      plan_asset_id: input.data.planAssetId ?? null,
      status: input.data.status ?? "draft",
    })
    .select("*")
    .single();
  throwOnError(error, "createStoryboard");
  return mapStoryboard(data as StoryboardRow);
}

export async function getStoryboard(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
}): Promise<Storyboard> {
  await assertProject(input.auth, input.projectId);
  return mapStoryboard(
    await getStoryboardRow(getServiceSupabase(), input.projectId, input.storyboardId)
  );
}

export async function updateStoryboard(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  data: StoryboardInput;
}): Promise<Storyboard> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  const existing = await getStoryboardRow(db, input.projectId, input.storyboardId);
  const updates: Record<string, unknown> = {};
  if (input.data.planAssetId !== undefined) updates.plan_asset_id = input.data.planAssetId;
  if (input.data.status !== undefined) updates.status = input.data.status;
  if (Object.keys(updates).length === 0) return mapStoryboard(existing);
  const { data, error } = await db
    .from("storyboards")
    .update(updates)
    .eq("project_id", input.projectId)
    .eq("id", input.storyboardId)
    .select("*")
    .single();
  throwOnError(error, "updateStoryboard");
  return mapStoryboard(data as StoryboardRow);
}

export async function deleteStoryboard(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
}): Promise<void> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getStoryboardRow(db, input.projectId, input.storyboardId);
  const { error } = await db
    .from("storyboards")
    .delete()
    .eq("project_id", input.projectId)
    .eq("id", input.storyboardId);
  throwOnError(error, "deleteStoryboard");
}

export async function listScenes(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
}): Promise<StoryboardScene[]> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getStoryboardRow(db, input.projectId, input.storyboardId);
  const { data, error } = await db
    .from("storyboard_scenes")
    .select("*")
    .eq("project_id", input.projectId)
    .eq("storyboard_id", input.storyboardId)
    .order("scene_index", { ascending: true });
  throwOnError(error, "listScenes");
  return (data as StoryboardSceneRow[]).map(mapScene);
}

export async function createScene(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  data: SceneInput;
}): Promise<StoryboardScene> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getStoryboardRow(db, input.projectId, input.storyboardId);
  const sceneIndex =
    input.data.sceneIndex ??
    (await nextIndex(db, "storyboard_scenes", "storyboard_id", input.storyboardId, "scene_index"));
  const { data, error } = await db
    .from("storyboard_scenes")
    .insert({
      project_id: input.projectId,
      storyboard_id: input.storyboardId,
      scene_index: sceneIndex,
      title: input.data.title ?? null,
      summary: input.data.summary ?? null,
      setting: input.data.setting ?? null,
      mood: input.data.mood ?? null,
      duration_sec: input.data.durationSec ?? null,
      scene_asset_id: input.data.sceneAssetId ?? null,
      status: input.data.status ?? "draft",
    })
    .select("*")
    .single();
  throwOnError(error, "createScene");
  return mapScene(data as StoryboardSceneRow);
}

export async function updateScene(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  data: SceneInput;
}): Promise<StoryboardScene> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  const existing = await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  const updates: Record<string, unknown> = {};
  if (input.data.sceneIndex !== undefined) updates.scene_index = input.data.sceneIndex;
  if (input.data.title !== undefined) updates.title = input.data.title;
  if (input.data.summary !== undefined) updates.summary = input.data.summary;
  if (input.data.setting !== undefined) updates.setting = input.data.setting;
  if (input.data.mood !== undefined) updates.mood = input.data.mood;
  if (input.data.durationSec !== undefined) updates.duration_sec = input.data.durationSec;
  if (input.data.sceneAssetId !== undefined) updates.scene_asset_id = input.data.sceneAssetId;
  if (input.data.status !== undefined) updates.status = input.data.status;

  if (input.data.sceneIndex !== undefined) {
    const swapped = await swapIndex({
      db,
      table: "storyboard_scenes",
      parentColumn: "storyboard_id",
      indexColumn: "scene_index",
      projectId: input.projectId,
      parentId: input.storyboardId,
      rowId: input.sceneId,
      fromIndex: existing.scene_index,
      toIndex: input.data.sceneIndex,
    });
    if (swapped) delete updates.scene_index;
  }

  if (Object.keys(updates).length === 0) {
    return mapScene(await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId));
  }

  const { data, error } = await db
    .from("storyboard_scenes")
    .update(updates)
    .eq("project_id", input.projectId)
    .eq("storyboard_id", input.storyboardId)
    .eq("id", input.sceneId)
    .select("*")
    .single();
  throwOnError(error, "updateScene");
  return mapScene(data as StoryboardSceneRow);
}

export async function deleteScene(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
}): Promise<void> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  const { error } = await db
    .from("storyboard_scenes")
    .delete()
    .eq("project_id", input.projectId)
    .eq("storyboard_id", input.storyboardId)
    .eq("id", input.sceneId);
  throwOnError(error, "deleteScene");
}

export async function listBeats(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
}): Promise<StoryboardBeat[]> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  const { data, error } = await db
    .from("storyboard_beats")
    .select("*")
    .eq("project_id", input.projectId)
    .eq("scene_id", input.sceneId)
    .order("beat_index", { ascending: true });
  throwOnError(error, "listBeats");
  return (data as StoryboardBeatRow[]).map(mapBeat);
}

export async function createBeat(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  data: BeatInput;
}): Promise<StoryboardBeat> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  const beatIndex =
    input.data.beatIndex ??
    (await nextIndex(db, "storyboard_beats", "scene_id", input.sceneId, "beat_index"));
  const { data, error } = await db
    .from("storyboard_beats")
    .insert({
      project_id: input.projectId,
      scene_id: input.sceneId,
      beat_index: beatIndex,
      intent: input.data.intent ?? "",
      visual_description: input.data.visualDescription ?? null,
      dialogue_summary: input.data.dialogueSummary ?? null,
      narration: input.data.narration ?? null,
      duration_sec: input.data.durationSec ?? null,
      status: input.data.status ?? "draft",
      beat_asset_id: input.data.beatAssetId ?? null,
    })
    .select("*")
    .single();
  throwOnError(error, "createBeat");
  return mapBeat(data as StoryboardBeatRow);
}

export async function updateBeat(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  beatId: string;
  data: BeatInput;
}): Promise<StoryboardBeat> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  const existing = await getBeatRow(db, input.projectId, input.sceneId, input.beatId);
  const candidate: StoryboardBeatRow = {
    ...existing,
    intent: input.data.intent ?? existing.intent,
    visual_description:
      input.data.visualDescription !== undefined
        ? input.data.visualDescription
        : existing.visual_description,
    dialogue_summary:
      input.data.dialogueSummary !== undefined
        ? input.data.dialogueSummary
        : existing.dialogue_summary,
    narration: input.data.narration !== undefined ? input.data.narration : existing.narration,
    duration_sec:
      input.data.durationSec !== undefined ? input.data.durationSec : existing.duration_sec,
  };

  const updates: Record<string, unknown> = {};
  if (input.data.beatIndex !== undefined) updates.beat_index = input.data.beatIndex;
  if (input.data.intent !== undefined) updates.intent = input.data.intent;
  if (input.data.visualDescription !== undefined) {
    updates.visual_description = input.data.visualDescription;
  }
  if (input.data.dialogueSummary !== undefined) {
    updates.dialogue_summary = input.data.dialogueSummary;
  }
  if (input.data.narration !== undefined) updates.narration = input.data.narration;
  if (input.data.durationSec !== undefined) updates.duration_sec = input.data.durationSec;
  if (input.data.status !== undefined) updates.status = input.data.status;
  if (input.data.beatAssetId !== undefined && existing.beat_asset_id === null) {
    updates.beat_asset_id = input.data.beatAssetId;
  } else if (input.data.beatAssetId !== undefined) {
    throw new ApiError(
      "validation_failed",
      "beatAssetId can only be set before a beat snapshot lineage exists."
    );
  }

  if (semanticBeatChanged(existing, candidate) && existing.beat_asset_id) {
    updates.beat_asset_id = await insertBeatSnapshotAsset({
      db,
      auth: input.auth,
      projectId: input.projectId,
      beat: candidate,
      previousAssetId: existing.beat_asset_id,
    });
  }

  if (input.data.beatIndex !== undefined) {
    const swapped = await swapIndex({
      db,
      table: "storyboard_beats",
      parentColumn: "scene_id",
      indexColumn: "beat_index",
      projectId: input.projectId,
      parentId: input.sceneId,
      rowId: input.beatId,
      fromIndex: existing.beat_index,
      toIndex: input.data.beatIndex,
    });
    if (swapped) delete updates.beat_index;
  }

  if (Object.keys(updates).length === 0) {
    return mapBeat(await getBeatRow(db, input.projectId, input.sceneId, input.beatId));
  }

  const { data, error } = await db
    .from("storyboard_beats")
    .update(updates)
    .eq("project_id", input.projectId)
    .eq("scene_id", input.sceneId)
    .eq("id", input.beatId)
    .select("*")
    .single();
  throwOnError(error, "updateBeat");
  return mapBeat(data as StoryboardBeatRow);
}

export async function deleteBeat(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  beatId: string;
}): Promise<void> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  await getBeatRow(db, input.projectId, input.sceneId, input.beatId);
  const { error } = await db
    .from("storyboard_beats")
    .delete()
    .eq("project_id", input.projectId)
    .eq("scene_id", input.sceneId)
    .eq("id", input.beatId);
  throwOnError(error, "deleteBeat");
}

export async function listPanels(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  beatId: string;
}): Promise<StoryboardPanel[]> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  await getBeatRow(db, input.projectId, input.sceneId, input.beatId);
  const { data, error } = await db
    .from("storyboard_panels")
    .select("*")
    .eq("project_id", input.projectId)
    .eq("beat_id", input.beatId)
    .order("panel_index", { ascending: true });
  throwOnError(error, "listPanels");
  return (data as StoryboardPanelRow[]).map(mapPanel);
}

export async function createPanel(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  beatId: string;
  data: PanelInput;
}): Promise<StoryboardPanel> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  await getBeatRow(db, input.projectId, input.sceneId, input.beatId);
  const panelIndex =
    input.data.panelIndex ??
    (await nextIndex(db, "storyboard_panels", "beat_id", input.beatId, "panel_index"));
  if (input.data.isSelected) {
    const cleared = await db
      .from("storyboard_panels")
      .update({ is_selected: false })
      .eq("project_id", input.projectId)
      .eq("beat_id", input.beatId)
      .eq("is_selected", true);
    throwOnError(cleared.error, "createPanel clearSelected");
  }
  const { data, error } = await db
    .from("storyboard_panels")
    .insert({
      project_id: input.projectId,
      beat_id: input.beatId,
      panel_index: panelIndex,
      image_asset_id: input.data.imageAssetId ?? null,
      prompt_asset_id: input.data.promptAssetId ?? null,
      status: input.data.status ?? "queued",
      is_selected: input.data.isSelected ?? false,
      approved_at: input.data.approvedAt ?? null,
    })
    .select("*")
    .single();
  throwOnError(error, "createPanel");
  return mapPanel(data as StoryboardPanelRow);
}

export async function updatePanel(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  beatId: string;
  panelId: string;
  data: PanelInput;
}): Promise<StoryboardPanel> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  await getBeatRow(db, input.projectId, input.sceneId, input.beatId);
  const existing = await getPanelRow(db, input.projectId, input.beatId, input.panelId);
  const updates: Record<string, unknown> = {};
  if (input.data.panelIndex !== undefined) updates.panel_index = input.data.panelIndex;
  if (input.data.imageAssetId !== undefined) updates.image_asset_id = input.data.imageAssetId;
  if (input.data.promptAssetId !== undefined) updates.prompt_asset_id = input.data.promptAssetId;
  if (input.data.status !== undefined) updates.status = input.data.status;
  if (input.data.approvedAt !== undefined) updates.approved_at = input.data.approvedAt;

  if (input.data.panelIndex !== undefined) {
    const swapped = await swapIndex({
      db,
      table: "storyboard_panels",
      parentColumn: "beat_id",
      indexColumn: "panel_index",
      projectId: input.projectId,
      parentId: input.beatId,
      rowId: input.panelId,
      fromIndex: existing.panel_index,
      toIndex: input.data.panelIndex,
    });
    if (swapped) delete updates.panel_index;
  }
  if (input.data.isSelected !== undefined) {
    await setSelectedPanel(
      db,
      input.projectId,
      input.beatId,
      input.panelId,
      input.data.isSelected
    );
  }

  if (Object.keys(updates).length === 0) {
    return mapPanel(await getPanelRow(db, input.projectId, input.beatId, input.panelId));
  }

  const { data, error } = await db
    .from("storyboard_panels")
    .update(updates)
    .eq("project_id", input.projectId)
    .eq("beat_id", input.beatId)
    .eq("id", input.panelId)
    .select("*")
    .single();
  throwOnError(error, "updatePanel");
  return mapPanel(data as StoryboardPanelRow);
}

export async function deletePanel(input: {
  auth: AuthContext;
  projectId: string;
  storyboardId: string;
  sceneId: string;
  beatId: string;
  panelId: string;
}): Promise<void> {
  await assertProject(input.auth, input.projectId);
  const db = getServiceSupabase();
  await getSceneRow(db, input.projectId, input.storyboardId, input.sceneId);
  await getBeatRow(db, input.projectId, input.sceneId, input.beatId);
  await getPanelRow(db, input.projectId, input.beatId, input.panelId);
  const { error } = await db
    .from("storyboard_panels")
    .delete()
    .eq("project_id", input.projectId)
    .eq("beat_id", input.beatId)
    .eq("id", input.panelId);
  throwOnError(error, "deletePanel");
}
