import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/store";
import {
  critique,
  critiqueUploadedFootagePlan,
  planEdit,
  selectClips,
} from "@/lib/agent";
import { synthesizeEditGraph } from "@/lib/edit-graph";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { AspectRatio, StoryContext } from "@/lib/types";
import { mergeStoryContext } from "@/lib/story-context";
import {
  parseUploadedFootageEditRequest,
  resolveUploadedFootageClips,
} from "@/lib/uploaded-footage";

function parseShowCaptions(value: unknown): boolean {
  return value === true || value === "true";
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const goal = String(body.goal || "").trim();
    const targetLengthSec = Number(body.targetLengthSec) || 30;
    const style = String(body.style || "fast-paced social ad");
    const aspectRatio = (body.aspectRatio || "9:16") as AspectRatio;
    const showCaptions = parseShowCaptions(body.showCaptions);
    const storyContext = mergeStoryContext(body.storyContext as StoryContext);
    let uploadedEditRequest;
    try {
      uploadedEditRequest = parseUploadedFootageEditRequest(body);
    } catch (requestError: any) {
      return NextResponse.json(
        { error: requestError?.message || "Invalid uploaded-footage request." },
        { status: 400 }
      );
    }

    const project = await getProject();
    let selectedClips;
    try {
      selectedClips = resolveUploadedFootageClips(
        project.clips,
        uploadedEditRequest
      );
    } catch (selectionError: any) {
      return NextResponse.json(
        { error: selectionError?.message || "Select uploaded assets first." },
        { status: 400 }
      );
    }
    if (!goal) {
      return NextResponse.json(
        { error: "Provide a creative goal or script." },
        { status: 400 }
      );
    }

    // 1. Plan: goal -> beats
    const plan = await planEdit({
      goal,
      targetLengthSec,
      style,
      aspectRatio,
      storyContext,
    });

    // 2. Review source coverage before timeline assembly.
    const planReview = await critiqueUploadedFootagePlan({
      goal,
      plan,
      style,
      aspectRatio,
      storyContext,
      clips: selectedClips,
      allowGeneratedGapFill: uploadedEditRequest.allowGeneratedGapFill,
    });
    const reviewedPlan = planReview.revisedPlan;

    // 3. Select: beats + selected uploaded clips -> rough cut (v0)
    let timeline = sanitizeTimeline(
      await selectClips({
        plan: reviewedPlan,
        clips: selectedClips,
        goal,
        storyContext,
      }),
      selectedClips
    );
    timeline.showCaptions = showCaptions;

    // 4. Critique once and apply the patches -> improved cut (v1)
    const { report, patches } = await critique({
      plan: reviewedPlan,
      timeline,
      clips: selectedClips,
      storyContext,
    });
    timeline = applyPatches(timeline, patches, selectedClips);

    project.goal = goal;
    project.storyContext = storyContext;
    project.editGraph = synthesizeEditGraph({
      id: "generate_final",
      goal,
      plan: reviewedPlan,
      timeline,
      clips: selectedClips,
      storyContext,
    });
    project.plan = reviewedPlan;
    project.timeline = timeline;
    project.uploadedFootageEdit = {
      mode: uploadedEditRequest.mode,
      selectedAssetIds: selectedClips.map((clip) => clip.id),
      allowGeneratedGapFill: uploadedEditRequest.allowGeneratedGapFill,
      planReview,
      updatedAt: new Date().toISOString(),
    };
    project.critic = report;
    project.chat = [];
    await saveProject(project);

    return NextResponse.json({ project, appliedPatches: patches.length });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Generation failed" },
      { status: 500 }
    );
  }
}
