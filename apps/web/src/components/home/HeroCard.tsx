import { Link } from "react-router-dom";
import type { NextAction } from "../../lib/nextAction";
import { ButtonLink } from "../ui/Button";
import styles from "./HeroCard.module.css";

export function HeroCard({ action }: { action: NextAction }) {
  return (
    <section className={styles.hero} aria-labelledby="launchpad-title">
      <div className={styles.copy}>
        <span className={styles.eyebrow}>{eyebrowFor(action)}</span>
        <h1 id="launchpad-title">{action.title}</h1>
        <p>{action.body}</p>
      </div>

      <div className={styles.actions}>
        <ButtonLink variant="cta" size="lg" to={action.to}>
          {action.ctaLabel}
        </ButtonLink>
        <Link className={styles.libraryLink} to="/projects">
          Browse library
        </Link>
      </div>
    </section>
  );
}

function eyebrowFor(action: NextAction) {
  switch (action.type) {
    case "review_gate":
      return "Waiting on you";
    case "watch_run":
      return "Running now";
    case "review_cut":
      return "Ready to review";
    case "resume_draft":
      return "Draft in progress";
    case "start":
      return "First step";
    case "new":
      return "Workspace clear";
  }
}
