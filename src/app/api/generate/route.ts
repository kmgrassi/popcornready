import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/store";
import { critique, planEdit, selectClips } from "@/lib/agent";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { AspectRatio, StoryContext } from "@/lib/types";
import { mergeStoryContext } from "@/lib/story-context";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const goal = String(body.goal || "").trim();
    const targetLengthSec = Number(body.targetLengthSec) || 30;
    const style = String(body.style || "fast-paced social ad");
    const aspectRatio = (body.aspectRatio || "9:16") as AspectRatio;
    const storyContext = mergeStoryContext(body.storyContext as StoryContext);

    const project = await getProject();
    if (project.clips.length === 0) {
      return NextResponse.json(
        { error: "Upload at least one clip before generating." },
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

    // 2. Select: beats + clips -> rough cut (v0)
    let timeline = sanitizeTimeline(
      await selectClips({ plan, clips: project.clips }),
      project.clips
    );

    // 3. Critique once and apply the patches -> improved cut (v1)
    const { report, patches } = await critique({
      plan,
      timeline,
      clips: project.clips,
      storyContext,
    });
    timeline = applyPatches(timeline, patches, project.clips);

    project.goal = goal;
    project.storyContext = storyContext;
    project.plan = plan;
    project.timeline = timeline;
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
