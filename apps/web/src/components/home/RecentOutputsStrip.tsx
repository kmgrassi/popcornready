import { Link } from "react-router-dom";
import type { DashboardRecentOutput } from "@popcorn/shared/v1/dashboard";
import styles from "./RecentOutputsStrip.module.css";

export function RecentOutputsStrip({
  outputs,
}: {
  outputs: readonly DashboardRecentOutput[];
}) {
  if (outputs.length === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="recent-outputs-title">
      <div className={styles.header}>
        <h2 id="recent-outputs-title">Recent outputs</h2>
        <Link to="/outputs">View all</Link>
      </div>

      <div className={styles.strip}>
        {outputs.slice(0, 4).map((output) => (
          <Link
            className={styles.output}
            key={output.artifactId}
            to={`/outputs?${new URLSearchParams({ projectId: output.projectId }).toString()}`}
          >
            {output.thumbnailUrl ? (
              <img
                className={styles.thumb}
                src={output.thumbnailUrl}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className={`${styles.thumb} ${styles.emptyThumb}`}>Output</span>
            )}
            <span className={styles.outputBody}>
              <span className={styles.title}>{output.projectName}</span>
              <span className={styles.meta}>
                {formatDate(output.createdAt)}
                {output.durationSec ? ` - ${formatDuration(output.durationSec)}` : ""}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(seconds: number) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
