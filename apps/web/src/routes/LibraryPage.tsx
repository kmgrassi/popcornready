import { Navigate, NavLink, useParams } from "react-router-dom";
import {
  AssetsPage,
  OutputsPage,
  ProjectsPage,
  RunsPage,
} from "./DashboardCollectionsPage";
import { EvalsPage } from "./EvalsPage";
import styles from "./LibraryPage.module.css";

const LIBRARY_TABS = [
  { id: "projects", label: "Projects" },
  { id: "runs", label: "Runs" },
  { id: "assets", label: "Assets" },
  { id: "outputs", label: "Outputs" },
  { id: "evals", label: "Evals" },
] as const;

type LibraryTab = (typeof LIBRARY_TABS)[number]["id"];

function isLibraryTab(value: string | undefined): value is LibraryTab {
  return LIBRARY_TABS.some((tab) => tab.id === value);
}

export function LibraryPage() {
  const { tab } = useParams();

  if (!tab) return <Navigate to="/library/projects" replace />;
  if (!isLibraryTab(tab)) return <Navigate to="/library/projects" replace />;

  return (
    <div className={styles.shell}>
      <nav className={styles.tabs} aria-label="Library collections">
        {LIBRARY_TABS.map((item) => (
          <NavLink
            className={({ isActive }) =>
              [styles.tab, isActive ? styles.active : ""].filter(Boolean).join(" ")
            }
            key={item.id}
            to={`/library/${item.id}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      {tab === "projects" ? <ProjectsPage /> : null}
      {tab === "runs" ? <RunsPage /> : null}
      {tab === "assets" ? <AssetsPage /> : null}
      {tab === "outputs" ? <OutputsPage /> : null}
      {tab === "evals" ? <EvalsPage /> : null}
    </div>
  );
}
