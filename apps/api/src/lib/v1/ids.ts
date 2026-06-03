import { newId } from "@/core/ids";

export { newId };

export const projectId = () => newId("proj");
export const briefVersionId = () => newId("briefv");
export const assetId = () => newId("asset");
export const compositionId = () => newId("comp");
export const jobId = () => newId("job");
export const editGraphId = () => newId("eg");
export const timelineId = () => newId("tl");
export const requestId = () => newId("req");
export const generationRunId = () => newId("genrun");
export const generationStageId = () => newId("genstage");
export const generationStageItemId = () => newId("genitem");
