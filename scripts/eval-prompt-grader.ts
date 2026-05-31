/**
 * Manual eval harness for the prompt-grader scope.
 *
 * Runs the 27 test cases from docs/scopes/prompt-grading-test-cases.md
 * through an LLM (OpenAI gpt-4o by default) and reports:
 *
 *   - verdict-match  (did `passed` match the test case's expectation?)
 *   - attribution    (for fail cases, did the intended dimension end up lowest?)
 *   - hard-floor     (did constraint/safety violations force passed=false?)
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npm run eval:grader
 *
 * Optional env:
 *   OPENAI_API_KEY              # required
 *   GRADER_MODEL=gpt-4o         # default; swap to test other OpenAI models
 *   GRADER_CONCURRENCY=5        # default
 *   GRADER_CASE_FILTER=V-PASS-01,V-FAIL-BRIEF   # comma list, optional
 *
 * The script currently calls OpenAI's Chat Completions API. To run the same
 * cases against Anthropic, swap the body of `grade()` for an Anthropic SDK
 * call returning the same `GraderOutput` JSON shape. The rubrics, test cases,
 * and scoring logic do not need to change.
 */

type Modality = "video" | "image" | "audio" | "storyboard";

interface TestCase {
  id: string;
  modality: Modality;
  context: string;
  candidate: string;
  expectedPassed: boolean;
  /**
   * The dimension(s) the grader should flag as lowest for a fail case. A
   * string is treated as a single acceptable answer; a string[] means any one
   * of them being the lowest counts as correct attribution. Use the array
   * form for known-correlated dimensions (e.g. production_quality and
   * specificity in vague-prompt fail cases).
   */
  expectedLowestDimension?: string | string[];
  hardFloor?: "constraint_compliance" | "safety_compliance";
  notes?: string;
}

// --------------------------------------------------------------------------
// Rubrics (verbatim from docs/scopes/prompt-grading.md)
// --------------------------------------------------------------------------

const VIDEO_RUBRIC = `Video Prompt Rubric (integer 0–10 per dimension):
- brief_alignment: How closely the prompt, read literally, would yield a clip that matches the user's goal and style.
- beat_fit: How well the prompt realizes THIS specific beat's name and intent from the EditPlan.
- storyboard_cohesion: Whether the prompt names visual elements (subject, setting, framing, lighting, motion) consistent with the shot before and after in the plan. Catches "clip 3 is a totally different scene from clips 1–2."
- character_consistency: If a CharacterProfile is bound to this beat, does the prompt reference the character's identity/wardrobe/style invariants correctly? If no character is bound, score 10 (N/A). Do NOT penalize for missing character info when none is bound.
- production_quality: Scores the CRAFT LAYER: camera (angle, distance), lens/feel (focal length, depth of field), lighting (source, direction, quality), composition (framing, motion language). Score independently of whether the subject is concrete — score whether the HOW is directed.
- constraint_compliance: Aspect ratio, duration window, no-text-on-screen rule, brand/safety constraints from StoryContext. ABSOLUTE FLOOR OF 8 — a single violation means passed=false regardless of other scores.
- specificity: Scores the SUBJECT LAYER: concrete nouns for who/what/where/when (subject, setting, action, time of day) vs. vague feeling-adjectives ("inspiring", "beautiful", "modern"). Score independently of whether craft is specified — score whether the WHAT is concrete.

Orthogonality: production_quality and specificity are independent axes. A prompt can be specific-but-uncinematic ("a man drinking coffee at his desk") or cinematic-but-generic ("low-angle tracking shot, golden hour, shallow depth of field, of a person"). Score them independently.`;

const IMAGE_RUBRIC = `Image Prompt Rubric (integer 0–10 per dimension):
- brief_alignment: How closely the prompt would yield an image matching the user's goal and style.
- beat_fit: How well it realizes the beat's intent (if a beat is bound; else score 10).
- character_consistency: Same as video. 10 if no character bound.
- production_quality: Scores the CRAFT LAYER: lighting (source, direction, quality), lens feel, color, surface detail. Score independently of subject concreteness.
- constraint_compliance: Aspect ratio, no-text-on-screen, brand/safety constraints. ABSOLUTE FLOOR OF 8.
- specificity: Scores the SUBJECT LAYER: concrete nouns vs. vague adjectives. Score independently of craft.
- composition_intent: Does the prompt specify framing, focal point, depth, and negative space?

Orthogonality: production_quality and specificity are independent axes — same rule as video.`;

