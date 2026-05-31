# Prompt Grading Test Cases

Companion to [`prompt-grading.md`](./prompt-grading.md). A hand-curated set of
candidate prompts with **expected** grader outcomes, so we can sanity-check
the rubrics by running each case through Claude manually before any of the
grader code is built.

Once Track A lands, this same set becomes the regression eval — every change
to a rubric or grader system prompt is re-run against it.

## How To Run

### Automated (recommended)

All 27 cases below are encoded in `scripts/eval-prompt-grader.ts`. To run:

```bash
# Load env (OPENAI_API_KEY is required)
set -a; source .env.local; set +a

npm run eval:grader

# Or with a different model / concurrency / case filter:
GRADER_MODEL=gpt-4o-mini GRADER_CONCURRENCY=10 npm run eval:grader
GRADER_CASE_FILTER=V-PASS-01,V-FAIL-BRIEF npm run eval:grader
```

The script prints a per-case verdict/attribution/hard-floor table and dumps
the full graded output to `scripts/eval-results.json` for inspection. Cost on
gpt-4o for the full set is ~$0.15.

Currently wired to OpenAI's Chat Completions API; the same rubric and case
set will work against Claude (Anthropic SDK) — swap the `grade()` call when
the production grader on Sonnet is built (Track A).

### Manual (one case at a time)

1. Pick a modality. Copy the grader system prompt template below and paste the
   modality's rubric table from [`prompt-grading.md`](./prompt-grading.md) into
   the `{{rubric}}` slot.
2. For each test case in that modality's section: build the user message from
   the `Context` and `Candidate prompt` fields, send it to a model, and ask
   for the JSON `PromptGrade` defined in the scope doc.
3. Compare the returned `dimensions` against the test case's
   **Expected outcome**. A case "passes the grader" if the grader's verdict
   matches what the test case says it should be — *not* if the grader says the
   prompt is good.
4. Record pass/fail per case in a scratchpad.

### Minimal Grader System Prompt Template

```text
You are the prompt grader for Popcorn Ready, an AI-native video editor.
Your job is to score a CANDIDATE PROMPT that will be sent to a {{modality}}
generation provider, before the provider call is made.

Score each rubric dimension as an integer 0–10:
  0–3 = unusable, major rewrite required
  4–6 = ships only with significant revision
  7   = passable, minor revision recommended
  8   = ship threshold
  9–10 = excellent

Rubric for {{modality}}:
{{rubric}}

PASS RULE: a prompt only passes when every dimension scores ≥ 8.
Safety/constraint dimensions also enforce an absolute floor of 8.

Return JSON matching this shape:
{
  "modality": "{{modality}}",
  "schemaVersion": 1,
  "dimensions": { <one key per rubric dimension>: <integer 0-10> },
  "overall": <integer 0-10, weighted average>,
  "passed": <boolean>,
  "threshold": 8,
  "strengths": [<1-3 short bullets>],
  "weaknesses": [<1-3 short bullets, only if !passed>],
  "rewriteGuidance": <string, "" if passed>,
  "rubricVersion": "{{modality}}.v1"
}
```

The user message holds the context (goal, beat, neighbor shots, character
profile if any) followed by the candidate prompt verbatim.

---

## Video Prompt Test Cases

Run with the Video Prompt Rubric. Default threshold = 8, all dimensions.

### Pass Cases

**V-PASS-01 — strong product demo hook**

- **Context.** Goal: *"30s ad for an electric scooter brand 'Drift' aimed at urban commuters."* Style: *"fast-paced social ad."* Aspect: 9:16. Beat: `hook` (3s) — *"open with a visual surprise that frames the daily commute pain."* No character profile bound. No neighbor beats yet (this is beat 1).
- **Candidate prompt.** *"9:16 vertical cinematic live-action clip, 3 seconds. POV on a packed city sidewalk at 8:12 am, handheld 35mm look, natural morning light skimming low across pavement. A commuter in a navy raincoat squeezes between scaffolding and a bus stop, frustrated micro-expression. Shallow depth of field on his face, soft bokeh of yellow cabs behind. No on-screen text. Subtle camera push-in toward the eyes on the last beat."*
- **Expected outcome.** **Pass.** All dimensions ≥ 8. Strongest on `production_quality`, `specificity`, `brief_alignment`. `character_consistency` is N/A (= 10).

