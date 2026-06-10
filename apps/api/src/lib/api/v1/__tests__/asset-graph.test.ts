import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJSON } from "@popcorn/shared/assets/hash";
import {
  canonicalContentHash,
  graphInputsFromProvenance,
  inputsFingerprint,
} from "../asset-graph";

test("canonicalJSON sorts object keys recursively and drops undefined fields", () => {
  assert.equal(
    canonicalJSON({
      b: 2,
      a: { d: undefined, c: 3 },
      list: [{ z: 1, y: 2 }],
    }),
    '{"a":{"c":3},"b":2,"list":[{"y":2,"z":1}]}'
  );
});

test("graphInputsFromProvenance materializes anchor and reference inputs with content hashes", () => {
  const hashes = new Map<string, string | null>([
    ["anchor_1", "hash_anchor"],
    ["ref_1", "hash_ref"],
  ]);

  const inputs = graphInputsFromProvenance(
    {
      provider: "mock",
      prompt: "shot",
      anchorIds: ["anchor_1"],
      referenceAssetIds: ["ref_1"],
    },
    hashes
  );

  assert.deepEqual(inputs, [
    {
      assetId: "anchor_1",
      relation: "anchor",
      role: "anchor",
      position: 0,
      contentHash: "hash_anchor",
    },
    {
      assetId: "ref_1",
      relation: "input",
      role: "reference",
      position: 0,
      contentHash: "hash_ref",
    },
  ]);
});

test("graphInputsFromProvenance prefers anchor relation when ids also condition provider references", () => {
  const inputs = graphInputsFromProvenance(
    {
      provider: "mock",
      prompt: "shot",
      anchorIds: ["asset_1"],
      referenceAssetIds: ["asset_1"],
    },
    new Map([["asset_1", "hash_1"]])
  );

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].relation, "anchor");
});

test("inputsFingerprint is stable across input order and changes when params change", () => {
  const inputsA = [
    { assetId: "b", relation: "input" as const, contentHash: "hash_b" },
    { assetId: "a", relation: "anchor" as const, contentHash: "hash_a" },
  ];
  const inputsB = [...inputsA].reverse();
  const params = { model: "mock-v1", seed: 7 };

  assert.equal(inputsFingerprint(inputsA, params), inputsFingerprint(inputsB, params));
  assert.notEqual(
    inputsFingerprint(inputsA, params),
    inputsFingerprint(inputsA, { ...params, seed: 8 })
  );
});

test("canonicalContentHash is stable for semantically identical object key order", () => {
  assert.equal(
    canonicalContentHash({ prompt: "x", params: { seed: 1, model: "m" } }),
    canonicalContentHash({ params: { model: "m", seed: 1 }, prompt: "x" })
  );
});