const AUDIO_RUBRIC = `Audio Prompt Rubric (integer 0–10 per dimension):
- brief_alignment: Does the prompt match the goal and style of the video the audio supports?
- arc_fit: Does the prompt describe rise/fall/tension matching the beat structure?
- mood_specificity: Concrete instrumentation, tempo (BPM range), key/feel — vs. vague "upbeat positive."
- mix_constraints: Vocals/no-vocals correctly specified, ducking/headroom for narration where applicable, duration matches target.
- safety_compliance: ABSOLUTE FLOOR OF 8. Enforces the V1 audio safety blocklist:
    1. Named artists (no "like Hans Zimmer"). Genre/era descriptors ARE allowed ("90s shoegaze", "late-90s trip-hop").
    2. Song titles and lyrics.
    3. Recognizable hooks/riffs.
    4. Label / soundtrack callouts ("Marvel score", "Disney opening", "Netflix-intro sting").
    5. Voice impersonation of real people.
    6. Trademark sound marks ("THX deep note", "Intel bong").
    7. Explicit content (profanity, slurs, sexual content, glorified violence).
    8. Brand audio / jingles ("McDonald's I'm lovin' it tune").
   Violation means passed=false regardless of other scores.`;

const STORYBOARD_RUBRIC = `Cross-Asset / Storyboard Rubric (integer 0–10 per dimension):
- arc_continuity: Do the prompts, read in order, tell a coherent story (setup → escalation → payoff)?
- visual_through_line: Do shared subjects, palettes, and locations persist where they should?
- pacing_distribution: Are wide/medium/close, action/static, and durations distributed sensibly across beats?
- outlier_detection: Identify any single prompt that does not fit the rest. Return outlier beat indices (zero-based) in outlierBeatIndices.
- redundancy: Are two prompts effectively asking for the same shot?`;

function rubricFor(m: Modality): string {
  if (m === "video") return VIDEO_RUBRIC;
  if (m === "image") return IMAGE_RUBRIC;
  if (m === "audio") return AUDIO_RUBRIC;
  return STORYBOARD_RUBRIC;
}

function dimensionsFor(m: Modality): string[] {
  if (m === "video")
    return [
      "brief_alignment",
      "beat_fit",
      "storyboard_cohesion",
      "character_consistency",
      "production_quality",
      "constraint_compliance",
      "specificity",
    ];
  if (m === "image")
    return [
      "brief_alignment",
      "beat_fit",
      "character_consistency",
      "production_quality",
      "constraint_compliance",
      "specificity",
      "composition_intent",
    ];
  if (m === "audio")
    return [
      "brief_alignment",
      "arc_fit",
      "mood_specificity",
      "mix_constraints",
      "safety_compliance",
    ];
  return [
    "arc_continuity",
    "visual_through_line",
    "pacing_distribution",
    "outlier_detection",
    "redundancy",
  ];
}

// --------------------------------------------------------------------------
// Test cases
// --------------------------------------------------------------------------

