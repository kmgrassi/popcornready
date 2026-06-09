import { useEffect, useRef, useState } from "react";
import styles from "./ThemeToggle.module.css";

type Theme = "popcorn-ready" | "popcorn" | "popcorn-warm" | "popcorn-night";

const STORAGE_KEY = "popcorn-ready-theme";

const THEMES: { id: Theme; label: string }[] = [
  { id: "popcorn-ready", label: "Popcorn Ready" },
  { id: "popcorn", label: "Accent" },
  { id: "popcorn-warm", label: "Warm" },
  { id: "popcorn-night", label: "Night" },
];

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "popcorn-ready") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

function parseTheme(value: string | null): Theme {
  return THEMES.some((theme) => theme.id === value) ? (value as Theme) : "popcorn-ready";
}

/**
 * Theme switcher, rendered as a compact disclosure menu so it lives quietly in
 * a Settings area instead of four always-visible sidebar buttons. It still
 * flips `data-theme` on <html> + persists to localStorage, so every
 * CSS-variable theme restyles automatically.
 *
 * NOTE: whether these theme variants are user-facing or dev-only is an open
 * product question (see docs/scopes/studio-redesign-prs.md "Theme buttons").
 * They are placed in Settings here; gating them behind a dev/admin flag would
 * be the alternative.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("popcorn-ready");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const initialTheme = parseTheme(window.localStorage.getItem(STORAGE_KEY));
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function selectTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    applyTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
    setOpen(false);
  }

  const activeLabel = THEMES.find((option) => option.id === theme)?.label ?? "Theme";

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.triggerLabel}>Theme</span>
        <span className={styles.triggerValue}>{activeLabel}</span>
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label="Theme options">
          {THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={theme === option.id}
              className={
                theme === option.id
                  ? `${styles.option} ${styles.optionActive}`
                  : styles.option
              }
              onClick={() => selectTheme(option.id)}
            >
              <span className={styles.optionDot} aria-hidden="true" />
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
