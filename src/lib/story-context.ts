import { StoryContext } from "./types";

export const DEFAULT_STORY_CONTEXT: StoryContext = {
  audience: "curious non-expert viewer",
  platform: "general",
  format: "mystery_to_model",
  hookQuestion: "What hidden mechanism or surprising question should make someone stop watching?",
  strongestVisual: "Lead with the clearest visual proof, reveal, demo, or contradiction.",
  emotionalPull: "curiosity, surprise, wonder, useful understanding",
  oneBigIdea: "Teach one concrete idea instead of dumping a broad topic.",
  simpleModel: "Move from visual question to simple mental model.",
  caveat: "Include one careful caveat when accuracy needs it.",
  payoff: "Leave the viewer smarter than they were at the hook.",
  callToAction: "Invite the viewer to continue the story or try the next step.",
};

export function mergeStoryContext(input?: StoryContext | null): StoryContext {
  return {
    ...DEFAULT_STORY_CONTEXT,
    ...(input || {}),
  };
}

export function storyContextForPrompt(input?: StoryContext | null): string {
  const c = mergeStoryContext(input);
  return [
    `audience: ${c.audience}`,
    `platform: ${c.platform}`,
    `story format: ${c.format}`,
    `hook question: ${c.hookQuestion}`,
    `strongest visual: ${c.strongestVisual}`,
    `emotional pull: ${c.emotionalPull}`,
    `one big idea: ${c.oneBigIdea}`,
    `simple model: ${c.simpleModel}`,
    `caveat: ${c.caveat}`,
    `payoff: ${c.payoff}`,
    `call to action: ${c.callToAction}`,
  ].join("\n");
}
