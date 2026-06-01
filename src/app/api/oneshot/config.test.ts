import assert from "node:assert/strict";
import test from "node:test";

import { shouldUsePopcornReadyScreenReference } from "./config";

test("Popcorn Ready screen reference is gated to prompts that ask for the screen", () => {
  assert.equal(
    shouldUsePopcornReadyScreenReference(
      "End with the boy looking up to see the Popcorn Ready screen glowing on his computer."
    ),
    true
  );
  assert.equal(
    shouldUsePopcornReadyScreenReference(
      "Create a cozy bakery launch video with warm morning light and handmade pastries."
    ),
    false
  );
  assert.equal(
    shouldUsePopcornReadyScreenReference(
      "Create a Popcorn Ready founder story without showing any product UI."
    ),
    false
  );
});
