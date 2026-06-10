import type { PaletteCommand } from "../palette/Palette";

function studioPath(params: Record<string, string>) {
  const search = new URLSearchParams({ start: "1", ...params });
  return `/studio?${search.toString()}`;
}

function go(to: string): PaletteCommand["run"] {
  return (navigate) => navigate(to);
}

export const studioCommands: PaletteCommand[] = [
  {
    id: "studio.open",
    title: "Open Studio",
    subtitle: "Guided video creation",
    keywords: ["create", "wizard", "brief"],
    run: go("/studio?start=1"),
  },
  {
    id: "studio.brief",
    title: "Edit brief",
    subtitle: "Goal, length, and aspect ratio",
    keywords: ["prompt", "goal", "duration", "format"],
    run: go(studioPath({ step: "brief" })),
  },
  {
    id: "studio.aspect-ratio",
    title: "Aspect ratio",
    subtitle: "Studio brief option",
    keywords: ["vertical", "wide", "square", "format", "9:16", "16:9", "1:1"],
    run: go(studioPath({ step: "brief", focus: "aspect" })),
  },
  {
    id: "studio.length",
    title: "Video length",
    subtitle: "Studio brief option",
    keywords: ["duration", "seconds", "15", "30", "60"],
    run: go(studioPath({ step: "brief", focus: "length" })),
  },
  {
    id: "studio.advanced-direction",
    title: "Advanced creative direction",
    subtitle: "Audience, platform, style, payoff, and CTA",
    keywords: ["audience", "platform", "style", "hook", "payoff", "cta"],
    run: go(studioPath({ step: "brief", panel: "advanced" })),
  },
  {
    id: "studio.footage",
    title: "Source footage",
    subtitle: "Choose prompt-only or uploaded source media",
    keywords: ["uploads", "assets", "media", "clips"],
    run: go(studioPath({ step: "footage" })),
  },
  {
    id: "studio.story",
    title: "Story direction",
    subtitle: "Story format and opening hook",
    keywords: ["format", "hook", "story shape", "beats"],
    run: go(studioPath({ step: "story" })),
  },
  {
    id: "studio.generate",
    title: "Generate rough cut",
    subtitle: "Generation handoff and run settings",
    keywords: ["start run", "provider", "seed", "captions", "review gates"],
    run: go(studioPath({ step: "generate" })),
  },
  {
    id: "studio.captions",
    title: "Captions",
    subtitle: "Generate-step option",
    keywords: ["burn in", "subtitles", "text"],
    run: go(studioPath({ step: "generate", panel: "generation" })),
  },
  {
    id: "studio.review-gates",
    title: "Review gates",
    subtitle: "Generate-step option",
    keywords: ["approve", "gate", "manual review", "pause"],
    run: go(studioPath({ step: "generate", panel: "generation" })),
  },
  {
    id: "studio.review-cut",
    title: "Review cut",
    subtitle: "Open the Studio review step",
    keywords: ["timeline", "feedback", "edit"],
    run: go(studioPath({ step: "review" })),
  },
  {
    id: "studio.export",
    title: "Export",
    subtitle: "Render settings and MP4 output",
    keywords: ["mp4", "quality", "download", "captions", "duration"],
    run: go(studioPath({ step: "export" })),
  },
];
