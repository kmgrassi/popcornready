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
import { AuthNavButton } from "./auth/AuthNavButton";
import { LogoMark } from "./LogoMark";
import ThemeToggle from "./ThemeToggle";
import { v1Api, type MeResponse } from "../lib/api-client";

const STORAGE_KEY = "popcorn-ready-theme";
const VALID_THEMES = new Set(["popcorn", "popcorn-warm", "popcorn-night"]);
const DASHBOARD_NAV = [
  { label: "Home", to: "/dashboard" },
  { label: "Projects", to: "/projects" },
  { label: "Runs", to: "/runs" },
  { label: "Assets", to: "/assets" },
  { label: "Outputs", to: "/outputs" },
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
          <AuthNavButton />
        </nav>
        <ThemeToggle />
      </header>
      <Outlet />
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
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <Link className="dashboard-brand" to="/dashboard">
          <LogoMark className="dashboard-logo" />
          <span>Popcorn Ready</span>
        </Link>

        <label className="dashboard-workspace-label" htmlFor="workspace-select">
          Workspace
        </label>
        <select
          id="workspace-select"
          className="dashboard-workspace-select"
          value={workspaceLabel}
          disabled
          aria-label="Active workspace"
        >
          <option value={workspaceLabel}>{workspaceLabel}</option>
        </select>

        <nav className="dashboard-nav" aria-label="Dashboard">
          {DASHBOARD_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard"}
              className={({ isActive }) =>
                isActive ? "dashboard-nav-link active" : "dashboard-nav-link"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="dashboard-sidebar-footer">
          <Link className="dashboard-primary-action" to="/studio">
            New video
          </Link>
        </div>
      </aside>

      <div className="dashboard-content">
        <header className="dashboard-topbar">
          <nav className="dashboard-topnav" aria-label="Utilities">
            <Link to="/studio">Studio</Link>
            <Link to="/evals">Evals</Link>
            <Link to="/admin">Admin</Link>
          </nav>
          <div className="dashboard-account-cluster">
            {meError && auth.configured ? (
              <span className="dashboard-me-error" title={meError}>
                Account unavailable
              </span>
            ) : (
              <span className="dashboard-auth-mode">{authModeLabel}</span>
            )}
            <details className="dashboard-account-menu">
              <summary>{accountLabel}</summary>
              <div className="dashboard-account-panel">
                <span>{workspaceLabel}</span>
                {canSignOut ? (
                  <button
                    type="button"
                    className="secondary compact"
                    onClick={() => void signOut()}
                  >
                    Sign out
                  </button>
                ) : null}
              </div>
            </details>
            <ThemeToggle />
          </div>
        </header>
        <main className="dashboard-route-frame">
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
