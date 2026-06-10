import type { PaletteCommand } from "../../components/palette/Palette";

function go(to: string): PaletteCommand["run"] {
  return (navigate) => navigate(to);
}

export const settingsCommands: PaletteCommand[] = [
  {
    id: "settings.open",
    title: "Settings",
    subtitle: "Workspace and account preferences",
    keywords: ["account", "workspace", "theme", "sign out"],
    run: go("/settings"),
  },
  {
    id: "settings.theme",
    title: "Theme",
    subtitle: "Change app appearance from Settings",
    keywords: ["appearance", "dark", "warm", "night"],
    run: go("/settings"),
  },
  {
    id: "settings.account",
    title: "Account",
    subtitle: "Open account and sign-out controls",
    keywords: ["email", "user", "profile", "sign out"],
    run: go("/settings"),
  },
  {
    id: "settings.uploads",
    title: "Uploads",
    subtitle: "Upload source media",
    keywords: ["files", "assets", "footage"],
    run: go("/uploads"),
  },
  {
    id: "settings.templates",
    title: "Templates",
    subtitle: "Starter shapes for future videos",
    keywords: ["presets", "formats", "duration", "aspect ratio"],
    run: go("/templates"),
  },
  {
    id: "settings.brand",
    title: "Brand Kit",
    subtitle: "Workspace brand controls",
    keywords: ["brand", "style", "colors", "voice"],
    run: go("/brand"),
  },
];

export const adminSettingsCommands: PaletteCommand[] = [
  {
    id: "settings.admin",
    title: "Admin",
    subtitle: "Developer workbench",
    keywords: ["ops", "local", "workspace"],
    run: go("/admin"),
  },
  {
    id: "settings.admin-evals",
    title: "Admin evals",
    subtitle: "Evaluation admin surface",
    keywords: ["quality", "tests", "review"],
    run: go("/admin/evals"),
  },
  {
    id: "settings.generation-cards",
    title: "Generation cards",
    subtitle: "Developer preview surface",
    keywords: ["dev", "debug", "preview"],
    run: go("/dev/generation-cards"),
  },
];
