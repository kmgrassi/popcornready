import type { AspectRatio } from "@popcorn/shared/v1/types";
import type {
  Platform,
  StoryFormat,
} from "./useStudioFlow";

export const studioCopy = {
  brief: {
    heading: "What should this video do?",
    description:
      "Give the agent the outcome, audience, and message. Keep it short; the next steps refine footage and story direction.",
    goalLabel: "What should this video do?",
    goalPlaceholder:
      "e.g. Make a 60s launch video that shows how our app turns raw clips into a polished product teaser.",
    lengthLabel: "Length",
    aspectLabel: "Aspect ratio",
    advancedSummary: "Advanced creative direction",
  },
  advanced: {
    audience: "Audience",
    platform: "Platform",
    format: "Story format",
    hook: "Hook question",
    bestVisual: "Best visual proof",
    bigIdea: "One big idea",
    payoff: "What should the viewer understand by the end?",
    accuracyNote: "Accuracy note",
    style: "Style",
  },
  footage: {
    usageLabel: "How should we use your footage?",
  },
} as const;

export const lengthOptions = [
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
  { value: 120, label: "2m" },
  { value: 300, label: "5m" },
] as const;

export const aspectOptions: Array<{ value: AspectRatio; label: string }> = [
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "1:1", label: "1:1" },
];

export const platformOptions: Array<{ value: Platform; label: string }> = [
  { value: "tiktok", label: "TikTok" },
  { value: "reels", label: "Reels" },
  { value: "youtube", label: "YouTube" },
  { value: "facebook", label: "Facebook" },
  { value: "vimeo", label: "Vimeo" },
  { value: "general", label: "General" },
];

export const formatOptions: Array<{ value: StoryFormat; label: string }> = [
  { value: "visual_reveal", label: "Visual reveal" },
  { value: "mystery_to_model", label: "Mystery to model" },
  { value: "challenge", label: "Challenge" },
  { value: "misconception", label: "Misconception" },
  { value: "animated_explainer", label: "Animated explainer" },
  { value: "classroom_demo", label: "Classroom demo" },
  { value: "aesthetic_montage", label: "Aesthetic montage" },
];
