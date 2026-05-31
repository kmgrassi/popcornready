// Stable, prefixed IDs for v1 resources. Mirrors the MVP convention
// (prefix + short random suffix) used elsewhere in the codebase.
function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function newId(prefix: string): string {
  return `${prefix}_${rand()}`;
}

export const projectId = () => newId("proj");
export const briefVersionId = () => newId("briefv");
export const assetId = () => newId("asset");
export const compositionId = () => newId("comp");
export const jobId = () => newId("job");
export const timelineId = () => newId("tl");
export const requestId = () => newId("req");
export const generationRunId = () => newId("genrun");
export const generationStageId = () => newId("genstage");
export const generationStageItemId = () => newId("genitem");
