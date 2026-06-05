import { useLayoutEffect, type ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { AuthNavButton } from "./auth/AuthNavButton";
import { LogoMark } from "./LogoMark";
import { StudioSidebar } from "./StudioSidebar";
import ThemeToggle from "./ThemeToggle";

const STORAGE_KEY = "popcorn-ready-theme";
const VALID_THEMES = new Set(["popcorn", "popcorn-warm", "popcorn-night"]);

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

export function AppLayout() {
  return (
    <RootProviders>
      <AppShell />
    </RootProviders>
  );
}

function AppShell() {
  const { pathname } = useLocation();
  const workspaceRoutes = [
    { path: "/studio", label: "Studio" },
    { path: "/projects", label: "Projects" },
    { path: "/uploads", label: "Uploads" },
    { path: "/templates", label: "Templates" },
    { path: "/brand", label: "Brand Kit" },
    { path: "/settings", label: "Settings" },
  ];
  const activeWorkspaceRoute = workspaceRoutes.find(
    (route) => pathname === route.path || pathname.startsWith(`${route.path}/`)
  );
  const isWorkspaceRoute = Boolean(activeWorkspaceRoute);

  if (isWorkspaceRoute) {
    return (
      <div className="workspace-shell">
        <StudioSidebar />
        <div className="workspace-content">
          <header className="workspace-topbar">
            <div>
              <p className="workspace-topbar-kicker">Workspace</p>
              <h1>{activeWorkspaceRoute?.label ?? "Studio"}</h1>
            </div>
            <div className="workspace-topbar-actions">
              <AuthNavButton />
              <ThemeToggle />
            </div>
          </header>
          <div className="workspace-main">
            <Outlet />
          </div>
        </div>
      </div>
    );
  }

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

export function RootProviders({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);

  return <AuthProvider>{children}</AuthProvider>;
}