**V-PASS-02 — character-bound payoff shot**

- **Context.** Goal: *"60s explainer for a coffee subscription service 'Hearth.'"* Beat: `payoff` (5s) — *"protagonist takes the first sip, satisfied moment that lands the value prop."* Character profile bound: `maya` — identity invariants: *"woman, late 20s, warm brown skin, shoulder-length curly black hair, small gold hoop earrings, oatmeal cable-knit sweater, in a sunlit kitchen."* Reference mode: `hero_frame`. Previous beat shows Maya pouring from the Hearth carafe in the same kitchen.
- **Candidate prompt.** *"16:9 cinematic clip, 5 seconds. Maya — woman in her late 20s, warm brown skin, shoulder-length curly black hair, gold hoop earrings, oatmeal cable-knit sweater — sits at the kitchen island in the same sunlit kitchen as the previous shot. She lifts a white ceramic mug, takes a slow first sip, eyes briefly close, a small satisfied half-smile. Soft window light from camera left, warm color palette, shallow depth of field on her face. Static medium close-up, no camera move, no on-screen text."*
- **Expected outcome.** **Pass.** All dimensions ≥ 8. Strong on `character_consistency` (identity invariants restated; wardrobe matches; location continuity with prior beat) and `storyboard_cohesion`.

**V-PASS-03 — neutral B-roll between two beats**

