import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateStudioDraft,
  parseUpdateStudioDraft,
} from "../schemas";
import { displayExcerptForStudioDraft } from "../store";
import type { StudioDraftPayload } from "@popcorn/shared/v1/studio-drafts";

const payload: StudioDraftPayload = {
  v: 1,
  draft: { goal: "Make a launch teaser", targetLengthSec: 30 },
  step: "brief",
};

test("parseCreateStudioDraft accepts a versioned payload", () => {
  const parsed = parseCreateStudioDraft({ payload });
  assert.deepEqual(parsed.payload, payload);
});

test("parseUpdateStudioDraft rejects unknown steps", () => {
  assert.throws(
    () =>
      parseUpdateStudioDraft({
        payload: { ...payload, step: "publish" },
      }),
    /The request body is invalid/
  );
});

test("parseCreateStudioDraft rejects stale payload versions", () => {
  assert.throws(
    () =>
      parseCreateStudioDraft({
        payload: { ...payload, v: 0 },
      }),
    /The request body is invalid/
  );
});

test("displayExcerptForStudioDraft derives a compact goal snippet", () => {
  assert.equal(
    displayExcerptForStudioDraft({
      ...payload,
      draft: { goal: "  Make   a\nlaunch\tteaser  " },
    }),
    "Make a launch teaser"
  );
  assert.equal(
    displayExcerptForStudioDraft({ ...payload, draft: { goal: "" } }),
    "Untitled draft"
  );
  assert.ok(
    displayExcerptForStudioDraft({
      ...payload,
      draft: { goal: "A".repeat(140) },
    }).endsWith("...")
  );
});
