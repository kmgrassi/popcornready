import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  AssetKind,
  GenerationRunStatus,
  V1Project,
} from "@popcorn/shared/v1/types";
import {
  v1Api,
  type AssetMediaResponse,
  type ProjectsResponse,
  type WorkspaceAsset,
  type WorkspaceAssetSource,
  type WorkspaceAssetsResponse,
  type WorkspaceOutput,
  type WorkspaceOutputsResponse,
} from "../../api-client";
import { useMeQuery } from "../../queryClient";

type PageCursor = string | null;

export const dashboardCollectionQueryKeys = {
  projects: (workspaceId: string, limit: number) =>
    ["dashboard", "projects", workspaceId, { limit }] as const,
  runs: (
    workspaceId: string,
    filters: {
      status: GenerationRunStatus | "all";
      projectId?: string;
      limit: number;
    },
  ) =>
    [
      "dashboard",
      "generation-runs",
      workspaceId,
      {
        status: filters.status,
        projectId: filters.projectId ?? null,
        limit: filters.limit,
      },
    ] as const,
  assets: (
    workspaceId: string,
    filters: {
      kind: AssetKind | "all";
      source: WorkspaceAssetSource | "all";
      limit: number;
    },
  ) =>
    [
      "dashboard",
      "assets",
      workspaceId,
      {
        kind: filters.kind,
        source: filters.source,
        limit: filters.limit,
      },
    ] as const,
  outputs: (workspaceId: string, limit: number) =>
    ["dashboard", "outputs", workspaceId, { limit }] as const,
};

function assetKey(asset: WorkspaceAsset): string {
  return asset.assetId ?? asset.id;
}

function updateAssetPages(
  data: InfiniteData<WorkspaceAssetsResponse, PageCursor> | undefined,
  assetId: string,
  update: (asset: WorkspaceAsset) => WorkspaceAsset,
): InfiniteData<WorkspaceAssetsResponse, PageCursor> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      assets: page.assets.map((asset) =>
        assetKey(asset) === assetId ? update(asset) : asset,
      ),
    })),
  };
}

function flattenPages<TPage, TItem>(
  pages: TPage[] | undefined,
  selectItems: (page: TPage) => TItem[],
): TItem[] {
  return pages?.flatMap(selectItems) ?? [];
}

