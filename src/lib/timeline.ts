import { Clip, Patch, Timeline, TimelineSegment } from "./types";

function newId(): string {
  return "seg_" + Math.random().toString(36).slice(2, 10);
}

// Clamp a segment's in/out points to the real clip duration and guarantee a
// minimum visible length. The agent is instructed to stay in bounds, but we
// never trust it — invalid timings would break rendering.
function clampSegment(
  seg: TimelineSegment,
  clipsById: Record<string, Clip>
): TimelineSegment | null {
  const clip = clipsById[seg.clipId];
  if (!clip) return null;
  const dur = clip.durationSec || 0;
  let inSec = Math.max(0, Math.min(seg.sourceInSec, Math.max(0, dur - 0.1)));
  let outSec = Math.min(dur || seg.sourceOutSec, seg.sourceOutSec);
  if (outSec - inSec < 0.3) {
    outSec = Math.min(dur || inSec + 1, inSec + 1);
  }
  if (outSec <= inSec) return null;
  return { ...seg, sourceInSec: inSec, sourceOutSec: outSec };
}

export function sanitizeTimeline(
  timeline: Timeline,
  clips: Clip[]
): Timeline {
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
  const segments = timeline.segments
    .map((s) => clampSegment({ ...s, id: s.id || newId() }, byId))
    .filter((s): s is TimelineSegment => s !== null);
  return { ...timeline, segments };
}

// Apply a list of agent-produced patches to a timeline. Each patch is
// validated/clamped; invalid ones are skipped rather than throwing, so one
// bad suggestion can't sink an otherwise good revision.
export function applyPatches(
  timeline: Timeline,
  patches: Patch[],
  clips: Clip[]
): Timeline {
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
  let segments = [...timeline.segments];

  for (const patch of patches) {
    switch (patch.op) {
      case "set_trim": {
        segments = segments.map((s) =>
          s.id === patch.segmentId
            ? { ...s, sourceInSec: patch.sourceInSec, sourceOutSec: patch.sourceOutSec }
            : s
        );
        break;
      }
      case "replace_clip": {
        if (!byId[patch.newClipId]) break;
        segments = segments.map((s) =>
          s.id === patch.segmentId
            ? {
                ...s,
                clipId: patch.newClipId,
                sourceInSec: patch.sourceInSec,
                sourceOutSec: patch.sourceOutSec,
                reason: patch.reason,
              }
            : s
        );
        break;
      }
      case "remove_segment": {
        segments = segments.filter((s) => s.id !== patch.segmentId);
        break;
      }
      case "set_caption": {
        segments = segments.map((s) =>
          s.id === patch.segmentId ? { ...s, caption: patch.caption } : s
        );
        break;
      }
      case "reorder": {
        const pos = new Map(patch.segmentIdsInOrder.map((id, i) => [id, i]));
        segments = [...segments].sort(
          (a, b) =>
            (pos.has(a.id) ? pos.get(a.id)! : 1e9) -
            (pos.has(b.id) ? pos.get(b.id)! : 1e9)
        );
        break;
      }
      case "add_segment": {
        if (!byId[patch.clipId]) break;
        const seg: TimelineSegment = {
          id: newId(),
          clipId: patch.clipId,
          sourceInSec: patch.sourceInSec,
          sourceOutSec: patch.sourceOutSec,
          role: patch.role,
          reason: patch.reason,
        };
        if (patch.afterSegmentId === null) {
          segments = [seg, ...segments];
        } else {
          const idx = segments.findIndex((s) => s.id === patch.afterSegmentId);
          if (idx === -1) segments = [...segments, seg];
          else segments = [...segments.slice(0, idx + 1), seg, ...segments.slice(idx + 1)];
        }
        break;
      }
    }
  }

  return sanitizeTimeline({ ...timeline, segments }, clips);
}

// Compact representation of clips passed to the agents. Keeping it small and
// deterministic protects the prompt cache.
export function clipCatalog(clips: Clip[]): string {
  const visualClips = clips.filter((c) => (c.kind || "video") !== "audio");
  if (visualClips.length === 0) return "(no visual clips uploaded)";
  return visualClips
    .map(
      (c) =>
        `- id=${c.id} | kind=${c.kind || "video"} | source=${
          c.source || "upload"
        } | duration=${c.durationSec.toFixed(1)}s | file="${c.filename}" | description="${
          c.description || "n/a"
        }"`
    )
    .join("\n");
}

export function timelineForPrompt(timeline: Timeline, clips: Clip[]): string {
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
  return timeline.segments
    .map((s, i) => {
      const c = byId[s.clipId];
      return `${i + 1}. segmentId=${s.id} | clipId=${s.clipId} (${
        c ? c.filename : "MISSING"
      }) | in=${s.sourceInSec.toFixed(1)}s out=${s.sourceOutSec.toFixed(
        1
      )}s | role=${s.role}${s.caption ? ` | caption="${s.caption}"` : ""}`;
    })
    .join("\n");
}
