import type { PaletteCommand } from "../../components/palette/Palette";

function go(to: string): PaletteCommand["run"] {
  return (navigate) => navigate(to);
}

export const libraryCommands: PaletteCommand[] = [
  {
    id: "library.projects",
    title: "Projects",
    subtitle: "Browse workspace projects",
    keywords: ["library", "cuts", "storyboard"],
    run: go("/projects"),
  },
  {
    id: "library.runs",
    title: "Runs",
    subtitle: "Track generation runs",
    keywords: ["library", "status", "progress", "queued", "running"],
    run: go("/runs"),
  },
  {
    id: "library.assets",
    title: "Assets",
    subtitle: "Browse uploaded and generated assets",
    keywords: ["library", "uploads", "images", "video", "audio"],
    run: go("/assets"),
  },
  {
    id: "library.outputs",
    title: "Outputs",
    subtitle: "Browse exported videos",
    keywords: ["library", "exports", "mp4", "renders"],
    run: go("/outputs"),
  },
  {
    id: "library.evals",
    title: "Evals",
    subtitle: "Quality checks and evaluation runs",
    keywords: ["quality", "admin", "tests"],
    run: go("/evals"),
  },
  {
    id: "library.storyboard",
    title: "Storyboard",
    subtitle: "Open the storyboard surface",
    keywords: ["project", "beats", "scenes"],
    run: go("/storyboard"),
  },
];
