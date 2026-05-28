# Science Video Story Context

Source: `/Users/kevingrassi/Downloads/deep-research-report (12).md`

This project should use the report as reusable editorial context, not as a long
prompt blob. The practical takeaway is that high-performing science videos are
designed as curiosity engines: they earn attention with a concrete question and
visual surprise, then earn trust with a clear explanation.

## What Performs

- Visual surprise tied to a concrete scientific question.
- Hook and premise clarity in the first seconds.
- Narrative structure: quest, mystery, misconception, escalating test, or reveal.
- One big idea per asset.
- Low cognitive load: captions, concrete nouns, simple mental models.
- Visible expertise or credible context.
- Payoff after the hook: the viewer should leave smarter, not just entertained.

## Standard Story Arc

Use this default arc for public science, medical, and educational videos:

1. Hook: show the surprising visual or ask the sharp question.
2. Concrete question: name what the viewer is trying to understand.
3. Fast evidence: show the demo, reveal, contradiction, or proof.
4. Simple model: explain the mechanism with one conceptual step at a time.
5. Caveat: add careful wording where accuracy requires nuance.
6. Payoff: give the memorable takeaway.
7. Next step: invite the viewer into a follow-up, product action, or next video.

## Standardized Context Fields

The app stores this as `StoryContext`:

- `audience`
- `platform`
- `format`
- `hookQuestion`
- `strongestVisual`
- `emotionalPull`
- `oneBigIdea`
- `simpleModel`
- `caveat`
- `payoff`
- `callToAction`

The planner receives these fields for every generation so it can build a story
before selecting clips. The critic can later score whether the timeline delivers
the hook, the model, the caveat, and the payoff.
