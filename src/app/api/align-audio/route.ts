import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getProject, saveProject } from "@/lib/store";
import { revise, rewriteNarrationScript } from "@/lib/agent";
import { applyPatches } from "@/lib/timeline";
import { Clip, timelineDurationSec } from "@/lib/types";
import {
  ALIGNMENT_STRATEGIES,
  AlignmentStrategy,
  compareDurations,
  DEFAULT_MAX_DELTA_SEC,
} from "@/lib/audio-alignment";
import { measureAudioDurationSec } from "@/lib/generative/audio-duration";
import { providerFor } from "@/lib/generative/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

function audioClipDurationSec(clip: Clip): number {
  return clip.measuredDurationSec && clip.measuredDurationSec > 0
    ? clip.measuredDurationSec
    : clip.durationSec || 0;
}

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

// Corrective audio-alignment strategies an agent can run before retrying an
// export when narration and the visual timeline diverge.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const strategy = String(body.strategy || "") as AlignmentStrategy;
    if (!ALIGNMENT_STRATEGIES.includes(strategy)) {
      return NextResponse.json(
        { error: `strategy must be one of: ${ALIGNMENT_STRATEGIES.join(", ")}` },
        { status: 400 }
      );
    }
    const audioClipId = String(body.audioClipId || "");
    const maxDeltaSec =
      typeof body.maxDeltaSec === "number"
        ? body.maxDeltaSec
        : DEFAULT_MAX_DELTA_SEC;

    const project = await getProject();
    if (!project.timeline || project.timeline.segments.length === 0) {
      return NextResponse.json(
        { error: "Generate a cut before aligning audio." },
        { status: 400 }
      );
    }
    const audioClip = project.clips.find((c) => c.id === audioClipId);
    if (!audioClip || audioClip.kind !== "audio") {
      return NextResponse.json(
        { error: `Audio clip not found: ${audioClipId}` },
        { status: 400 }
      );
    }

    const timelineDur = timelineDurationSec(project.timeline);
    const audioDur = audioClipDurationSec(audioClip);
    const comparison = compareDurations({
      timelineDurationSec: timelineDur,
      audioDurationSec: audioDur,
      maxDeltaSec,
    });

    // Already aligned: nothing to do regardless of the requested strategy.
    if (comparison.withinThreshold) {
      return NextResponse.json({ aligned: true, strategy, comparison, project });
    }

    if (strategy === "fail") {
      return NextResponse.json(
        {
          error: `Audio (${comparison.audioDurationSec}s) and timeline (${comparison.timelineDurationSec}s) differ by ${comparison.deltaSec}s, beyond the ${comparison.maxDeltaSec}s threshold.`,
          code: "audio_timeline_mismatch",
          comparison,
        },
        { status: 422 }
      );
    }

    if (strategy === "render_longest") {
      return NextResponse.json({
        aligned: false,
        strategy,
        recommendation: {
          durationPolicy: "match_longest_media",
          exportDurationSec: Math.max(timelineDur, audioDur),
        },
        comparison,
        project,
      });
    }

    if (strategy === "extend_timeline") {
      const target = Math.max(timelineDur, audioDur);
      const { summary, patches } = await revise({
        message: `Extend the cut to about ${target.toFixed(
          1
        )} seconds total (currently ~${timelineDur.toFixed(
          1
        )}s) by lengthening the strongest visual beats — extend their out points or add brief complementary segments from existing clips. Keep the story, order, and clip choices intact; do not introduce unrelated footage.`,
        plan: project.plan,
        timeline: project.timeline,
        clips: project.clips,
        storyContext: project.storyContext,
      });
      project.timeline = applyPatches(project.timeline, patches, project.clips);
      await saveProject(project);
      const newComparison = compareDurations({
        timelineDurationSec: timelineDurationSec(project.timeline),
        audioDurationSec: audioDur,
        maxDeltaSec,
      });
      return NextResponse.json({
        aligned: newComparison.withinThreshold,
        strategy,
        summary,
        appliedPatches: patches.length,
        comparison: newComparison,
        project,
      });
    }

    // strategy === "rewrite_script"
    const currentScript = (audioClip.generatedBy?.prompt || "").trim();
    if (!currentScript) {
      return NextResponse.json(
        {
          error:
            "rewrite_script requires generated narration with a known script. Use extend_timeline or render_longest for uploaded audio.",
          comparison,
        },
        { status: 400 }
      );
    }

    const rewrite = await rewriteNarrationScript({
      currentScript,
      targetDurationSec: timelineDur,
      storyContext: project.storyContext,
    });

    const result = await providerFor("elevenlabs").generateAsset({
      provider: "elevenlabs",
      kind: "audio",
      prompt: rewrite.script,
      audioMode: "speech",
      voiceId: body.voiceId ? String(body.voiceId) : undefined,
    });

    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const filename = `${newId("aud")}.${result.extension}`;
    await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);
    const measured = measureAudioDurationSec(result.bytes, result.extension);

    // Update the audio clip in place so the UI selection stays valid.
    audioClip.url = `/generated/${filename}`;
    audioClip.filename = filename;
    audioClip.durationSec =
      measured && measured > 0 ? measured : audioClip.durationSec;
    if (measured && measured > 0) audioClip.measuredDurationSec = measured;
    audioClip.description = rewrite.summary || audioClip.description;
    audioClip.source = "generated";
    audioClip.generatedBy = {
      ...(audioClip.generatedBy || {}),
      provider: result.provider,
      model: result.model,
      prompt: rewrite.script,
    };
    await saveProject(project);

    const newComparison = compareDurations({
      timelineDurationSec: timelineDur,
      audioDurationSec: audioClipDurationSec(audioClip),
      maxDeltaSec,
    });
    return NextResponse.json({
      aligned: newComparison.withinThreshold,
      strategy,
      summary: rewrite.summary,
      script: rewrite.script,
      comparison: newComparison,
      project,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Audio alignment failed" },
      { status: 500 }
    );
  }
}
