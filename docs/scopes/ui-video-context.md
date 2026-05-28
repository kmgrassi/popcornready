# UI Video Context Scope

## Objective

Give users a structured way to tell the editor what the videos contain, what the
finished edit should accomplish, and which constraints the AI must obey.

The core principle is that context is product data, not just prompt text. It
should be editable, reusable, validated, and visible in the UI.

## Context Levels

### Project Brief

- Goal or script.
- Audience.
- Platform: TikTok, Reels, YouTube Shorts, YouTube, website, internal demo.
- Aspect ratio.
- Target duration.
- Style and pacing.
- Tone.
- Brand voice.
- Required CTA.
- Must-include moments.
- Avoid-list: claims, visuals, phrases, people, topics.
- Output language and caption preferences.

### Clip Context

- Description.
- Notable moments with approximate timestamps.
- Transcript or dialogue notes.
- People, products, screens, locations, or visual subjects.
- Recommended usage: hook, proof, demo, b-roll, CTA, background.
- Quality notes: shaky, quiet audio, blurry, duplicate, strong visual.
- Usage constraints: required, optional, do not use, only use for b-roll.

### Timeline Context

- Segment captions.
- Segment rationale.
- Beat mapping.
- Revision notes.
- Human approvals and rejected suggestions.

Revisions should produce a new validated timeline cut from the original copied
source assets. V1 should not edit rendered media in place; it should update the
structured timeline and restitch on preview/export.

Each successful revision should appear as a sibling timeline/cut, with its own
auto-generated export artifact when rendering succeeds.

## UI Features

- Project brief panel with structured fields and a freeform notes area.
- Clip context panel opened from the asset list.
- Timestamped moment editor for each clip.
- Required/optional/do-not-use controls for clips and moments.
- Context completeness indicators so users can see which clips need attention.
- Prompt preview or context summary showing what will be sent to the planner.
- Versioned brief snapshots for each generation run.

## Suggested Data Model

```ts
interface ProjectBrief {
  goal: string;
  audience?: string;
  platform?: string;
  targetLengthSec: number;
  aspectRatio: "16:9" | "9:16" | "1:1";
  style?: string;
  tone?: string;
  brandVoice?: string;
  callToAction?: string;
  mustInclude?: string[];
  avoid?: string[];
  captionPreferences?: string;
  notes?: string;
}

interface ClipContext {
  assetId: string;
  summary: string;
  recommendedRoles?: string[];
  constraints?: "required" | "optional" | "do_not_use";
  moments: ClipMoment[];
  transcript?: string;
  qualityNotes?: string;
}

interface ClipMoment {
  id: string;
  startSec: number;
  endSec?: number;
  label: string;
  notes?: string;
  recommendedRole?: string;
}
```

## Agent Prompting Implications

- The planner should receive the project brief.
- The selector should receive the clip catalog plus structured moments.
- The critic should score against the project brief and constraints.
- The reviser should be able to patch context as well as the timeline when the
  user says things like "never use the opening shot" or "this clip is the CTA."

## Acceptance Criteria

- A user can generate a useful cut without writing a long prompt by filling out
  structured brief fields.
- The generated timeline references user-provided clip moments when relevant.
- Required and do-not-use constraints are enforced by validation, not just
  requested in a prompt.
- Every generation stores the exact context snapshot used for traceability.
- Edit requests create traceable revision jobs and preserve the previous valid
  timeline.
- Successful edit requests create a sibling timeline and kick off export
  automatically.
