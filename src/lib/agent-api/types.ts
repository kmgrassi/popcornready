// Versioned agent API (/api/v1) job and artifact types.
//
// Scope: this file backs PR6 of docs/scopes/agent-video-generation-api.md
// (revision jobs, export jobs, artifacts). The full set of job types and steps
// from the scope doc is declared here for stable typing, but only `revision`
// and `export` are implemented in PR6. The rest depend on PR1–PR5 (project,
// asset, generated-asset, composition, generation, and audio-alignment
// surfaces) and are marked accordingly where referenced.

import { Patch, Timeline } from "../types";

export type JobType =
  | "asset_ingest" // PR1
  | "asset_generation" // PR2
  | "composition" // PR3
  | "timeline_generation" // PR4
  | "audio_alignment" // PR5
  | "revision" // PR6 (implemented)
  | "export"; // PR6 (skeleton)

// Terminal states match the scope doc acceptance criteria.
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

// Concrete progress step names from the scope doc, so agents can surface useful
// status. Synchronous workers in PR6 only touch a subset.
export const JOB_STEPS = [
  "validating_request",
  "creating_brief_version",
  "planning_assets",
  "preflight_review",
  "generating_assets",
  "waiting_for_assets",
  "planning_timeline",
  "selecting_clips",
  "critiquing_timeline",
  "aligning_audio",
  "rendering_export",
  "saving_artifact",
] as const;

export type JobStep = (typeof JOB_STEPS)[number];

export interface Job<TResult = unknown> {
  id: string;
  type: JobType;
  status: JobStatus;
  projectId: string;
  // Last step the worker reported. Cosmetic while workers run inline.
  step?: JobStep;
  result?: TResult;
  error?: ApiErrorBody;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionJobResult {
  // The revised cut. Returned inline because first-class, addressable Timeline
  // resources (with stable ids and sibling lineage) require PR4. TODO(PR4):
  // persist this as a sibling Timeline and return a timelineId instead.
  timeline: Timeline;
  appliedPatches: number;
  patches: Patch[];
  summary: string;
}

export type ArtifactStatus = "pending_render" | "ready" | "failed";

export interface Artifact {
  id: string;
  projectId: string;
  kind: "video/mp4";
  status: ArtifactStatus;
  // Populated once a real render exists. TODO(PR5): produce the MP4 by reusing
  // the Remotion render path in src/app/api/export and persist `url`.
  url: string | null;
  timelineId: string;
  durationSec: number;
  renderPlan: ExportRenderPlan;
  createdAt: string;
}

export const DURATION_POLICIES = [
  "timeline_only",
  "match_longest_media",
  "fail_on_mismatch",
] as const;

export type DurationPolicy = (typeof DURATION_POLICIES)[number];

export interface ExportRenderPlan {
  durationPolicy: DurationPolicy;
  durationSec: number;
  timelineDurationSec: number;
  audioDurationSec: number;
  audioAssetIds: string[];
  format: "mp4";
  quality: string;
}

export interface ExportJobResult {
  artifactId: string;
}

// Stable error envelope from the scope doc's Error Shape.
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

// Job Response Shape from the scope doc: { "job": { ... } }.
export interface JobEnvelope<TResult = unknown> {
  job: Job<TResult>;
}
