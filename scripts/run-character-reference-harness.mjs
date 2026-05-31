#!/usr/bin/env node

const baseUrl = process.env.POPCORNREADY_URL || "http://localhost:3000";
const endpoint = new URL("/api/debug/character-reference-video", baseUrl);

const body = {
  seconds: Number(process.env.HARNESS_VIDEO_SECONDS || "2"),
  videoProvider: process.env.HARNESS_VIDEO_PROVIDER || "gemini",
  imageProvider: "openai",
  goal:
    process.env.HARNESS_GOAL ||
    "A 10-year-old movie-loving boy in a bedroom late at night discovers Popcorn Ready and dreams of becoming a filmmaker.",
  style: process.env.HARNESS_STYLE || "cinematic live-action",
};

console.log(`[harness] POST ${endpoint.toString()}`);
console.log(`[harness] videoProvider=${body.videoProvider} requestedSeconds=${body.seconds}`);

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text };
}

if (!response.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

const makeUrl = (path) => new URL(path, baseUrl).toString();
console.log("\n[harness] Character reference output");
console.log(`hero: ${makeUrl(payload.heroImage.url)}`);
for (const [index, video] of payload.videos.entries()) {
  console.log(`video ${index + 1}: ${makeUrl(video.url)}`);
}
console.log(`requestedSeconds: ${payload.requestedSeconds}`);
console.log(`effectiveSeconds: ${payload.effectiveSeconds}`);
if (payload.note) console.log(`note: ${payload.note}`);
