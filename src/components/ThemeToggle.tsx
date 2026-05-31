"use client";

import { useEffect, useState } from "react";

type Theme = "popcorn-ready" | "popcorn" | "popcorn-warm" | "popcorn-night";

const STORAGE_KEY = "popcorn-ready-theme";

const THEMES: { id: Theme; label: string; shortLabel: string }[] = [
  { id: "popcorn-ready", label: "Popcorn Ready", shortLabel: "PR" },
  { id: "popcorn", label: "Accent", shortLabel: "Ac" },
  { id: "popcorn-warm", label: "Warm", shortLabel: "W" },
  { id: "popcorn-night", label: "Night", shortLabel: "N" },
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

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("popcorn-ready");

  useEffect(() => {
    const initialTheme = parseTheme(window.localStorage.getItem(STORAGE_KEY));
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  function selectTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    applyTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
  }

  return (
    <div className="theme-switcher" aria-label="Theme options">
      {THEMES.map((option) => (
        <button
          className="theme-option"
          type="button"
          key={option.id}
          onClick={() => selectTheme(option.id)}
          aria-pressed={theme === option.id}
        >
          <span className="theme-option-full">{option.label}</span>
          <span className="theme-option-short">{option.shortLabel}</span>
        </button>
      ))}
    </div>
  );
}
