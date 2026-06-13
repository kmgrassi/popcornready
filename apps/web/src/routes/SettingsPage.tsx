import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../components/auth/AuthProvider";
import ThemeToggle from "../components/ThemeToggle";
import { Button } from "../components/ui/Button";
import { useMeQuery } from "../lib/queryClient";
import styles from "./SettingsPage.module.css";

const QUIET_LINKS = [
  {
    label: "Uploads",
    to: "/uploads",
    description: "Bring source media into the workspace.",
  },
  {
    label: "Templates",
    to: "/templates",
    description: "Manage reusable creative starting points.",
  },
  {
    label: "Brand kit",
    to: "/brand",
    description: "Keep brand defaults ready for generation.",
  },
  {
    label: "Evals",
    to: "/evals",
    description: "Review workspace quality checks.",
  },
];

const DEV_AUTOPILOT = import.meta.env.DEV;

export function SettingsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const authScope = auth.user?.id ?? (DEV_AUTOPILOT ? "dev-autopilot" : auth.status);
  const meQuery = useMeQuery(authScope, {
    enabled: auth.status !== "loading",
  });
  const me = meQuery.data ?? null;
  const meError =
    meQuery.error instanceof Error
      ? meQuery.error.message
      : meQuery.error
        ? String(meQuery.error)
        : null;

  const accountLabel = useMemo(() => {
    if (auth.user?.email) return auth.user.email;
    if (me?.actor && typeof me.actor === "object" && me.actor.email) {
      return me.actor.email;
    }
    if (me?.isLocal || auth.status === "disabled") return "Local developer";
    return "Account";
  }, [auth.status, auth.user?.email, me]);

  const workspaceLabel = me?.workspaceName ?? me?.workspaceId ?? "Workspace";
  const authModeLabel =
    me?.isLocal || auth.status === "disabled"
      ? "Local mode"
      : me?.authMode ?? "Hosted mode";
  const canSignOut = auth.configured && auth.status === "authenticated";

  async function signOut() {
    if (!canSignOut) return;
    await auth.signOut();
    navigate("/", { replace: true });
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Settings</p>
        <h1>Workspace controls</h1>
        <p>
          Account, workspace, and quiet secondary surfaces live here so creation
          stays focused.
        </p>
      </header>

      <section className={styles.section} aria-labelledby="appearance-heading">
        <div>
          <p className={styles.kicker}>Appearance</p>
          <h2 id="appearance-heading">Theme</h2>
        </div>
        <ThemeToggle />
      </section>

      <section className={styles.grid} aria-label="Workspace and account">
        <article className={styles.panel}>
          <p className={styles.kicker}>Workspace</p>
          <h2>{workspaceLabel}</h2>
          <p className={styles.muted}>
            Active workspace for Studio, Library, assets, and outputs.
          </p>
          {meError ? <p className={styles.error}>{meError}</p> : null}
        </article>

        <article className={styles.panel}>
          <p className={styles.kicker}>Account</p>
          <h2>{accountLabel}</h2>
          <p className={styles.muted}>{authModeLabel}</p>
          {canSignOut ? (
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          ) : null}
        </article>
      </section>

      <section className={styles.section} aria-labelledby="links-heading">
        <div>
          <p className={styles.kicker}>Secondary</p>
          <h2 id="links-heading">Available surfaces</h2>
        </div>
        <div className={styles.linkGrid}>
          {QUIET_LINKS.map((item) => (
            <Link key={item.to} className={styles.quietLink} to={item.to}>
              <span>{item.label}</span>
              <small>{item.description}</small>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
