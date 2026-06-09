import { PageHeader } from "../components/ui/PageHeader";
import { ButtonLink } from "../components/ui/Button";
import styles from "./DashboardPlaceholderPage.module.css";

const PAGE_COPY = {
  dashboard: {
    eyebrow: "Dashboard",
    title: "Overview",
    body: "Summary cards, active runs, and recent outputs will land here once the workspace dashboard read API is available.",
  },
  projects: {
    eyebrow: "Workspace",
    title: "Projects",
    body: "The cross-project project list will use the existing workspace-scoped projects endpoint.",
  },
  runs: {
    eyebrow: "Generation",
    title: "Runs",
    body: "Cross-project generation runs, status filters, and progress links will land here in the list-view PR.",
  },
  assets: {
    eyebrow: "Library",
    title: "Assets",
    body: "Generated and uploaded assets will appear here with kind, source, and project filters.",
  },
  outputs: {
    eyebrow: "Exports",
    title: "Outputs",
    body: "Finished video exports will appear here as a gallery once the output aggregation endpoint is available.",
  },
} as const;

type DashboardPlaceholderKind = keyof typeof PAGE_COPY;

export function DashboardPlaceholderPage({
  kind,
}: {
  kind: DashboardPlaceholderKind;
}) {
  const copy = PAGE_COPY[kind];

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.body}
        action={
          <ButtonLink variant="primary" to="/studio">
            New video
          </ButtonLink>
        }
      />
    </div>
  );
}
