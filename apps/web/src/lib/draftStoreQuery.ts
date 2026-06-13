import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createDraft,
  deleteDraft,
  listDrafts,
  loadDraft,
  type StudioDraftRecord,
  type StudioDraftSummary,
} from "./draftStore";
import type { BriefDraft, StudioStep } from "../components/studio/useStudioFlow";

export const studioDraftQueryKeys = {
  all: ["studio-drafts"] as const,
  lists: () => [...studioDraftQueryKeys.all, "list"] as const,
  detail: (draftId: string) => [...studioDraftQueryKeys.all, "detail", draftId] as const,
};

export function useStudioDraftsQuery() {
  return useQuery({
    queryKey: studioDraftQueryKeys.lists(),
    queryFn: listDrafts,
  });
}

export function useStudioDraftQuery(draftId: string | null) {
  return useQuery({
    queryKey: draftId
      ? studioDraftQueryKeys.detail(draftId)
      : [...studioDraftQueryKeys.all, "detail", "pending"],
    queryFn: () => loadDraft(draftId!),
    enabled: Boolean(draftId),
    refetchOnMount: "always",
    staleTime: 0,
  });
}

export function useCreateStudioDraftMutation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({
      draft,
      step,
    }: {
      draft: BriefDraft;
      step: StudioStep;
    }) => createDraft(draft, step),
    onSuccess: (record) => {
      client.setQueryData<StudioDraftSummary[] | undefined>(
        studioDraftQueryKeys.lists(),
        (current) => {
          if (!current) return current;
          const { payload: _payload, ...summary } = record;
          return [summary, ...current.filter((draft) => draft.draftId !== record.draftId)];
        },
      );
      void client.invalidateQueries({ queryKey: studioDraftQueryKeys.lists() });
    },
  });
}

export function useDeleteStudioDraftMutation() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: deleteDraft,
    onSuccess: (_result, draftId) => {
      client.removeQueries({ queryKey: studioDraftQueryKeys.detail(draftId) });
      client.setQueryData<StudioDraftSummary[] | undefined>(
        studioDraftQueryKeys.lists(),
        (current) => current?.filter((draft) => draft.draftId !== draftId),
      );
      void client.invalidateQueries({ queryKey: studioDraftQueryKeys.lists() });
    },
  });
}
