import { createHash } from "node:crypto";
import { canonicalJSON } from "@popcorn/shared/assets/hash";
import type { GeneratedAssetProvenance } from "./provenance";

export type AssetInputRelation = "input" | "anchor" | "child";

export interface GraphAssetInput {
  assetId: string;
  relation: AssetInputRelation;
  role?: string;
  position?: number;
  contentHash?: string;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalContentHash(value: unknown): string {
  return sha256Hex(canonicalJSON(value));
}

export function graphInputsFromProvenance(
  provenance: GeneratedAssetProvenance | undefined,
  contentHashByAssetId: Map<string, string | null>
): GraphAssetInput[] {
  if (!provenance) return [];

  const inputs: GraphAssetInput[] = [];
  const seen = new Set<string>();

  function add(
    assetId: string,
    relation: AssetInputRelation,
    role: string,
    position: number
  ): void {
    if (!assetId || seen.has(assetId)) return;
    seen.add(assetId);
    const contentHash = contentHashByAssetId.get(assetId) ?? undefined;
    inputs.push({
      assetId,
      relation,
      role,
      position,
      ...(contentHash ? { contentHash } : {}),
    });
  }

  provenance.anchorIds?.forEach((assetId, index) => {
    add(assetId, "anchor", "anchor", index);
  });
  provenance.referenceAssetIds?.forEach((assetId, index) => {
    add(assetId, "input", "reference", index);
  });

  return inputs;
}

export function inputsFingerprint(
  inputs: GraphAssetInput[],
  params: unknown
): string {
  const paramsHash = canonicalContentHash(params ?? null);
  const inputHashes = inputs
    .map((input) => ({
      assetId: input.assetId,
      contentHash: input.contentHash ?? "",
    }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
  return canonicalContentHash({ inputHashes, paramsHash });
}
