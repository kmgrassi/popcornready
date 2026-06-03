import type { GenerativeProvider } from "@popcorn/shared/generative/types";
import { createElevenLabsAudio } from "../audio";

export const elevenLabsProvider: GenerativeProvider = {
  name: "elevenlabs",
  async generateAsset(input) {
    if (input.kind !== "audio") {
      throw new Error("ElevenLabs provider currently supports audio generation only.");
    }
    return createElevenLabsAudio(input);
  },
};
