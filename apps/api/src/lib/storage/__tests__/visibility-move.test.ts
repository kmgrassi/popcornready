import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveAssetVisibility,
  reconcileAssetStorage,
  type VisibilityObjectStore,
} from "../visibility-move";

const buckets = {
  publicBucket: "assets-public",
  privateBucket: "assets-private",
};

function recordingStore(failDelete = false) {
  const calls: string[] = [];
  const store: VisibilityObjectStore = {
    async copyObject(input) {
      calls.push(`copy:${input.sourceBucket}->${input.targetBucket}:${input.key}`);
    },
    async invalidatePublicObject(input) {
      calls.push(`invalidate:${input.key}`);
    },
    async deleteObject(input) {
      calls.push(`delete:${input.bucket}:${input.key}`);
      if (failDelete) throw new Error("delete failed");
    },
  };
  return { store, calls };
}

test("effective visibility requires both asset and project to be public", () => {
  assert.equal(
    effectiveAssetVisibility({ assetVisibility: "public", projectVisibility: "public" }),
    "public"
  );
  assert.equal(
    effectiveAssetVisibility({ assetVisibility: "public", projectVisibility: "private" }),
    "private"
  );
  assert.equal(
    effectiveAssetVisibility({ assetVisibility: "private", projectVisibility: "public" }),
    "private"
  );
});

test("reconcile copies, persists target bucket, invalidates, then deletes on privatize", async () => {
  const { store, calls } = recordingStore();
  const persisted: Array<string | null> = [];

  const result = await reconcileAssetStorage({
    asset: {
      id: "asset_1",
      visibility: "public",
      storageKey: "ws/proj/asset/file.mp4",
      storageBucket: "assets-public",
    },
    projectVisibility: "private",
    buckets,
    store,
    persistStorageBucket: async (bucket) => {
      calls.push(`persist:${bucket}`);
      persisted.push(bucket);
    },
  });

  assert.deepEqual(calls, [
    "copy:assets-public->assets-private:ws/proj/asset/file.mp4",
    "persist:assets-private",
    "invalidate:ws/proj/asset/file.mp4",
    "delete:assets-public:ws/proj/asset/file.mp4",
  ]);
  assert.deepEqual(persisted, ["assets-private"]);
  assert.equal(result.moved, true);
  assert.equal(result.invalidated, true);
});

test("reconcile leaves copied target object when source delete fails", async () => {
  const { store, calls } = recordingStore(true);

  await assert.rejects(
    reconcileAssetStorage({
      asset: {
        id: "asset_1",
        visibility: "private",
        storageKey: "ws/proj/asset/file.mp4",
        storageBucket: "assets-public",
      },
      projectVisibility: "public",
      buckets,
      store,
      persistStorageBucket: async (bucket) => {
        calls.push(`persist:${bucket}`);
      },
    }),
    /delete failed/
  );

  assert.deepEqual(calls, [
    "copy:assets-public->assets-private:ws/proj/asset/file.mp4",
    "persist:assets-private",
    "invalidate:ws/proj/asset/file.mp4",
    "delete:assets-public:ws/proj/asset/file.mp4",
  ]);
});

test("reconcile infers missing source bucket from previous effective visibility", async () => {
  const { store, calls } = recordingStore();

  const result = await reconcileAssetStorage({
    asset: {
      id: "asset_1",
      visibility: "private",
      storageKey: "ws/proj/asset/file.mp4",
      storageBucket: null,
    },
    projectVisibility: "public",
    previousEffectiveVisibility: "public",
    buckets,
    store,
    persistStorageBucket: async (bucket) => {
      calls.push(`persist:${bucket}`);
    },
  });

  assert.deepEqual(calls, [
    "copy:assets-public->assets-private:ws/proj/asset/file.mp4",
    "persist:assets-private",
    "invalidate:ws/proj/asset/file.mp4",
    "delete:assets-public:ws/proj/asset/file.mp4",
  ]);
  assert.equal(result.sourceBucket, "assets-public");
  assert.equal(result.targetBucket, "assets-private");
  assert.equal(result.moved, true);
});

test("reconcile fails missing source bucket when it cannot infer source", async () => {
  await assert.rejects(
    reconcileAssetStorage({
      asset: {
        id: "asset_1",
        visibility: "private",
        storageKey: "ws/proj/asset/file.mp4",
        storageBucket: null,
      },
      projectVisibility: "public",
      buckets,
      store: recordingStore().store,
      persistStorageBucket: async () => {
        throw new Error("should not persist");
      },
    }),
    /storage bucket is missing/
  );
});

test("project republish restores only assets whose own flag is public", async () => {
  const publicAsset = await reconcileAssetStorage({
    asset: {
      id: "asset_public",
      visibility: "public",
      storageKey: "asset-public.mp4",
      storageBucket: "assets-private",
    },
    projectVisibility: "public",
    buckets,
    store: recordingStore().store,
    persistStorageBucket: async () => {},
  });
  const privateAsset = await reconcileAssetStorage({
    asset: {
      id: "asset_private",
      visibility: "private",
      storageKey: "asset-private.mp4",
      storageBucket: "assets-private",
    },
    projectVisibility: "public",
    buckets,
    store: recordingStore().store,
    persistStorageBucket: async () => {},
  });

  assert.equal(publicAsset.targetBucket, "assets-public");
  assert.equal(privateAsset.targetBucket, "assets-private");
});
