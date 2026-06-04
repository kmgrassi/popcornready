import { useLayoutEffect, type ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { AuthNavButton } from "./auth/AuthNavButton";
import { LogoMark } from "./LogoMark";
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
      <div className="web-shell">
        <header className="web-shell-header">
          <Link className="web-shell-brand" to="/">
            <LogoMark className="web-shell-logo" />
            <span>Popcorn Ready</span>
          </Link>
          <nav className="web-shell-nav" aria-label="Primary">
            <Link to="/">Home</Link>
            <Link to="/studio">Studio</Link>
            <AuthNavButton />
          </nav>
          <ThemeToggle />
        </header>
        <Outlet />
      </div>
    </RootProviders>
  );
}

export function RootProviders({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);

  return <AuthProvider>{children}</AuthProvider>;
}