const CASES: TestCase[] = [
  // ------- VIDEO PASS -------
  {
    id: "V-PASS-01",
    modality: "video",
    context:
      "Goal: 30s ad for an electric scooter brand 'Drift' aimed at urban commuters. Style: fast-paced social ad. Aspect: 9:16. Beat: hook (3s) — open with a visual surprise that frames the daily commute pain. No character profile bound. No neighbor beats (this is beat 1).",
    candidate:
      "9:16 vertical cinematic live-action clip, 3 seconds. POV on a packed city sidewalk at 8:12 am, handheld 35mm look, natural morning light skimming low across pavement. A commuter in a navy raincoat squeezes between scaffolding and a bus stop, frustrated micro-expression. Shallow depth of field on his face, soft bokeh of yellow cabs behind. No on-screen text. Subtle camera push-in toward the eyes on the last beat.",
    expectedPassed: true,
  },
  {
    id: "V-PASS-02",
    modality: "video",
    context:
      "Goal: 60s explainer for a coffee subscription service 'Hearth'. Aspect: 16:9. Beat: payoff (5s) — protagonist takes the first sip, satisfied moment that lands the value prop. Character profile bound: 'maya' — identity invariants: woman, late 20s, warm brown skin, shoulder-length curly black hair, small gold hoop earrings, oatmeal cable-knit sweater, in a sunlit kitchen. Reference mode: hero_frame. Previous beat shows Maya pouring from the Hearth carafe in the same kitchen.",
    candidate:
      "16:9 cinematic clip, 5 seconds. Maya — woman in her late 20s, warm brown skin, shoulder-length curly black hair, gold hoop earrings, oatmeal cable-knit sweater — sits at the kitchen island in the same sunlit kitchen as the previous shot. She lifts a white ceramic mug, takes a slow first sip, eyes briefly close, a small satisfied half-smile. Soft window light from camera left, warm color palette, shallow depth of field on her face. Static medium close-up, no camera move, no on-screen text.",
    expectedPassed: true,
  },
  {
    id: "V-PASS-03",
    modality: "video",
    context:
      "Goal: 45s recruiting video for a remote engineering team. Aspect: 16:9. Beat: proof (4s) — show real collaboration without staged feel. No character bound. Previous beat: developer at home desk, cool blue palette. Next beat: same developer's screen with a code review.",
    candidate:
      "16:9 documentary-style clip, 4 seconds. Over-the-shoulder static shot of a developer's hands typing on a low-profile mechanical keyboard, a single monitor with soft cool-blue UI light reflecting off their face. Natural ambient room light from a single window at camera right, subtle warm fill from a desk lamp. 50mm look, shallow depth of field on the hands. No on-screen text. Hold the frame; no camera motion.",
    expectedPassed: true,
  },

  // ------- VIDEO FAIL-BY-DIMENSION -------
  {
    id: "V-FAIL-BRIEF",
    modality: "video",
    context:
      "Goal: 30s ad for Drift electric scooters. Aspect: 9:16. Beat: hook (3s) — daily commute pain.",
    candidate:
      "9:16 cinematic clip, 3 seconds. A chef in a busy restaurant kitchen plates a steak under warm tungsten light, 35mm shallow depth of field, steam rising. Static medium shot, no camera move, no on-screen text.",
    expectedPassed: false,
    expectedLowestDimension: "brief_alignment",
  },
  {
    id: "V-FAIL-BEAT",
    modality: "video",
    context:
      "Goal: 30s ad for Drift scooters. Aspect: 9:16. Beat: hook (3s) — daily commute pain. (NOT the CTA.)",
    candidate:
      "9:16 cinematic clip, 3 seconds. Wide shot of a smiling commuter mounting a Drift scooter outside their apartment, sunrise warm light, a confident exhale before riding off frame. 35mm look, shallow depth of field, no on-screen text.",
    expectedPassed: false,
    expectedLowestDimension: "beat_fit",
  },
  {
    id: "V-FAIL-STORYBOARD",
    modality: "video",
    context:
      "Goal: 30s ad for Drift scooters. Aspect: 9:16. Beat 3 of 4: solution (4s). Beats 1–2 were both shot in bright morning sun on a sidewalk; beat 4 returns to that sidewalk.",
    candidate:
      "9:16 cinematic clip, 4 seconds. Interior of a dim industrial warehouse at night, single overhead practical light, a Drift scooter parked alone in a halo. Slow dolly-in. 35mm, shallow depth of field, no on-screen text.",
    expectedPassed: false,
    expectedLowestDimension: "storyboard_cohesion",
  },
  {
    id: "V-FAIL-CHARACTER",
    modality: "video",
    context:
      "Goal: Hearth coffee subscription. Beat: payoff (5s). Character profile 'maya' bound: oatmeal cable-knit sweater, gold hoop earrings, sunlit kitchen. Reference mode: hero_frame.",
    candidate:
      "16:9 cinematic clip, 5 seconds. Maya — a woman in her late 20s wearing a black leather biker jacket and silver nose ring — leans against a graffiti-covered alley wall at dusk, neon reflections on wet pavement. Medium close-up, 35mm shallow depth of field.",
    expectedPassed: false,
    expectedLowestDimension: "character_consistency",
  },
  {
    id: "V-FAIL-PRODUCTION",
    modality: "video",
    context: "Goal: 30s ad for Drift scooters. Aspect: 9:16. Beat: hook (3s).",
    candidate:
      "A really cool, cinematic, beautiful clip of a person on a scooter in the city. Make it look amazing and high-end.",
    expectedPassed: false,
    expectedLowestDimension: ["production_quality", "specificity"],
    notes:
      "Vague on both craft (no camera/lens/lighting) and subject (no concrete who/what/where). Either dimension as lowest counts.",
  },
  {
    id: "V-FAIL-CONSTRAINT",
    modality: "video",
    context:
      "Goal: 30s ad for Drift scooters. StoryContext: aspect ratio is 9:16 vertical ONLY. StoryContext also says: never request on-screen text — captions are added later.",
    candidate:
      "16:9 widescreen cinematic clip, 4 seconds. Drift scooter rider crossing a bridge at golden hour, with the word 'DRIFT' overlaid in bold sans-serif on the lower third. 35mm shallow depth of field, slow dolly.",
    expectedPassed: false,
    expectedLowestDimension: "constraint_compliance",
    hardFloor: "constraint_compliance",
  },
  {
    id: "V-FAIL-SPECIFICITY",
    modality: "video",
    context: "Goal: 30s ad for Drift scooters. Aspect: 9:16. Beat: solution (4s).",
    candidate:
      "An uplifting, dynamic, inspiring scene that captures the joy of urban mobility and the freedom of modern transportation.",
    expectedPassed: false,
    expectedLowestDimension: ["specificity", "production_quality"],
    notes: "Pure adjective-soup. Either dimension as lowest counts.",
  },

  // ------- VIDEO EDGE -------
  {
    id: "V-EDGE-01",
    modality: "video",
    context:
      "Goal: 30s ad for Drift scooters. Aspect: 9:16. Beat: solution (4s) — show a rider effortlessly weaving traffic. Previous beat: same rider walking the scooter through a crosswalk.",
    candidate:
      "9:16 cinematic clip, 4 seconds. Low-angle tracking shot of a rider on a matte-black scooter weaving between a yellow cab and a delivery van, late afternoon raking light, 35mm shallow depth of field. Static motion blur on background, sharp subject. No on-screen text.",
    expectedPassed: true,
    notes:
      "Borderline — beat_fit may be 7-8 because 'weaving' reads more aggressive than 'effortlessly'. Either pass or marginal fail acceptable.",
  },
  {
    id: "V-EDGE-02",
    modality: "video",
    context:
      "Goal: 15s teaser for a meditation app. Aspect: 9:16. Beat: hook (3s). NO character profile bound.",
    candidate:
      "9:16 cinematic clip, 3 seconds. Overhead static shot of still water at dawn, single concentric ripple expanding from center, soft purple-to-amber gradient sky reflected. Cold-to-warm color temperature, 50mm look, ambient sound design implied. No subject in frame, no on-screen text.",
    expectedPassed: true,
    notes:
      "character_consistency MUST score 10 (N/A). Catches graders that penalize for missing character info when none is bound.",
  },

  // ------- IMAGE -------
  {
    id: "I-PASS-01",
    modality: "image",
    context: "Goal: hero still for the Drift scooter landing page. No beat (single image). Aspect: 1:1. No character bound.",
    candidate:
      "1:1 product hero image of the Drift scooter, three-quarter front angle, centered with negative space top-right, matte concrete floor with subtle scuff texture, single soft key light from camera left at 45°, gentle rim light separating the rear wheel from the background, neutral mid-gray seamless backdrop, 50mm look, sharp focus on the front hub, shallow depth of field falling off behind the rear wheel, no text.",
    expectedPassed: true,
  },
  {
    id: "I-FAIL-COMPOSITION",
    modality: "image",
    context: "Goal: hero still for the Drift scooter landing page. Aspect: 1:1.",
    candidate:
      "1:1 photo of a Drift scooter in a studio. Studio lighting. High quality. No text.",
    expectedPassed: false,
    expectedLowestDimension: "composition_intent",
  },

  // ------- AUDIO PASS -------
  {
    id: "A-PASS-01",
    modality: "audio",
    context:
      "Goal: 30s ad for Drift scooters. Style: fast-paced social ad. Beats: hook (3s, tension) → problem (8s, building) → solution (12s, release) → CTA (7s, confident button). No narration.",
    candidate:
      "30-second instrumental electronic track for a fast-paced urban mobility ad. No vocals. 112 BPM, 4/4. Open with a single muted plucked synth and low sub pulse for 3 seconds (tension), introduce a syncopated mid-range arp at 0:03 with light shaker (building), drop a clean four-on-the-floor kick + filtered analog bass at 0:11 with bright detuned-saw lead (release), pull back to filtered loop with a single rising sweep ending on a clean tonal sting at 0:23 for the CTA. Target loudness -14 LUFS integrated, true-peak -1 dBTP. No copyrighted melodies, no sampled hooks.",
    expectedPassed: true,
  },
  {
    id: "A-PASS-02",
    modality: "audio",
    context:
      "Goal: 60s explainer for a coffee subscription. Has narration that ducks audio by -8 dB during voice. Length: 60s.",
    candidate:
      "60-second warm acoustic underscore. No vocals. 84 BPM. Felt piano + soft upright bass + brushed snare, occasional warm tape-saturated rhodes pad. Sparse arrangement — leave room mid-band for spoken narration that will duck the bed by 8 dB. Major key, gentle II–V–I feel, no melodic hook strong enough to compete with speech. Subtle rise into the final 10 seconds for the CTA, ending on a soft sustained chord. No copyrighted melodies or recognizable references.",
    expectedPassed: true,
  },

  // ------- AUDIO FAIL -------
  {
    id: "A-FAIL-BRIEF",
    modality: "audio",
    context:
      "Goal: 15s intro for a calm meditation app called 'Stillwater'. Style: slow, soft, breathy.",
    candidate:
      "15-second high-energy EDM festival drop, 140 BPM, heavy sidechained bass, distorted leads, big snare buildup into a screaming synth drop at 0:08. No vocals.",
    expectedPassed: false,
    expectedLowestDimension: "brief_alignment",
  },
  {
    id: "A-FAIL-ARC",
    modality: "audio",
    context:
      "Goal: 30s product ad. Beats: hook → problem → solution → CTA (clear escalation).",
    candidate:
      "30-second mid-tempo acoustic guitar loop at 100 BPM. Same chord progression repeats throughout. No dynamic changes.",
    expectedPassed: false,
    expectedLowestDimension: "arc_fit",
  },
  {
    id: "A-FAIL-MOOD",
    modality: "audio",
    context: "Goal: 30s product ad.",
    candidate:
      "An upbeat, positive, modern, energetic track that makes the viewer feel good. About 30 seconds. No vocals.",
    expectedPassed: false,
    expectedLowestDimension: "mood_specificity",
  },
  {
    id: "A-FAIL-MIX",
    modality: "audio",
    context:
      "Goal: 60s explainer. The video has voiceover narration the whole time.",
    candidate:
      "60-second uplifting pop track with a strong lead vocal melody and chorus harmonies. 110 BPM, full mix.",
    expectedPassed: false,
    expectedLowestDimension: "mix_constraints",
  },
  {
    id: "A-FAIL-SAFETY-1",
    modality: "audio",
    context: "Goal: 30s product ad.",
    candidate:
      "30-second instrumental track in the style of Hans Zimmer's Inception score, with that big BRAAAM brass and the slow ticking-clock motif.",
    expectedPassed: false,
    expectedLowestDimension: "safety_compliance",
    hardFloor: "safety_compliance",
  },
  {
    id: "A-FAIL-SAFETY-2",
    modality: "audio",
    context: "Goal: 30s product ad.",
    candidate:
      "30-second instrumental that ends on a sting evoking the McDonald's 'I'm lovin' it' five-note motif.",
    expectedPassed: false,
    expectedLowestDimension: "safety_compliance",
    hardFloor: "safety_compliance",
  },
  {
    id: "A-EDGE-01",
    modality: "audio",
    context: "Goal: 30s ad.",
    candidate:
      "30-second instrumental track in the style of late-90s trip-hop, downtempo with dusty drums, Rhodes piano, and vinyl crackle. 88 BPM. No vocals.",
    expectedPassed: true,
    notes:
      "Tests genre/era exception. 'late-90s trip-hop' is allowed; a paranoid grader will reject thinking Massive Attack/Portishead.",
  },

  // ------- STORYBOARD -------
  {
    id: "S-PASS-01",
    modality: "storyboard",
    context:
      "Goal: 30s Drift scooter ad. Beats: hook (commute pain) → problem (gridlock close-up) → solution (rider weaving) → CTA (rider arriving smiling at café). All set in the same city in morning light, same rider seen in solution + CTA.",
    candidate: `Beat 1 (hook, 3s): 9:16 POV on packed sidewalk at 8:12am, handheld 35mm, navy raincoat commuter squeezed between scaffolding, morning light, no text.
Beat 2 (problem, 8s): 9:16 tight close-up of brake lights and gridlocked car bumpers, same morning light, shallow DoF, no text.
Beat 3 (solution, 12s): 9:16 low-angle tracking of the same commuter (now riding a matte-black Drift scooter) weaving between cab and van, late morning raking light, 35mm.
Beat 4 (CTA, 7s): 9:16 static medium shot of the rider parking the scooter at a café patio, removing helmet with a small smile, soft warm morning light. No text.`,
    expectedPassed: true,
  },
  {
    id: "S-FAIL-CONTINUITY",
    modality: "storyboard",
    context:
      "Goal: 30s Drift scooter ad. Beats: hook → problem → solution → CTA, same morning city setting.",
    candidate: `Beat 1 (hook, 3s): POV on packed sidewalk at 8:12am, navy raincoat commuter, morning light.
Beat 2 (problem, 8s): tight close-up of brake lights and gridlocked bumpers, morning light.
Beat 3 (solution, 12s): wide drone shot of a woman doing sunset yoga on an empty tropical beach, palm trees, soft pink-orange sky.
Beat 4 (CTA, 7s): rider parking Drift scooter at a café patio, morning light.`,
    expectedPassed: false,
    expectedLowestDimension: "outlier_detection",
  },
  {
    id: "S-FAIL-REDUNDANCY",
    modality: "storyboard",
    context:
      "Goal: 30s Drift scooter ad with 5 beats: hook → problem → solution → proof → CTA.",
    candidate: `Beat 1 (hook, 3s): packed sidewalk POV, navy raincoat commuter.
Beat 2 (solution-a, 6s): low-angle tracking shot of rider weaving through traffic in morning light, matte-black scooter.
Beat 3 (proof, 5s): close-up of phone showing route time savings.
Beat 4 (solution-b, 6s): low-angle tracking shot of rider weaving between cars in morning light, matte-black scooter.
Beat 5 (CTA, 10s): rider arriving at café, smiling.`,
    expectedPassed: false,
    expectedLowestDimension: "redundancy",
  },
  {
    id: "S-FAIL-PACING",
    modality: "storyboard",
    context: "Goal: 30s Drift scooter ad with 5 beats, all in same morning city.",
    candidate: `Beat 1 (hook, 6s): wide static shot of an empty intersection at sunrise, no camera move.
Beat 2 (problem, 6s): wide static shot of gridlocked street from across the avenue, no camera move.
Beat 3 (solution, 6s): wide static shot of a sidewalk with people walking and a Drift scooter rolling past, no camera move.
Beat 4 (proof, 6s): wide static shot of a café exterior at street level, no camera move.
Beat 5 (CTA, 6s): wide static shot of the Drift logo on a wall, no camera move.`,
    expectedPassed: false,
    expectedLowestDimension: ["pacing_distribution", "redundancy"],
    notes: "Five identical wide-static shots are inherently both under-paced and redundant. Either dimension as lowest counts.",
  },
];

