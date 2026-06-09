import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { canAccessAdminSurface } from "./auth/AdminRoute";
import { AuthNavButton } from "./auth/AuthNavButton";
import { LogoMark } from "./LogoMark";
import ThemeToggle from "./ThemeToggle";
import { Button, ButtonLink } from "./ui/Button";
import { v1Api, type MeResponse } from "../lib/api-client";
import styles from "./AppLayout.module.css";

const STORAGE_KEY = "popcorn-ready-theme";
const VALID_THEMES = new Set(["popcorn", "popcorn-warm", "popcorn-night"]);

// Primary workspace nav. Ordered around the creation flow: Home → Studio
// (create) → Projects/Assets/Outputs (the library). Runs are reachable from
// inside Projects, so they no longer take a top-level slot.
const PRIMARY_NAV = [
  { label: "Home", to: "/dashboard" },
  { label: "Studio", to: "/studio" },
  { label: "Projects", to: "/projects" },
  { label: "Assets", to: "/assets" },
  { label: "Outputs", to: "/outputs" },
];

const TOPNAV = [
  { label: "Studio", to: "/studio" },
  { label: "Storyboard", to: "/storyboard" },
  { label: "Evals", to: "/evals" },
];

function applyStoredTheme() {
  try {
    const theme = window.localStorage.getItem(STORAGE_KEY);
    if (VALID_THEMES.has(theme ?? "")) {
      document.documentElement.dataset.theme = theme ?? "";
    } else {
      delete document.documentElement.dataset.theme;
    }
  } catch {
    delete document.documentElement.dataset.theme;
  }
}

export function RootLayout() {
  return (
    <RootProviders>
      <Outlet />
    </RootProviders>
  );
}

export function AppLayout() {
  return (
    <div className="web-shell">
      <header className="web-shell-header">
        <Link className="web-shell-brand" to="/">
          <LogoMark className="web-shell-logo" />
          <span>Popcorn Ready</span>
        </Link>
        <nav className="web-shell-nav" aria-label="Primary">
          <Link to="/">Home</Link>
          <a href="/#how">How it works</a>
          <a href="/#pricing">Pricing</a>
          <Link to="/studio">Studio</Link>
          <Link to="/storyboard">Storyboard</Link>
          <AuthNavButton />
        </nav>
      </header>
      {/* Non-landmark wrapper: each route owns its own <main> (HomePage,
          AuthForm, …), so this must not be a second <main> landmark. */}
      <div className="web-shell-body">
        <Outlet />
      </div>
      <footer className="web-shell-footer">
        <span className="web-shell-footer-brand">Popcorn Ready</span>
        <ThemeToggle />
      </footer>
    </div>
  );
}

export function AuthenticatedAppLayout() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === "loading" || auth.status === "unauthenticated") {
      return;
    }

    let cancelled = false;

    v1Api
      .me()
      .then((payload) => {
        if (cancelled) return;
        setMe(payload);
        setMeError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMe(null);
        setMeError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [auth.status]);

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
  const showAdmin = canAccessAdminSurface(auth);
  // Admins get the workbench; everyone else lands on workspace Settings. Both
  // are the "Settings/Admin" footer slot in the simplified sidebar.
  const settingsNav = showAdmin
    ? { label: "Admin", to: "/admin" }
    : { label: "Settings", to: "/settings" };

  async function signOut() {
    if (!canSignOut) return;
    await auth.signOut();
    navigate("/", { replace: true });
  }

  if (auth.status === "loading") {
    return (
      <div className="web-shell">
        <main className="web-shell-main">
          <h1>Checking session</h1>
          <p className="muted">Preparing your workspace.</p>
        </main>
      </div>
    );
  }

  if (auth.status === "unauthenticated") {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} to="/dashboard">
          <LogoMark className={styles.logo} />
          <span>Popcorn Ready</span>
        </Link>

        <ButtonLink className={styles.newVideo} variant="primary" to="/studio">
          New video
        </ButtonLink>

        <nav className={styles.nav} aria-label="Dashboard">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard"}
              className={({ isActive }) =>
                isActive ? `${styles.navLink} ${styles.active}` : styles.navLink
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <nav className={styles.footerNav} aria-label="Settings">
            <NavLink
              to={settingsNav.to}
              className={({ isActive }) =>
                isActive ? `${styles.navLink} ${styles.active}` : styles.navLink
              }
            >
              {settingsNav.label}
            </NavLink>
          </nav>

          {/* Quieter workspace indicator — a single read-only pill, no longer a
              prominent labelled <select> competing with the nav. */}
          <div
            className={styles.workspace}
            title={`Active workspace: ${workspaceLabel}`}
          >
            <span className={styles.workspaceDot} aria-hidden="true" />
            <span className={styles.workspaceName}>{workspaceLabel}</span>
          </div>
        </div>
      </aside>

      <div className={styles.content}>
        <header className={styles.topbar}>
          <nav className={styles.topnav} aria-label="Utilities">
            {TOPNAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? `${styles.topLink} ${styles.topLinkActive}`
                    : styles.topLink
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className={styles.account}>
            {meError && auth.configured ? (
              <span className={`${styles.authMode} ${styles.authError}`} title={meError}>
                Account unavailable
              </span>
            ) : (
              <span className={styles.authMode}>{authModeLabel}</span>
            )}
            <details className={styles.accountMenu}>
              <summary>{accountLabel}</summary>
              <div className={styles.accountPanel}>
                <span className={styles.accountWorkspace}>{workspaceLabel}</span>
                <div className={styles.accountSetting}>
                  <span className={styles.accountSettingLabel}>Appearance</span>
                  <ThemeToggle />
                </div>
                {canSignOut ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void signOut()}
                  >
                    Sign out
                  </Button>
                ) : null}
              </div>
            </details>
          </div>
        </header>
        <main className={styles.routeFrame}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function RootProviders({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);

  return <AuthProvider>{children}</AuthProvider>;
}
