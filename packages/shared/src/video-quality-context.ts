export const VIDEO_QUALITY_CONTEXT = `High-quality video framework:
- Core principle: clear intent + controlled execution + cohesive emotional experience.
- Prioritize story clarity first, then audio, lighting, composition, editing rhythm, cohesion, color/graphics, transitions, and gear.
- Every shot should serve the viewer's understanding, feeling, or next action.
- Prefer designed visuals: clean framing, purposeful shot size, depth, subject/background separation, motivated movement, and clear visual hierarchy.
- Treat lighting as part of the story: directional, shaped, controlled, consistent color temperature, and separation from the background.
- Audio should feel clean, balanced, intentional, and never overpowered by music or abrupt cuts.
- Editing should create momentum through a strong opening hook, motivated cuts, pacing variation, clear information flow, emotional timing, and no unnecessary shots.
- Cohesion matters: consistent tone, visual identity, typography, graphics style, music choice, sound design, and color treatment.
- Use straight cuts by default. Add transitions only when they clarify time, place, topic, emotion, or rhythm.
- Diagnose weak outputs in this order: unclear story, distracting audio, uncontrolled lighting, weak framing, slow or chaotic pacing, visual inconsistency, decorative effects hiding weak structure, missing payoff.`;

export function videoQualityContextForPrompt(): string {
  return VIDEO_QUALITY_CONTEXT;
}