export function useDashboardRunsQuery(
  authScope: string,
  filters: {
    status: GenerationRunStatus | "all";
    projectId?: string;
    limit: number;
  },
) {
  const meQuery = useMeQuery(authScope);
  const workspaceId = meQuery.data?.workspaceId ?? "pending";
  const query = useInfiniteQuery({
    queryKey: dashboardCollectionQueryKeys.runs(workspaceId, filters),
    enabled: Boolean(meQuery.data),
    initialPageParam: null as PageCursor,
    queryFn: ({ pageParam, signal }) =>
      v1Api.listWorkspaceGenerationRuns(
        meQuery.data!.workspaceId,
        {
          status: filters.status,
          projectId: filters.projectId,
          limit: filters.limit,
          cursor: pageParam,
        },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor,
  });

  return {
    items: flattenPages(query.data?.pages, (page) => page.runs),
    error: meQuery.error ?? query.error ?? null,
    loading: meQuery.isLoading || query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: () => {
      void meQuery.refetch();
      void query.refetch();
    },
  };
}

export function useDashboardProjectsQuery(authScope: string, limit: number) {
  const meQuery = useMeQuery(authScope);
  const workspaceId = meQuery.data?.workspaceId ?? "pending";
  const query = useInfiniteQuery({
    queryKey: dashboardCollectionQueryKeys.projects(workspaceId, limit),
    enabled: Boolean(meQuery.data),
    initialPageParam: null as PageCursor,
    queryFn: ({ pageParam }) =>
      v1Api.listProjects({ limit, cursor: pageParam }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor,
  });

  return {
    items: flattenPages<ProjectsResponse, V1Project>(
      query.data?.pages,
      (page) => page.projects,
    ),
    error: meQuery.error ?? query.error ?? null,
    loading: meQuery.isLoading || query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: () => {
      void meQuery.refetch();
      void query.refetch();
    },
  };
}

export function useDashboardAssetsQuery(
  authScope: string,
  filters: {
    kind: AssetKind | "all";
    source: WorkspaceAssetSource | "all";
    limit: number;
  },
) {
  const meQuery = useMeQuery(authScope);
  const workspaceId = meQuery.data?.workspaceId ?? "pending";
  const queryKey = dashboardCollectionQueryKeys.assets(workspaceId, filters);
  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(meQuery.data),
    initialPageParam: null as PageCursor,
    queryFn: ({ pageParam, signal }) =>
      v1Api.listWorkspaceAssets(
        meQuery.data!.workspaceId,
        {
          kind: filters.kind,
          source: filters.source,
          limit: filters.limit,
          cursor: pageParam,
        },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor,
  });

  return {
    items: flattenPages(query.data?.pages, (page) => page.assets),
    error: meQuery.error ?? query.error ?? null,
    loading: meQuery.isLoading || query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    queryKey,
    refetch: () => {
      void meQuery.refetch();
      void query.refetch();
    },
  };
}

export function useDashboardOutputsQuery(authScope: string, limit: number) {
  const meQuery = useMeQuery(authScope);
  const workspaceId = meQuery.data?.workspaceId ?? "pending";
  const query = useInfiniteQuery({
    queryKey: dashboardCollectionQueryKeys.outputs(workspaceId, limit),
    enabled: Boolean(meQuery.data),
    initialPageParam: null as PageCursor,
    queryFn: ({ pageParam, signal }) =>
      v1Api.listWorkspaceOutputs(
        meQuery.data!.workspaceId,
        { limit, cursor: pageParam },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor,
  });

  return {
    items: flattenPages<WorkspaceOutputsResponse, WorkspaceOutput>(
      query.data?.pages,
      (page) => page.outputs,
    ),
    error: meQuery.error ?? query.error ?? null,
    loading: meQuery.isLoading || query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: () => {
      void meQuery.refetch();
      void query.refetch();
    },
  };
}

export function useAssetVisibilityMutation(
  authScope: string,
  filters: {
    kind: AssetKind | "all";
    source: WorkspaceAssetSource | "all";
    limit: number;
  },
) {
  const queryClient = useQueryClient();
  const meQuery = useMeQuery(authScope);
  const queryKey = meQuery.data
    ? dashboardCollectionQueryKeys.assets(meQuery.data.workspaceId, filters)
    : null;

  return useMutation({
    mutationFn: ({
      asset,
      visibility,
    }: {
      asset: WorkspaceAsset;
      visibility: "public" | "private";
    }) => v1Api.setAssetVisibility(asset.projectId, assetKey(asset), visibility),
    onMutate: async ({ asset, visibility }) => {
      if (!queryKey) return {};
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<InfiniteData<WorkspaceAssetsResponse, PageCursor>>(
          queryKey,
        );
      queryClient.setQueryData<
        InfiniteData<WorkspaceAssetsResponse, PageCursor>
      >(queryKey, (current) =>
        updateAssetPages(current, assetKey(asset), (item) => ({
          ...item,
          visibility,
        })),
      );
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.queryKey && context.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
    onSuccess: (payload, { asset, visibility }) => {
      if (!queryKey) return;
      queryClient.setQueryData<
        InfiniteData<WorkspaceAssetsResponse, PageCursor>
      >(queryKey, (current) =>
        updateAssetPages(current, assetKey(asset), (item) => ({
          ...item,
          visibility: payload.asset.visibility ?? visibility,
        })),
      );
    },
  });
}

export function useAssetMediaMutation(
  authScope: string,
  filters: {
    kind: AssetKind | "all";
    source: WorkspaceAssetSource | "all";
    limit: number;
  },
) {
  const queryClient = useQueryClient();
  const meQuery = useMeQuery(authScope);
  const queryKey = meQuery.data
    ? dashboardCollectionQueryKeys.assets(meQuery.data.workspaceId, filters)
    : null;

  return useMutation({
    mutationFn: (assetId: string) => v1Api.refreshAssetMedia(assetId),
    onSuccess: (media: AssetMediaResponse, assetId) => {
      if (!queryKey) return;
      queryClient.setQueryData<
        InfiniteData<WorkspaceAssetsResponse, PageCursor>
      >(queryKey, (current) =>
        updateAssetPages(current, assetId, (asset) => ({
          ...asset,
          url: media.url ?? undefined,
          thumbnailUrl: media.thumbnailUrl ?? undefined,
        })),
      );
    },
  });
}
