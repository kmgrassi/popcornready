import { OpenAIVideoSeconds } from "@/lib/generative/types";

export interface DebugOpenAIVideoShot {
  key: string;
  durationSec: OpenAIVideoSeconds;
  prompt: string;
}

export const POPCORN_READY_STORY_SHOTS: DebugOpenAIVideoShot[] = [
  {
    key: "discovery",
    durationSec: 4,
    prompt:
      "A 10-year-old boy in his bedroom at night, looking at a laptop on his desk in a cozy dimly lit room with movie posters and film toys behind him. He notices the website named Popcorn Ready on screen and his face shows curiosity and excitement as he scrolls into it. Cinematic, realistic, high detail, 9:16, no subtitles.",
  },
  {
    key: "building",
    durationSec: 8,
    prompt:
      "The same curious 10-year-old boy passionately creating a movie on Popcorn Ready at night, rapidly typing a screenplay, arranging scenes, and generating cinematic scenes on the screen. Show montage energy, rapid motion, intense focus, cinematic lighting, strong composition, 9:16.",
  },
  {
    key: "release",
    durationSec: 4,
    prompt:
      "A packed movie theater premiere crowd cheering and watching his movie projected on a giant screen, banners and lights, the boy's finished film glowing with big emotions, cinematic wide shots and close-ups of joyful fans, 9:16, realistic, documentary-like.",
  },
  {
    key: "premiere",
    durationSec: 8,
    prompt:
      "The 10-year-old boy, now more confident, walking through a red-carpet premiere with crowds praising his work, flashbulbs, camera flashes, festive atmosphere, he looks amazed and proud, cinematic event montage, 9:16, highly cinematic.",
  },
  {
    key: "awards",
    durationSec: 4,
    prompt:
      "The boy at an awards show podium receiving a trophy, walking up confidently to the microphone and smiling warmly, says 'I would like to thank ...' in the shot, cinematic close-up, emotional and polished, 9:16, realistic, no subtitles.",
  },
  {
    key: "wake-up",
    durationSec: 4,
    prompt:
      "At dawn, the boy wakes up in his bed in the same bedroom, turns his head toward his laptop, and sees the Popcorn Ready website open on screen. Quiet ending moment with soft morning light, cinematic realism, 9:16.",
  },
];

export const DEFAULT_SINGLE_OPENAI_VIDEO =
  "A 10-year-old movie-loving boy at night in a bedroom with a laptop, excitedly discovering the Popcorn Ready website for the first time. Cinematic realism, subtle camera movement, 9:16, no subtitles.";
