// Storyboard sketch style preset (Storyboard & Scenes scope, Part B).
//
// A prompt modifier that turns a beat/scene description into a rough storyboard
// PANEL rather than a finished frame: pencil/marker linework, grayscale or a
// limited palette, panel framing. The point is it *looks* like a storyboard, so
// the user reads it as a cheap sketch of the plan — not photoreal output — which
// also sets expectations before the expensive asset stage.

// The named style preset. Kept as a constant so the tile generator (and any
// future scene/character sketch-anchor path in PR3) layer the SAME aesthetic.
export const STORYBOARD_SKETCH_STYLE_PRESET = [
  "Rough black-and-white storyboard sketch panel.",
  "Loose pencil and marker linework, hand-drawn, gestural and unfinished.",
  "Grayscale with a limited palette; flat tonal shading, no photoreal detail.",
  "Clear panel framing with a defined border, like a film storyboard cell.",
  "Readable composition and staging over polish; this is pre-visualization, not a final frame.",
].join(" ");

// A short suffix appended to negative-prompt-capable providers (best-effort:
// most image providers ignore it, but it nudges away from photoreal renders).
export const STORYBOARD_SKETCH_NEGATIVE =
  "photoreal, photograph, 3d render, hyperdetailed, glossy, finished illustration, color grading";

// Low-res, fast settings for sketch tiles. Storyboard tiles are deliberately
// cheap and small so the whole board renders in seconds, BEFORE any photoreal
// keyframe/clip generation. Size maps to the smallest supported provider size.
export const STORYBOARD_SKETCH_TILE_SIZE = "1024x1024";
export const STORYBOARD_SKETCH_TILE_QUALITY = "low" as const;

// Compose the final image prompt for a storyboard tile: the sketch style preset
// framing FIRST (so it dominates the aesthetic), then the scene/beat content.
export function buildStoryboardSketchPrompt(input: {
  // The beat's intent — what this shot shows.
  beatIntent: string;
  beatName?: string;
  // Scene context the beat inherits (setting / mood) so panels in a scene share
  // a world. Optional: short clips may have a single implicit scene.
  sceneName?: string;
  setting?: string;
  mood?: string;
}): string {
  const sceneLines: string[] = [];
  if (input.sceneName) sceneLines.push(`Scene: ${input.sceneName}.`);
  if (input.setting) sceneLines.push(`Setting: ${input.setting}.`);
  if (input.mood) sceneLines.push(`Mood: ${input.mood}.`);

  const shotLine = input.beatName
    ? `Shot (${input.beatName}): ${input.beatIntent}`
    : `Shot: ${input.beatIntent}`;

  return [
    STORYBOARD_SKETCH_STYLE_PRESET,
    ...sceneLines,
    shotLine,
  ]
    .filter(Boolean)
    .join("\n");
}
