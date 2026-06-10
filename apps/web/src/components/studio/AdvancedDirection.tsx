import { Disclosure } from "../ui/Disclosure";
import { formatOptions, platformOptions, studioCopy } from "./copy";
import type { StepProps } from "./useStudioFlow";
import styles from "./AdvancedDirection.module.css";

type AdvancedDirectionProps = Pick<StepProps, "draft" | "update"> & {
  defaultOpen?: boolean;
};

export function AdvancedDirection({
  draft,
  update,
  defaultOpen = false,
}: AdvancedDirectionProps) {
  return (
    <Disclosure summary={studioCopy.brief.advancedSummary} defaultOpen={defaultOpen}>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>{studioCopy.advanced.audience}</span>
          <input
            className={styles.input}
            value={draft.audience}
            placeholder="e.g. busy founders, first-time buyers, technical evaluators"
            onChange={(event) => update({ audience: event.target.value })}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{studioCopy.advanced.platform}</span>
          <select
            className={styles.select}
            value={draft.platform}
            onChange={(event) =>
              update({ platform: event.target.value as typeof draft.platform })
            }
          >
            {platformOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{studioCopy.advanced.format}</span>
          <select
            className={styles.select}
            value={draft.format}
            onChange={(event) =>
              update({ format: event.target.value as typeof draft.format })
            }
          >
            {formatOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{studioCopy.advanced.style}</span>
          <input
            className={styles.input}
            value={draft.style}
            placeholder="e.g. polished launch film, lo-fi tutorial, energetic social ad"
            onChange={(event) => update({ style: event.target.value })}
          />
        </label>

        <label className={styles.wideField}>
          <span className={styles.label}>{studioCopy.advanced.hook}</span>
          <textarea
            className={styles.textarea}
            value={draft.hook}
            placeholder="What question or first moment should make someone keep watching?"
            onChange={(event) => update({ hook: event.target.value })}
          />
        </label>

        <label className={styles.wideField}>
          <span className={styles.label}>{studioCopy.advanced.bestVisual}</span>
          <textarea
            className={styles.textarea}
            value={draft.bestVisual}
            placeholder="The clearest demo, scene, proof point, before/after, or visual evidence."
            onChange={(event) => update({ bestVisual: event.target.value })}
          />
        </label>

        <label className={styles.wideField}>
          <span className={styles.label}>{studioCopy.advanced.bigIdea}</span>
          <textarea
            className={styles.textarea}
            value={draft.bigIdea}
            placeholder="The single idea the story should build toward."
            onChange={(event) => update({ bigIdea: event.target.value })}
          />
        </label>

        <label className={styles.wideField}>
          <span className={styles.label}>{studioCopy.advanced.payoff}</span>
          <textarea
            className={styles.textarea}
            value={draft.payoff}
            placeholder="What should feel clear, useful, or surprising when the video ends?"
            onChange={(event) => update({ payoff: event.target.value })}
          />
        </label>

        <label className={styles.wideField}>
          <span className={styles.label}>{studioCopy.advanced.accuracyNote}</span>
          <textarea
            className={styles.textarea}
            value={draft.accuracyNote}
            placeholder="Claims to avoid, caveats to include, or trust boundaries the agent should respect."
            onChange={(event) => update({ accuracyNote: event.target.value })}
          />
        </label>
      </div>
    </Disclosure>
  );
}
