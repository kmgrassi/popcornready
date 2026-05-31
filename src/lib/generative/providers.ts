import type { GenerativeProvider } from "./types";
import { elevenLabsProvider } from "./providers/elevenlabs";
import { geminiProvider } from "./providers/gemini";
import { ltxProvider } from "./providers/ltx";
import { mockProvider, unsupportedProvider } from "./providers/mock";
import { openAIProvider } from "./providers/openai";
import { runwayProvider } from "./providers/runway";

export { downloadOpenAIVideoById, getOpenAIVideoById } from "./providers/openai";

export function providerFor(name: string): GenerativeProvider {
  switch (name.toLowerCase()) {
    case "openai":
      return openAIProvider;
    case "gemini":
      return geminiProvider;
    case "runway":
    case "runwayml":
      return runwayProvider;
    case "ltx":
    case "ltxvideo":
    case "ltx-video":
      return ltxProvider;
    case "elevenlabs":
      return elevenLabsProvider;
    case "nanobanano":
    case "nano-banano":
    case "nano_banano":
      return unsupportedProvider("nanobanano");
    case "mock":
      return mockProvider;
    default:
      throw new Error(`Unknown generative provider: ${name}`);
  }
}
