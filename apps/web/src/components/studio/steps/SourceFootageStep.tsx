import { useState } from "react";
import { FOOTAGE_ACCEPT, readSelectedFootage } from "../../../lib/upload";
import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";
import styles from "./SourceFootageStep.module.css";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return "duration unavailable";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

export function SourceFootageStep({ draft, update, next, back }: StepProps) {
  const [isReading, setIsReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const isUploadMode = draft.footageChoice === "upload";

  async function onFilesSelected(files: FileList | null) {
    setIsReading(true);
    setReadError(null);
    try {
      const selectedFootage = await readSelectedFootage(files);
      update({ footageChoice: "upload", selectedFootage });
    } catch (error) {
      setReadError(
        error instanceof Error ? error.message : "Could not read the selected footage.",
      );
    } finally {
      setIsReading(false);
    }
  }

  return (
    <StepShell
      heading="How should we use your footage?"
      description="Skip uploads for a fully generated cut, or bring source clips for the agent to edit."
      onNext={next}
      onBack={back}
      nextLabel={isUploadMode ? "Continue with footage" : "Continue prompt-only"}
      nextDisabled={isReading}
    >
      <div className={styles.choiceGrid}>
        <label className={styles.choiceCard}>
          <input
            type="radio"
            name="footage-choice"
            checked={draft.footageChoice === "prompt_only"}
            onChange={() =>
              update({
                footageChoice: "prompt_only",
                selectedFootage: [],
              })
            }
          />
          <span className={styles.choiceTitle}>Prompt only</span>
          <p className={styles.choiceText}>
            Generate the rough cut entirely from the brief. This is the fastest path.
          </p>
        </label>

        <label className={styles.choiceCard}>
          <input
            type="radio"
            name="footage-choice"
            checked={draft.footageChoice === "upload" && draft.footageMode === "hybrid"}
            onChange={() =>
              update({
                footageChoice: "upload",
                footageMode: "hybrid",
              })
            }
          />
          <span className={styles.choiceTitle}>Use my footage</span>
          <p className={styles.choiceText}>
            Start from uploaded clips and allow generated shots to fill missing moments.
          </p>
        </label>

        <label className={styles.choiceCard}>
          <input
            type="radio"
            name="footage-choice"
            checked={
              draft.footageChoice === "upload" && draft.footageMode === "asset_driven"
            }
            onChange={() =>
              update({
                footageChoice: "upload",
                footageMode: "asset_driven",
              })
            }
          />
          <span className={styles.choiceTitle}>Edit uploaded footage</span>
          <p className={styles.choiceText}>
            Treat your clips as the source material and assemble the best cut from them.
          </p>
        </label>
      </div>

      {isUploadMode ? (
        <section className={styles.uploadPanel} aria-label="Selected footage">
          <div className={styles.uploadHeader}>
            <div>
              <p className={styles.uploadTitle}>Source files</p>
              <p className={styles.uploadHelp}>Videos, images, or audio can guide the cut.</p>
            </div>
            <input
              className={styles.fileInput}
              type="file"
              accept={FOOTAGE_ACCEPT}
              multiple
              onChange={(event) => void onFilesSelected(event.currentTarget.files)}
            />
          </div>

          {isReading ? <p className={styles.status}>Reading file metadata...</p> : null}
          {readError ? <p className={styles.status}>{readError}</p> : null}

          {draft.selectedFootage.length > 0 ? (
            <ul className={styles.fileList}>
              {draft.selectedFootage.map((file) => (
                <li className={styles.fileItem} key={`${file.name}-${file.sizeBytes}`}>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>
                    {formatBytes(file.sizeBytes)} · {formatDuration(file.durationSec)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.status}>
              No files selected yet. You can continue and attach footage later.
            </p>
          )}
        </section>
      ) : null}
    </StepShell>
  );
}
