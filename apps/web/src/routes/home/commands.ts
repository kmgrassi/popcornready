import type { PaletteCommand } from "../../components/palette/Palette";

function go(to: string): PaletteCommand["run"] {
  return (navigate) => navigate(to);
}

export const homeCommands: PaletteCommand[] = [
  {
    id: "home.open",
    title: "Open Home",
    subtitle: "Dashboard launchpad",
    keywords: ["dashboard", "launchpad", "next action"],
    run: go("/dashboard"),
  },
  {
    id: "home.new-video",
    title: "New video",
    subtitle: "Start the guided Studio flow",
    keywords: ["create", "studio", "start", "rough cut"],
    run: go("/studio?start=1"),
  },
];