- **Context.** Goal: *"45s recruiting video for a remote engineering team."* Beat: `proof` (4s) — *"show real collaboration without staged feel."* No character. Previous beat: developer at home desk, cool blue palette. Next beat: same developer's screen with a code review.
- **Candidate prompt.** *"16:9 documentary-style clip, 4 seconds. Over-the-shoulder static shot of a developer's hands typing on a low-profile mechanical keyboard, a single monitor with soft cool-blue UI light reflecting off their face. Natural ambient room light from a single window at camera right, subtle warm fill from a desk lamp. 50mm look, shallow depth of field on the hands. No on-screen text. Hold the frame; no camera motion."*
- **Expected outcome.** **Pass.** All dimensions ≥ 8. Mid-pack on `production_quality` (it's restrained on purpose), strong on `storyboard_cohesion` (palette + subject continuity) and `specificity`.

### Fail-by-Dimension Cases

One per dimension. Each is engineered so exactly one dimension should drop
below 8 — useful for spotting graders that "smear" the failure across other
dimensions.

**V-FAIL-BRIEF — wrong subject for the goal**

- **Context.** Goal: *"30s ad for an electric scooter brand 'Drift'."* Beat: `hook` (3s) — *"daily commute pain."*
- **Candidate prompt.** *"9:16 cinematic clip, 3 seconds. A chef in a busy restaurant kitchen plates a steak under warm tungsten light, 35mm shallow depth of field, steam rising. Static medium shot, no camera move, no on-screen text."*
- **Expected outcome.** **Fail.** `brief_alignment` ≤ 4. Everything else can score 8+ (the prompt is technically well-crafted). The grader should name the subject mismatch in `rewriteGuidance`.

**V-FAIL-BEAT — right movie, wrong scene**

- **Context.** Goal: *"30s ad for Drift scooters."* Beat: `hook` (3s) — *"daily commute pain."* (Not the CTA.)
- **Candidate prompt.** *"9:16 cinematic clip, 3 seconds. Wide shot of a smiling commuter mounting a Drift scooter outside their apartment, sunrise warm light, a confident exhale before riding off frame. 35mm look, shallow depth of field, no on-screen text."*
- **Expected outcome.** **Fail.** `beat_fit` ≤ 5. This is a resolution/CTA shot, not a hook on commute pain. `brief_alignment` should still be 8+ (it's on-brand).

**V-FAIL-STORYBOARD — discontinuous from neighbors**

- **Context.** Goal: *"30s ad for Drift scooters."* Beat 3 of 4: `solution` (4s). Beats 1–2 were both shot in bright morning sun on a sidewalk; beat 4 returns to that sidewalk.
- **Candidate prompt.** *"9:16 cinematic clip, 4 seconds. Interior of a dim industrial warehouse at night, single overhead practical light, a Drift scooter parked alone in a halo. Slow dolly-in. 35mm, shallow depth of field, no on-screen text."*
- **Expected outcome.** **Fail.** `storyboard_cohesion` ≤ 4 (location, time of day, palette all break from the neighbors). The prompt is otherwise well-crafted, so other dimensions should stay 8+.

**V-FAIL-CHARACTER — wardrobe / identity drift**

- **Context.** Character profile `maya` from V-PASS-02 (oatmeal cable-knit sweater, gold hoop earrings, sunlit kitchen). Reference mode: `hero_frame`.
- **Candidate prompt.** *"16:9 cinematic clip, 5 seconds. Maya — a woman in her late 20s wearing a black leather biker jacket and silver nose ring — leans against a graffiti-covered alley wall at dusk, neon reflections on wet pavement. Medium close-up, 35mm shallow depth of field."*
- **Expected outcome.** **Fail.** `character_consistency` ≤ 3. Identity invariants (jewelry), wardrobe (sweater → leather jacket), and location (kitchen → alley) all break. `production_quality` and `specificity` can still score high.

**V-FAIL-PRODUCTION — vague production direction**

- **Context.** Goal: *"30s ad for Drift scooters."* Beat: `hook` (3s).
- **Candidate prompt.** *"A really cool, cinematic, beautiful clip of a person on a scooter in the city. Make it look amazing and high-end."*
- **Expected outcome.** **Fail.** Either `production_quality` ≤ 3 **or** `specificity` ≤ 3 (or both) is acceptable as the lowest dimension — this prompt is vague on both axes. Per the orthogonality note in the scope doc, a well-calibrated grader could legitimately rank either lower; what matters is that both are flagged in `weaknesses`. The grader should call out missing camera, lens, lighting, framing, motion (production) **and** missing subject/setting/action (specificity) in `rewriteGuidance`.

**V-FAIL-CONSTRAINT — aspect ratio + on-screen text violation**

- **Context.** Aspect ratio from `StoryContext`: **9:16 vertical only.** StoryContext also says: *"never request on-screen text — captions are added later."*
- **Candidate prompt.** *"16:9 widescreen cinematic clip, 4 seconds. Drift scooter rider crossing a bridge at golden hour, with the word 'DRIFT' overlaid in bold sans-serif on the lower third. 35mm shallow depth of field, slow dolly."*
- **Expected outcome.** **Fail.** `constraint_compliance` ≤ 3 (two violations: aspect mismatch + on-screen text). **Absolute floor of 8 trips** — overall fails regardless of other scores. Other dimensions can be 8+.

**V-FAIL-SPECIFICITY — pure adjectives, no concrete nouns**

- **Context.** Goal: *"30s ad for Drift scooters."* Beat: `solution` (4s).
- **Candidate prompt.** *"An uplifting, dynamic, inspiring scene that captures the joy of urban mobility and the freedom of modern transportation."*
- **Expected outcome.** **Fail.** Either `specificity` ≤ 2 **or** `production_quality` ≤ 3 (or both) is acceptable — pure adjective-soup trips both axes. The grader should name "no concrete subject, no setting" *and* "no camera/lens/lighting" in `rewriteGuidance`.

### Edge Cases

**V-EDGE-01 — strong on most dimensions, weak on one**

- **Context.** Goal: *"30s ad for Drift scooters."* Beat: `solution` (4s) — *"show a rider effortlessly weaving traffic."* Previous beat: same rider walking the scooter through a crosswalk.
- **Candidate prompt.** *"9:16 cinematic clip, 4 seconds. Low-angle tracking shot of a rider on a matte-black scooter weaving between a yellow cab and a delivery van, late afternoon raking light, 35mm shallow depth of field. Static motion blur on background, sharp subject. No on-screen text."*
- **Expected outcome.** **Pass, but `beat_fit` should be the lowest.** The prompt is great in isolation, but "weaving" reads more aggressive than "effortlessly." A well-calibrated grader either passes it cleanly with `beat_fit` ~ 8, or marginally fails with `beat_fit` = 7 and asks for a softer body-language note. **Either is acceptable** — this case tests whether the grader handles "shades of fit" without overreacting.

**V-EDGE-02 — N/A dimension handling**

- **Context.** Goal: *"15s teaser for a meditation app."* Beat: `hook` (3s). **No character profile bound to this beat.**
- **Candidate prompt.** *"9:16 cinematic clip, 3 seconds. Overhead static shot of still water at dawn, single concentric ripple expanding from center, soft purple-to-amber gradient sky reflected. Cold-to-warm color temperature, 50mm look, ambient sound design implied. No subject in frame, no on-screen text."*
- **Expected outcome.** **Pass.** Critically, `character_consistency` should score **10 (N/A)** — not 0, not 5. This case catches graders that penalize for "missing character description" when no character is bound.

---

## Image Prompt Test Cases

Same shared dimensions as video. Below are the unique ones.

### Pass Cases

**I-PASS-01 — product hero shot with composition intent**

- **Context.** Goal: *"hero still for the Drift scooter landing page."* No beat (single image). Aspect: 1:1.
- **Candidate prompt.** *"1:1 product hero image of the Drift scooter, three-quarter front angle, centered with negative space top-right, matte concrete floor with subtle scuff texture, single soft key light from camera left at 45°, gentle rim light separating the rear wheel from the background, neutral mid-gray seamless backdrop, 50mm look, sharp focus on the front hub, shallow depth of field falling off behind the rear wheel, no text."*
- **Expected outcome.** **Pass.** `composition_intent` strongly hit (framing, focal point, depth, negative space all called out).

### Fail-by-Dimension Cases

Reuse `V-FAIL-*` patterns for shared dimensions. Image-unique:

**I-FAIL-COMPOSITION — image with no compositional thinking**

- **Context.** Goal: *"hero still for the Drift scooter landing page."* Aspect: 1:1.
- **Candidate prompt.** *"1:1 photo of a Drift scooter in a studio. Studio lighting. High quality. No text."*
- **Expected outcome.** **Fail.** `composition_intent` ≤ 3 (no framing, no focal point, no depth, no negative space). `specificity` also low. The grader should ask for framing, focal point, depth, and negative space by name in `rewriteGuidance`.

---

## Audio Prompt Test Cases

Run with the Audio Prompt Rubric.

### Pass Cases

**A-PASS-01 — instrumental soundtrack matched to the brief**

- **Context.** Goal: *"30s ad for Drift scooters."* Style: *"fast-paced social ad."* Beats: hook (3s, tension) → problem (8s, building) → solution (12s, release) → CTA (7s, confident button).
- **Candidate prompt.** *"30-second instrumental electronic track for a fast-paced urban mobility ad. No vocals. 112 BPM, 4/4. Open with a single muted plucked synth and low sub pulse for 3 seconds (tension), introduce a syncopated mid-range arp at 0:03 with light shaker (building), drop a clean four-on-the-floor kick + filtered analog bass at 0:11 with bright detuned-saw lead (release), pull back to filtered loop with a single rising sweep ending on a clean tonal sting at 0:23 for the CTA. Target loudness -14 LUFS integrated, true-peak -1 dBTP. No copyrighted melodies, no sampled hooks."*
- **Expected outcome.** **Pass.** Strong on `arc_fit` (matches the beat structure), `mood_specificity` (BPM, instrumentation, key feel), `mix_constraints` (no vocals, headroom for narration), `safety_compliance` (explicit no-copyright clause).

**A-PASS-02 — narration-friendly underscore**

- **Context.** Goal: *"60s explainer for a coffee subscription."* Has narration that ducks audio by -8 dB during voice. Aspect of length: 60s.
- **Candidate prompt.** *"60-second warm acoustic underscore. No vocals. 84 BPM. Felt piano + soft upright bass + brushed snare, occasional warm tape-saturated rhodes pad. Sparse arrangement — leave room mid-band for spoken narration that will duck the bed by 8 dB. Major key, gentle II–V–I feel, no melodic hook strong enough to compete with speech. Subtle rise into the final 10 seconds for the CTA, ending on a soft sustained chord. No copyrighted melodies or recognizable references."*
- **Expected outcome.** **Pass.**

### Fail-by-Dimension Cases

**A-FAIL-BRIEF — mood directly contradicts the brand**

- **Context.** Goal: *"15s intro for a calm meditation app called 'Stillwater'."* Style: *"slow, soft, breathy."*
- **Candidate prompt.** *"15-second high-energy EDM festival drop, 140 BPM, heavy sidechained bass, distorted leads, big snare buildup into a screaming synth drop at 0:08. No vocals."*
- **Expected outcome.** **Fail.** `brief_alignment` ≤ 2. Everything else can score high.

**A-FAIL-ARC — flat where the story needs an arc**

- **Context.** Goal: *"30s product ad."* Beats: hook → problem → solution → CTA (clear escalation).
- **Candidate prompt.** *"30-second mid-tempo acoustic guitar loop at 100 BPM. Same chord progression repeats throughout. No dynamic changes."*
- **Expected outcome.** **Fail.** `arc_fit` ≤ 3. `mood_specificity` is borderline pass — there's a tempo and instrument, just no shape.

**A-FAIL-MOOD — adjectives without musical specifics**

- **Context.** Goal: *"30s product ad."*
- **Candidate prompt.** *"An upbeat, positive, modern, energetic track that makes the viewer feel good. About 30 seconds. No vocals."*
- **Expected outcome.** **Fail.** `mood_specificity` ≤ 3 (no instrumentation, no tempo, no key/feel). The grader should ask for BPM, instrumentation, and a feel/key cue.

**A-FAIL-MIX — vocals where narration will collide**

- **Context.** Goal: *"60s explainer."* The video has voiceover narration the whole time.
- **Candidate prompt.** *"60-second uplifting pop track with a strong lead vocal melody and chorus harmonies. 110 BPM, full mix."*
- **Expected outcome.** **Fail.** `mix_constraints` ≤ 3 (vocals will fight the narration). Other dimensions can be fine in isolation.

**A-FAIL-SAFETY-1 — named artist reference**

- **Context.** Goal: *"30s product ad."*
- **Candidate prompt.** *"30-second instrumental track in the style of Hans Zimmer's Inception score, with that big BRAAAM brass and the slow ticking-clock motif."*
- **Expected outcome.** **Fail.** `safety_compliance` ≤ 3 (named artist + named work + recognizable motif). **Absolute floor of 8 trips.**

**A-FAIL-SAFETY-2 — brand jingle reference**

- **Context.** Goal: *"30s product ad."*
- **Candidate prompt.** *"30-second instrumental that ends on a sting evoking the McDonald's 'I'm lovin' it' five-note motif."*
- **Expected outcome.** **Fail.** `safety_compliance` ≤ 2 (brand audio + named jingle). **Absolute floor trips.**

### Edge Case

**A-EDGE-01 — borderline genre reference vs. artist reference**

- **Context.** Goal: *"30s ad."*
- **Candidate prompt.** *"30-second instrumental track in the style of late-90s trip-hop, downtempo with dusty drums, Rhodes piano, and vinyl crackle. 88 BPM. No vocals."*
- **Expected outcome.** **Pass.** Tests whether the grader correctly distinguishes "genre/era descriptor" (allowed per the blocklist exception) from "named artist" (forbidden). A miscalibrated grader will reject this thinking late-90s trip-hop implies Massive Attack/Portishead. The blocklist explicitly carves out genre/era descriptors as fine.

---

## Storyboard / Cross-Asset Test Cases (V1.1)

Run with the Cross-Asset rubric. Input is the full set of per-beat prompts
plus the plan.

### Pass Case

**S-PASS-01 — coherent 4-beat arc**

- **Context.** Goal: *"30s Drift scooter ad."* Beats: hook (commute pain) → problem (gridlock close-up) → solution (rider weaving) → CTA (rider arriving smiling at café). All four prompts are well-crafted versions of those beats, set in the same city in morning light, same rider seen in solution + CTA.
- **Expected outcome.** **Pass.** Arc continuity high, visual through-line high (consistent palette + recurring rider), pacing distribution sensible (wide → tight → tracking → static), no outliers, no redundancy.

### Fail Cases

**S-FAIL-CONTINUITY — beat 3 from a different story**

- **Context.** Same as S-PASS-01, except beat 3's prompt describes a completely different concept: a woman doing yoga on a beach at sunset.
- **Expected outcome.** **Fail.** `arc_continuity` ≤ 3, `visual_through_line` ≤ 3, `outlier_detection` correctly returns `outlierBeatIndices: [2]` (zero-indexed).

**S-FAIL-REDUNDANCY — two beats asking for the same shot**

- **Context.** 5-beat ad where beats 2 and 4 both describe "low-angle tracking shot of rider weaving through traffic in morning light" with only trivial wording differences.
- **Expected outcome.** **Fail.** `redundancy` ≤ 4. Other dimensions can stay high. The grader should name beats 2 and 4 specifically in `rewriteGuidance`.

**S-FAIL-PACING — all five beats are wide static shots**

- **Context.** 5-beat ad where every prompt is a wide static shot with no camera movement, no medium/close framing.
- **Expected outcome.** **Fail.** Either `pacing_distribution` ≤ 4 **or** `redundancy` ≤ 4 (or both) is acceptable as the lowest dimension — five identical wide-static shots are inherently both under-paced and redundant. The grader should ask for at least one tight close-up and one moving camera to vary rhythm, and call out the repetition.

---

## Test Coverage Summary

| Modality | Pass cases | Fail-by-dimension | Edge | Total |
| --- | --- | --- | --- | --- |
| Video | 3 | 7 | 2 | 12 |
| Image | 1 | 1 (unique) + reuse | 0 | 2+ |
| Audio | 2 | 6 | 1 | 9 |
| Storyboard (V1.1) | 1 | 3 | 0 | 4 |

Every dimension on every rubric has at least one targeted fail case. Pass
cases cover the realistic shapes of prompts that the authoring agents in this
codebase already produce (the wording is modeled on `beatPrompt()` and
`soundtrackPrompt()` from `src/app/api/oneshot/route.ts`).

## What "Calibrated" Means For This Set

When we run the set manually, mark each case according to:

- **Verdict match** — did the grader's `passed` field match the test case's
  expected pass/fail?
- **Failure attribution** — for fail cases, did the grader correctly identify
  the *intended* failing dimension(s) as the lowest scores? (Smearing failure
  across all dimensions is a calibration miss even when `passed` is correct.)
- **N/A handling** — did `character_consistency` score 10 (not 0) when no
  character was bound? (V-EDGE-02.)
- **Hard-floor handling** — did `constraint_compliance` / `safety_compliance`
  failures cause `passed: false` regardless of other dimension scores?
  (V-FAIL-CONSTRAINT, A-FAIL-SAFETY-1, A-FAIL-SAFETY-2.)

Target for V1 ship: **≥ 80% verdict match and ≥ 70% failure-attribution
match** on this set, with **100% on hard-floor handling**. Anything less and
the rubric anchors or system prompt need tightening before Track A goes out.

## Baseline Results

| Model | Date | Verdict | Attribution | Hard-floor | Self-report | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-4o` | 2026-05-31 (initial) | 27/27 (100%) | 17/17 (100%) | 3/3 (100%) | n/a | Pre-Track-A baseline. Identified `production_quality` / `specificity` correlation in vague-prompt fail cases. |
| `gpt-4o` | 2026-05-31 (tightened anchors) | 27/27 (100%) | 17/17 (100%) | 3/3 (100%) | **1/27 mismatch** | Sharpened anchors (craft vs. subject) held verdicts. Surfaced a model-compliance bug on I-FAIL-COMPOSITION: model returned `passed: true` with two dimensions at 7. Led to the **"recompute verdict server-side"** rule now in `prompt-grading.md`. Also fixed A-PASS-01: removed "headroom for narration" from a context that said "no narration." |

Re-run after any rubric-anchor or grader-system-prompt change and append a
row. The **self-report** column counts cases where the model's `passed` field
disagreed with the deterministic verdict computed from dimension scores — a
non-zero number is expected and is exactly why the production grader doesn't
trust that field.