// --------------------------------------------------------------------------
// Grader call
// --------------------------------------------------------------------------

function systemPrompt(modality: Modality): string {
  return `You are the prompt grader for Popcorn Ready, an AI-native video editor.
Your job is to score a CANDIDATE PROMPT that will be sent to a ${modality} generation provider, BEFORE the provider call is made.

Score each rubric dimension as an integer 0–10:
  0–3 = unusable, major rewrite required
  4–6 = ships only with significant revision
  7   = passable, minor revision recommended
  8   = ship threshold
  9–10 = excellent

${rubricFor(modality)}

PASS RULE: a prompt only passes when EVERY dimension scores >= 8.
Safety/constraint dimensions also enforce an absolute floor of 8 — even one violation forces passed=false regardless of other scores.

Return ONLY a single JSON object with this exact shape (no commentary, no markdown):
{
  "modality": "${modality}",
  "schemaVersion": 1,
  "dimensions": { <one key per rubric dimension>: <integer 0-10> },
  "overall": <integer 0-10>,
  "passed": <boolean>,
  "threshold": 8,
  "strengths": [<1-3 short strings>],
  "weaknesses": [<1-3 short strings, only if passed is false; else []>],
  "rewriteGuidance": "<string, empty if passed>",
  "rubricVersion": "${modality}.v1"${modality === "storyboard" ? ',\n  "outlierBeatIndices": [<zero-based beat indices that do not fit, or []>]' : ""}
}`;
}

