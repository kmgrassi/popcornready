import type { GenerationRun, GenerationStage } from "@popcorn/shared/v1/types";
import { StatusChecklist, type ChecklistItem } from "../ui/StatusChecklist";
import { buildChecklistItems, describeStatus } from "./statusChecklist";
import styles from "./GenerationChecklist.module.css";

export interface GenerationChecklistProps {
  run?: GenerationRun;
  stages: GenerationStage[];
}

/**
 * GenerationChecklist renders the calm Studio progress list from live run data.
 * The status mapping stays in `statusChecklist.ts`; this component only formats
 * backing stage details so future engine stages show up without Studio-specific
 * conditionals.
 */
export function GenerationChecklist({ run, stages }: GenerationChecklistProps) {
  const items = buildChecklistItems(stages, run?.status ?? "queued", run);
  const checklistItems: ChecklistItem[] = items.map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    detail:
      item.stages.length > 0 ? (
        <ul className={styles.stageList}>
          {item.stages.map((stage) => (
            <li key={stage.stageId} className={styles.stageDetail}>
              <span className={styles.stageLabel}>{stage.label}</span>
              <span className={styles.stageStatus}>{describeStatus(stage.status)}</span>
              {typeof stage.progressPercent === "number" ? (
                <span className={styles.stageLabel}>{Math.round(stage.progressPercent)}%</span>
              ) : null}
              {stage.message ? (
                <span className={styles.stageMessage}>{stage.message}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        item.detail
      ),
  }));

  return (
    <div className={styles.shell}>
      <div className={styles.summary}>
        <p className={styles.eyebrow}>Generation status</p>
        <p className={styles.message}>
          {run?.reviewGate
            ? "Paused for review"
            : run?.message ?? "Preparing the generation engine."}
        </p>
        {run?.runId ? <p className={styles.meta}>Run {run.runId}</p> : null}
      </div>
      <StatusChecklist items={checklistItems} />
    </div>
  );
}
