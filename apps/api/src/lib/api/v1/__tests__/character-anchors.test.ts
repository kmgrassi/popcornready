import assert from "node:assert/strict";
import test from "node:test";

import { AuthContext } from "../auth";
import {
  CharacterAnchorDeps,
  generateCharacterAnchor,
} from "../character-anchors";
import { ApiError } from "../errors";
import type { V1Asset } from "../store";

// Unit test for the anchor wrapper (granular generation API §3, P2). The asset
// generator and store are injected as `deps` so this runs offline — it proves
// the wiring (character binding / provenance forwarded, the generic
// generated-assets image path reused, typed precondition errors) without a live
// Supabase or any image provider.

const LOCAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: LOCAL_WORKSPACE_ID,
  isLocal: true,
};

function characterAsset(overrides: Partial<V1Asset> = {}): V1Asset {
  return {
    id: "char_fleming",
    schemaVersion: 1,
    workspaceId: LOCAL_WORKSPACE_ID,
    projectId: "proj_1",
    kind: "image",
    filename: "Fleming.character_anchor",
    status: "ready",
    source: { type: "remote_url", url: "https://x/y" },
    userContext: {
      title: "Fleming",
      characterNames: ["Fleming"],
      intendedUse: ["character_reference"],
      tags: ["character_anchor"],
    },
    context: { recommendedRoles: ["character_anchor"] },
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  } as V1Asset;
}

const neverCalled = (label: string) =>
  (async () => {
    throw new Error(`${label} should not be called`);
  }) as never;

function deps(overrides: Partial<CharacterAnchorDeps>): Partial<CharacterAnchorDeps> {
  return overrides;
}

test("binds the character into provenance and reuses the image generator", async () => {
  let createdBody: Record<string, unknown> | undefined;
  const job = { id: "job_1", type: "asset_generation", status: "succeeded" };

  const res = await generateCharacterAnchor({
    auth,
    projectId: "proj_1",
    characterId: "char_fleming",
    body: {
      prompt: "noir portrait",
      provider: "mock",
      referenceAssetIds: ["ref_hero"],
    },
    deps: deps({
      getAsset: async () => characterAsset(),
      createGeneratedAsset: async (args) => {
        createdBody = args.body as Record<string, unknown>;
        return { status: 202, body: { job } };
      },
    }),
  });

  // Returns the pollable Job envelope from createGeneratedAsset unchanged.
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.job, job);

  // Character binding / provenance: the characterId is forwarded as the bound
  // profile id (createGeneratedAsset records this as characterBinding).
  assert.deepEqual(createdBody?.characterProfileIds, ["char_fleming"]);
  // Reuses the image path of the generic generated-assets primitive.
  assert.equal(createdBody?.kind, "image");
  assert.equal(createdBody?.prompt, "noir portrait");
  assert.equal(createdBody?.provider, "mock");
  // Caller fields pass through to the generic generator.
  assert.deepEqual(createdBody?.referenceAssetIds, ["ref_hero"]);
  // The internal autocreate flag is stripped before delegation.
  assert.equal("autocreate" in (createdBody ?? {}), false);
});

test("defaults the prompt from the character context when none is given", async () => {
  let createdBody: Record<string, unknown> | undefined;

  await generateCharacterAnchor({
    auth,
    projectId: "proj_1",
    characterId: "char_fleming",
    body: {},
    deps: deps({
      getAsset: async () =>
        characterAsset({
          context: {
            summary: "tall, scarred, trench coat",
            recommendedRoles: ["character_anchor"],
          },
        }),
      createGeneratedAsset: async (args) => {
        createdBody = args.body as Record<string, unknown>;
        return { status: 202, body: { job: {} } };
      },
    }),
  });

  assert.equal(createdBody?.prompt, "tall, scarred, trench coat");
});

test("unknown character returns a structured not_found precondition error", async () => {
  await assert.rejects(
    generateCharacterAnchor({
      auth,
      projectId: "proj_1",
      characterId: "nope",
      body: {},
      deps: deps({
        getAsset: async () => {
          throw new ApiError("not_found", "Asset not found: nope");
        },
        createGeneratedAsset: neverCalled("createGeneratedAsset"),
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "not_found");
      return true;
    }
  );
});

test("a non-character asset returns a structured asset_invalid precondition error", async () => {
  await assert.rejects(
    generateCharacterAnchor({
      auth,
      projectId: "proj_1",
      characterId: "clip_1",
      body: {},
      deps: deps({
        getAsset: async () =>
          characterAsset({
            userContext: undefined,
            context: { recommendedRoles: ["b_roll"] },
          }),
        createGeneratedAsset: neverCalled("createGeneratedAsset"),
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "asset_invalid");
      return true;
    }
  );
});

test("autocreate=true materializes the character then generates the anchor", async () => {
  let registered = false;
  let createdBody: Record<string, unknown> | undefined;

  await generateCharacterAnchor({
    auth,
    projectId: "proj_1",
    characterId: "char_new",
    body: { autocreate: true, name: "Newcomer", prompt: "first look" },
    deps: deps({
      getAsset: async () => {
        throw new ApiError("not_found", "Asset not found: char_new");
      },
      registerAsset: async () => {
        registered = true;
        return characterAsset({ id: "char_new", userContext: { characterNames: ["Newcomer"] } });
      },
      createGeneratedAsset: async (args) => {
        createdBody = args.body as Record<string, unknown>;
        return { status: 202, body: { job: {} } };
      },
    }),
  });

  assert.equal(registered, true);
  assert.deepEqual(createdBody?.characterProfileIds, ["char_new"]);
  assert.equal(createdBody?.prompt, "first look");
});