interface GraderOutput {
  modality: Modality;
  dimensions: Record<string, number>;
  overall: number;
  passed: boolean;
  threshold: number;
  strengths: string[];
  weaknesses: string[];
  rewriteGuidance: string;
  rubricVersion: string;
  outlierBeatIndices?: number[];
}

const MODEL = process.env.GRADER_MODEL || "gpt-4o";
const CONCURRENCY = Number(process.env.GRADER_CONCURRENCY || 5);

async function grade(tc: TestCase): Promise<GraderOutput> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt(tc.modality) },
      {
        role: "user",
        content: `CONTEXT:\n${tc.context}\n\nCANDIDATE PROMPT:\n${tc.candidate}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content in OpenAI response");
  return JSON.parse(content) as GraderOutput;
}

// --------------------------------------------------------------------------
// Scoring the grader
// --------------------------------------------------------------------------

interface CaseResult {
  tc: TestCase;
  graded?: GraderOutput;
  error?: string;
  verdictMatch: boolean;
  attributionMatch?: boolean;
  hardFloorHandled?: boolean;
  lowestDimension?: string;
  /** Verdict computed server-side from dimension scores (ignore graded.passed). */
  computedPassed?: boolean;
}

function lowestDim(g: GraderOutput): string {
  let lowestKey = "";
  let lowestVal = Infinity;
  for (const [k, v] of Object.entries(g.dimensions)) {
    if (v < lowestVal) {
      lowestVal = v;
      lowestKey = k;
    }
  }
  return lowestKey;
}

/**
 * Compute the verdict deterministically from the dimension scores. Do NOT
 * trust `graded.passed` — gpt-4o has been observed to set passed=true while
 * dimensions are below threshold (e.g. I-FAIL-COMPOSITION returning
 * composition_intent=7, specificity=7, passed=true). The production grader
 * should do the same: ignore the model's verdict and recompute from the
 * scores.
 */
function computePassed(graded: GraderOutput, threshold = 8): boolean {
  const dims = Object.values(graded.dimensions);
  if (dims.some((v) => typeof v !== "number" || v < threshold)) return false;
  return true;
}

function evalCase(tc: TestCase, graded: GraderOutput): CaseResult {
  // Recompute verdict server-side; do not trust the model's `passed` field.
  const computedPassed = computePassed(graded);
  const verdictMatch = computedPassed === tc.expectedPassed;
  const lowest = lowestDim(graded);

  let attributionMatch: boolean | undefined;
  if (!tc.expectedPassed && tc.expectedLowestDimension) {
    const accepted = Array.isArray(tc.expectedLowestDimension)
      ? tc.expectedLowestDimension
      : [tc.expectedLowestDimension];
    const minScore = Math.min(...Object.values(graded.dimensions));
    // Pass attribution if ANY accepted dimension is at or within 1 point of
    // the strict lowest score. Within-1 tolerance handles legitimately
    // correlated dimensions (production_quality + specificity, pacing +
    // redundancy).
    attributionMatch = accepted.some((dim) => {
      const score = graded.dimensions[dim];
      return typeof score === "number" && score - minScore <= 1;
    });
  }

  let hardFloorHandled: boolean | undefined;
  if (tc.hardFloor) {
    const score = graded.dimensions[tc.hardFloor];
    hardFloorHandled = score !== undefined && score < 8 && computedPassed === false;
  }

  return {
    tc,
    graded,
    verdictMatch,
    attributionMatch,
    hardFloorHandled,
    lowestDimension: lowest,
    computedPassed,
  };
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

async function runBatch<T>(items: T[], n: number, fn: (item: T) => Promise<CaseResult>): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (let i = 0; i < items.length; i += n) {
    const slice = items.slice(i, i + n);
    const batch = await Promise.all(
      slice.map(async (item) => {
        try {
          return await fn(item);
        } catch (e: any) {
          return {
            tc: item as unknown as TestCase,
            error: e?.message || String(e),
            verdictMatch: false,
          } as CaseResult;
        }
      })
    );
    results.push(...batch);
    process.stdout.write(`  ...${results.length}/${items.length}\n`);
  }
  return results;
}

function fmtRow(r: CaseResult): string {
  const tc = r.tc;
  if (r.error) return `${tc.id.padEnd(22)}  ERROR  ${r.error.slice(0, 80)}`;
  const g = r.graded!;
  const v = r.verdictMatch ? "✓" : "✗";
  const expected = tc.expectedPassed ? "pass" : "fail";
  const got = r.computedPassed ? "pass" : "fail";
  // Flag when the model self-reported verdict disagrees with the computed one.
  const disagree = g.passed !== r.computedPassed ? "!" : " ";
  let attr = "  ";
  if (r.attributionMatch !== undefined) attr = r.attributionMatch ? "A✓" : "A✗";
  let hf = "  ";
  if (r.hardFloorHandled !== undefined) hf = r.hardFloorHandled ? "H✓" : "H✗";
  return `${tc.id.padEnd(22)}  ${v} ${expected}→${got}${disagree} ${attr} ${hf}  lowest=${r.lowestDimension?.padEnd(22) || ""}  overall=${g.overall}`;
}

async function main() {
  const filter = process.env.GRADER_CASE_FILTER;
  const cases = filter
    ? CASES.filter((c) => filter.split(",").map((s) => s.trim()).includes(c.id))
    : CASES;
  console.log(`Running ${cases.length} cases through ${MODEL} (concurrency=${CONCURRENCY})\n`);

  const results = await runBatch(cases, CONCURRENCY, async (tc) => {
    const graded = await grade(tc);
    return evalCase(tc, graded);
  });

  console.log("\n--- RESULTS ---\n");
  console.log("ID                      verdict        attr hard  detail");
  console.log("─".repeat(110));
  for (const r of results) console.log(fmtRow(r));

  const total = results.length;
  const verdictPass = results.filter((r) => r.verdictMatch).length;
  const attrCases = results.filter((r) => r.attributionMatch !== undefined);
  const attrPass = attrCases.filter((r) => r.attributionMatch).length;
  const hfCases = results.filter((r) => r.hardFloorHandled !== undefined);
  const hfPass = hfCases.filter((r) => r.hardFloorHandled).length;
  const selfReportDisagrees = results.filter(
    (r) => r.graded && r.graded.passed !== r.computedPassed
  ).length;

  console.log("\n--- SUMMARY ---");
  console.log(`Model:                  ${MODEL}`);
  console.log(`Verdict match:          ${verdictPass}/${total}  (${Math.round((100 * verdictPass) / total)}%)`);
  console.log(`Failure attribution:    ${attrPass}/${attrCases.length}  (${attrCases.length ? Math.round((100 * attrPass) / attrCases.length) : 0}%)`);
  console.log(`Hard-floor handling:    ${hfPass}/${hfCases.length}  (${hfCases.length ? Math.round((100 * hfPass) / hfCases.length) : 0}%)`);
  console.log(`Self-report mismatches: ${selfReportDisagrees}/${total}  (model said 'passed' contradicted dimension floor)`);

  console.log("\n--- TARGETS (per docs/scopes/prompt-grading-test-cases.md) ---");
  console.log(`Verdict >= 80%:         ${verdictPass / total >= 0.8 ? "MET" : "MISS"}`);
  console.log(`Attribution >= 70%:     ${attrCases.length && attrPass / attrCases.length >= 0.7 ? "MET" : "MISS"}`);
  console.log(`Hard-floor == 100%:     ${hfCases.length && hfPass === hfCases.length ? "MET" : "MISS"}`);

  // Save full results for inspection.
  const out = {
    model: MODEL,
    timestamp: new Date().toISOString(),
    totals: {
      total,
      verdict: { pass: verdictPass, total },
      attribution: { pass: attrPass, total: attrCases.length },
      hardFloor: { pass: hfPass, total: hfCases.length },
    },
    cases: results.map((r) => ({
      id: r.tc.id,
      modality: r.tc.modality,
      expectedPassed: r.tc.expectedPassed,
      expectedLowestDimension: r.tc.expectedLowestDimension,
      hardFloor: r.tc.hardFloor,
      notes: r.tc.notes,
      graded: r.graded,
      error: r.error,
      verdictMatch: r.verdictMatch,
      attributionMatch: r.attributionMatch,
      hardFloorHandled: r.hardFloorHandled,
      lowestDimension: r.lowestDimension,
    })),
  };
  const { writeFileSync } = await import("fs");
  writeFileSync("scripts/eval-results.json", JSON.stringify(out, null, 2));
  console.log("\nFull results written to scripts/eval-results.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
