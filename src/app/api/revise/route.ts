import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/store";
import { revise } from "@/lib/agent";
import { applyPatches } from "@/lib/timeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = String(body.message || "").trim();
    if (!message) {
      return NextResponse.json({ error: "Empty message" }, { status: 400 });
    }

    const project = await getProject();
    if (!project.timeline) {
      return NextResponse.json(
        { error: "Generate a cut before revising." },
        { status: 400 }
      );
    }

    const { summary, patches } = await revise({
      message,
      plan: project.plan,
      timeline: project.timeline,
      clips: project.clips,
      storyContext: project.storyContext,
    });

    project.timeline = applyPatches(project.timeline, patches, project.clips);
    project.chat.push({ role: "user", content: message });
    project.chat.push({
      role: "assistant",
      content: summary + (patches.length ? "" : "\n\n(No changes were needed.)"),
    });
    await saveProject(project);

    return NextResponse.json({ project, appliedPatches: patches.length });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Revision failed" },
      { status: 500 }
    );
  }
}
