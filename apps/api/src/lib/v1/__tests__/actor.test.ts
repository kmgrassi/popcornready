import assert from "node:assert/strict";
import test from "node:test";

import type { ApiRequestView } from "@/lib/api/v1/handler";
import { LOCAL_ACTOR_ID, LOCAL_WORKSPACE_ID } from "@/lib/api/v1/auth";
import { resolveActorFromRequest } from "../actor";

function request(): ApiRequestView {
  return {
    method: "POST",
    pathname: "/api/v1/projects/proj_test/generations",
    searchParams: new URLSearchParams(),
    header() {
      return null;
    },
    async rawBody() {
      return "";
    },
  };
}

test("local request actor uses the shared deterministic workspace", async () => {
  const previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "local";
  try {
    const actor = await resolveActorFromRequest(request());

    assert.equal(actor.actorId, LOCAL_ACTOR_ID);
    assert.equal(actor.workspaceId, LOCAL_WORKSPACE_ID);
    assert.equal(actor.isLocal, true);
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = previousAuthMode;
    }
  }
});
