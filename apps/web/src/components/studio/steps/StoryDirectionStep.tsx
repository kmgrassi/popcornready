import type { StepProps, StoryFormat } from "../useStudioFlow";
import { StepShell } from "./StepShell";
import styles from "./StoryDirectionStep.module.css";

const FORMAT_OPTIONS: Array<{
  value: StoryFormat;
  title: string;
  description: string;
}> = [
  {
    value: "visual_reveal",
    title: "Visual reveal",
    description: "Build curiosity, then show the proof or transformation.",
  },
  {
    value: "mystery_to_model",
    title: "Mystery to model",
    description: "Open with a question and resolve it with a simple explanation.",
  },
  {
    value: "challenge",
    title: "Challenge",
    description: "Frame the story around a test, attempt, or constraint.",
  },
  {
    value: "misconception",
    title: "Misconception",
    description: "Start with the wrong assumption, then make the correction memorable.",
  },
  {
    value: "animated_explainer",
    title: "Animated explainer",
    description: "Use motion and staged visuals to explain a concept clearly.",
  },
  {
    value: "classroom_demo",
    title: "Classroom demo",
    description: "Teach the idea through an example, demonstration, or walkthrough.",
  },
  {
    value: "aesthetic_montage",
    title: "Aesthetic montage",
    description: "Lean on rhythm, mood, and polished visuals over narration.",
  },
];

export function StoryDirectionStep({ draft, update, next, back }: StepProps) {
  return (
    <StepShell
      heading="Story direction"
      description="Pick the story shape and opening hook. The rest of the creative direction stays in the brief."
      onNext={next}
      onBack={back}
    >
      <div className={styles.formatGrid}>
        {FORMAT_OPTIONS.map((option) => (
          <label className={styles.formatCard} key={option.value}>
            <input
              type="radio"
              name="story-format"
              checked={draft.format === option.value}
              onChange={() => update({ format: option.value })}
            />
            <span className={styles.formatTitle}>{option.title}</span>
            <p className={styles.formatText}>{option.description}</p>
          </label>
        ))}
      </div>

      <label className={styles.hookField}>
        <span className={styles.hookLabel}>Opening hook</span>
        <p className={styles.hookHelp}>
          One sentence the first scene should make the viewer want answered.
        </p>
        <textarea
          rows={4}
          value={draft.hook}
          placeholder="e.g. Why do most launch videos lose people in the first three seconds?"
          onChange={(event) => update({ hook: event.target.value })}
        />
      </label>
    </StepShell>
  );
}
