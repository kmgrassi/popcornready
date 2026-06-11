import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AssetKind, GenerationRunStatus, V1Project } from "@popcorn/shared/v1/types";
import {
  ApiClientError,
  v1Api,
  type WorkspaceAsset,
  type WorkspaceAssetSource,
  type WorkspaceGenerationRun,
  type WorkspaceOutput,
} from "../lib/api-client";
import { PageHeader } from "../components/ui/PageHeader";
import { Toolbar, ToolbarField } from "../components/ui/Toolbar";
import { Button, ButtonLink } from "../components/ui/Button";
import { EmptyState, ErrorState } from "../components/ui/StateCard";
import { MediaViewer, type MediaViewerItem } from "../components/media/MediaViewer";
import styles from "./DashboardCollections.module.css";

const PAGE_SIZE = 24;
const RUN_STATUSES = ["all", "queued", "running", "succeeded", "failed", "canceled"] as const;
const ASSET_KINDS = ["all", "image", "video", "audio"] as const;
const ASSET_SOURCES = ["all", "uploaded", "generated"] as const;

type RunStatusFilter = (typeof RUN_STATUSES)[number];
type AssetKindFilter = (typeof ASSET_KINDS)[number];
type AssetSourceFilter = (typeof ASSET_SOURCES)[number];

interface LoadState<T> {
  workspaceId: string | null;
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: ApiClientError | Error | null;
}

function initialState<T>(): LoadState<T> {
  return { workspaceId: null, items: [], nextCursor: null, loading: true, loadingMore: false, error: null };
}

function formatDate(value?: string) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return null;
  const totalSeconds = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function isStaleRequest(signal: AbortSignal | undefined, requestId: number, latestRequestId: number) {
  return Boolean(signal?.aborted) || requestId !== latestRequestId;
}

function projectCollectionPath(projectId: string, extraParams?: Record<string, string | undefined>) {
  const params = new URLSearchParams({ projectId });
  for (const [key, value] of Object.entries(extraParams ?? {})) {
    if (value) params.set(key, value);
  }
  return `/library/projects?${params.toString()}`;
}

function projectWatchPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/watch`;
}

function statusChipClass(status: string) {
  if (status === "running" || status === "processing") return styles.statusRunning;
  if (status === "succeeded" || status === "ready") return styles.statusSucceeded;
  if (status === "failed" || status === "canceled") return styles.statusFailed;
  return "";
}

function StatusChip({ status }: { status: GenerationRunStatus | WorkspaceAsset["status"] }) {
  return <span className={`${styles.chip} ${statusChipClass(status)}`}>{titleCase(status)}</span>;
}

function assetViewerItem(asset: WorkspaceAsset): MediaViewerItem {
  const id = asset.assetId ?? asset.id;
  return {
    id,
    kind: asset.kind,
    title: asset.title ?? asset.filename ?? id,
    filename: asset.filename,
    projectName: asset.projectName,
    durationSec: asset.durationSec,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl,
  };
}

function outputViewerItem(output: WorkspaceOutput): MediaViewerItem {
  return {
    id: output.artifactId,
    kind: "video",
    title: output.projectName,
    projectName: output.projectName,
    durationSec: output.durationSec,
    url: output.playbackUrl ?? output.url,
    thumbnailUrl: output.thumbnailUrl,
  };
}

function DashboardFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Library"
        title={title}
        description={description}
        action={
          <ButtonLink variant="primary" to="/studio">
            New video
          </ButtonLink>
        }
      />
      {children}
    </div>
  );
}

function DashboardSkeleton({ variant = "rows" }: { variant?: "rows" | "grid" }) {
  const isGrid = variant === "grid";
  return (
    <div className={isGrid ? styles.grid : styles.list} aria-hidden="true">
      {Array.from({ length: isGrid ? 8 : 5 }, (_, index) => (
        <div className={`${styles.skeleton} ${isGrid ? styles.skeletonGrid : ""}`} key={index}>
          <span /><span /><span />
        </div>
      ))}
    </div>
  );
}

function LoadMore({ hasMore, loading, onClick }: { hasMore: boolean; loading: boolean; onClick: () => void }) {
  if (!hasMore) return null;
  return (
    <div className={styles.loadMore}>
      <Button variant="secondary" disabled={loading} onClick={onClick}>
        {loading ? "Loading..." : "Load more"}
      </Button>
    </div>
  );
}

export function RunsPage() {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("projectId") ?? undefined;
  const [status, setStatus] = useState<RunStatusFilter>("all");
  const [state, setState] = useState<LoadState<WorkspaceGenerationRun>>(initialState<WorkspaceGenerationRun>);
  const requestIdRef = useRef(0);

  const load = useCallback(async (cursor?: string | null, signal?: AbortSignal) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, loading: !cursor, loadingMore: Boolean(cursor), error: null }));

    try {
      const workspaceId = state.workspaceId ?? (await v1Api.me()).workspaceId;
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      const payload = await v1Api.listWorkspaceGenerationRuns(
        workspaceId,
        { status, projectId, limit: PAGE_SIZE, cursor },
        signal
      );
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ workspaceId, items: cursor ? [...current.items, ...payload.runs] : payload.runs, nextCursor: payload.pagination.nextCursor, loading: false, loadingMore: false, error: null }));
    } catch (error) {
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: error instanceof Error ? error : new Error(String(error)) }));
    }
  }, [projectId, state.workspaceId, status]);

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <DashboardFrame title="Runs" description="Track generation runs in this workspace.">
      <Toolbar>
        <ToolbarField label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value as RunStatusFilter)}>
            {RUN_STATUSES.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        </ToolbarField>
      </Toolbar>
      {state.loading ? <DashboardSkeleton /> : null}
      {!state.loading && state.error ? (
        <ErrorState
          title="Unable to load runs"
          body="We couldn’t load generation runs for this workspace."
          error={state.error}
          onRetry={() => void load(null)}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          title="No runs match this filter"
          body="Start a new video or choose another status to see past generation work."
          action={<ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className={styles.list}>
            {state.items.map((run) => (
              <Link className={styles.runRow} to={`/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.runId)}`} key={run.runId}>
                <div>
                  <span className={styles.rowTitle}>{run.projectName}</span>
                  <span className={styles.rowSub}>{run.currentStageType ? titleCase(run.currentStageType) : "Preparing"} - updated {formatDate(run.updatedAt)}</span>
                </div>
                <div className={styles.progress} aria-label={`${run.progressPercent ?? 0}% complete`}>
                  <span style={{ width: `${Math.max(0, Math.min(100, run.progressPercent ?? 0))}%` }} />
                </div>
                <StatusChip status={run.status} />
              </Link>
            ))}
          </div>
          <LoadMore hasMore={Boolean(state.nextCursor)} loading={state.loadingMore} onClick={() => void load(state.nextCursor)} />
        </>
      ) : null}
    </DashboardFrame>
  );
}

export function ProjectsPage() {
  const [state, setState] = useState<LoadState<V1Project>>(initialState<V1Project>);
  const requestIdRef = useRef(0);

  const load = useCallback(async (cursor?: string | null, signal?: AbortSignal) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, loading: !cursor, loadingMore: Boolean(cursor), error: null }));

    try {
      const workspaceId = state.workspaceId ?? (await v1Api.me()).workspaceId;
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      const payload = await v1Api.listProjects({ limit: PAGE_SIZE, cursor });
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({
        workspaceId,
        items: cursor ? [...current.items, ...payload.projects] : payload.projects,
        nextCursor: payload.pagination.nextCursor,
        loading: false,
        loadingMore: false,
        error: null,
      }));
    } catch (error) {
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({
        ...current,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  }, [state.workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <DashboardFrame title="Projects" description="All active video projects in this workspace.">
      {state.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!state.loading && state.error ? (
        <ErrorState
          title="Unable to load projects"
          body="We couldn’t load projects for this workspace."
          error={state.error}
          onRetry={() => void load(null)}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Create a video to start building your project library."
          action={<ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className={`${styles.grid} ${styles.gridProjects}`}>
            {state.items.map((project) => (
              <article className={styles.projectCard} key={project.id}>
                <Link
                  className={styles.cardLink}
                  to={`/projects/${encodeURIComponent(project.id)}/storyboard`}
                  aria-label={`Open ${project.name}`}
                >
                  {project.posterUrl ? (
                    <img className={styles.poster} src={project.posterUrl} alt="" loading="lazy" />
                  ) : (
                    <div className={`${styles.poster} ${styles.posterEmpty}`} aria-hidden="true">
                      <span>{project.name.trim().charAt(0).toUpperCase() || "?"}</span>
                    </div>
                  )}
                </Link>
                <div className={styles.projectCardBody}>
                  <div>
                    <span className={styles.rowTitle}>{project.name}</span>
                    <span className={styles.rowSub}>Updated {formatDate(project.updatedAt)}</span>
                  </div>
                  <div className={styles.cardMeta}>
                    <span className={`${styles.chip} ${statusChipClass(project.status)}`}>
                      {titleCase(project.status)}
                    </span>
                    <span>{project.hasStoryboard ? "Storyboard ready" : "No storyboard yet"}</span>
                    <span>Created {formatDate(project.createdAt)}</span>
                  </div>
                </div>
                <div className={styles.cardActions}>
                  <ButtonLink
                    variant="secondary"
                    size="sm"
                    to={`/projects/${encodeURIComponent(project.id)}/storyboard`}
                  >
                    Storyboard
                  </ButtonLink>
                  <ButtonLink
                    variant="ghost"
                    size="sm"
                    to={`/library/runs?projectId=${encodeURIComponent(project.id)}`}
                  >
                    Runs
                  </ButtonLink>
                </div>
              </article>
            ))}
          </div>
          <LoadMore hasMore={Boolean(state.nextCursor)} loading={state.loadingMore} onClick={() => void load(state.nextCursor)} />
        </>
      ) : null}
    </DashboardFrame>
  );
}

export function AssetsPage() {
  const [kind, setKind] = useState<AssetKindFilter>("all");
  const [source, setSource] = useState<AssetSourceFilter>("all");
  const [state, setState] = useState<LoadState<WorkspaceAsset>>(initialState<WorkspaceAsset>);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [openingIds, setOpeningIds] = useState<Set<string>>(() => new Set());
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const toggleVisibility = useCallback(async (asset: WorkspaceAsset) => {
    const id = asset.assetId ?? asset.id;
    const previous = asset.visibility === "private" ? "private" : "public";
    const next = previous === "private" ? "public" : "private";
    setPendingIds((current) => new Set(current).add(id));
    // Optimistic flip; revert on failure.
    setState((current) => ({
      ...current,
      items: current.items.map((item) =>
        (item.assetId ?? item.id) === id ? { ...item, visibility: next } : item
      ),
    }));
    try {
      await v1Api.setAssetVisibility(asset.projectId, id, next);
    } catch {
      setState((current) => ({
        ...current,
        items: current.items.map((item) =>
          (item.assetId ?? item.id) === id ? { ...item, visibility: previous } : item
        ),
      }));
    } finally {
      setPendingIds((current) => {
        const updated = new Set(current);
        updated.delete(id);
        return updated;
      });
    }
  }, []);

  const load = useCallback(async (cursor?: string | null, signal?: AbortSignal) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, loading: !cursor, loadingMore: Boolean(cursor), error: null }));

    try {
      const workspaceId = state.workspaceId ?? (await v1Api.me()).workspaceId;
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      const payload = await v1Api.listWorkspaceAssets(workspaceId, { kind: kind as AssetKind | "all", source: source as WorkspaceAssetSource | "all", limit: PAGE_SIZE, cursor }, signal);
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ workspaceId, items: cursor ? [...current.items, ...payload.assets] : payload.assets, nextCursor: payload.pagination.nextCursor, loading: false, loadingMore: false, error: null }));
    } catch (error) {
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: error instanceof Error ? error : new Error(String(error)) }));
    }
  }, [kind, source, state.workspaceId]);

  const applyAssetMedia = useCallback((assetId: string, media: { url: string | null; thumbnailUrl?: string | null }) => {
    setState((current) => ({
      ...current,
      items: current.items.map((asset) =>
        (asset.assetId ?? asset.id) === assetId
          ? {
              ...asset,
              url: media.url ?? undefined,
              thumbnailUrl: media.thumbnailUrl ?? undefined,
            }
          : asset
      ),
    }));
  }, []);

  const openAsset = useCallback(async (asset: WorkspaceAsset) => {
    const id = asset.assetId ?? asset.id;
    if (asset.url || asset.thumbnailUrl) {
      setSelectedAssetId(id);
      return;
    }

    setOpeningIds((current) => new Set(current).add(id));
    try {
      const media = await v1Api.refreshAssetMedia(id);
      applyAssetMedia(id, media);
      setSelectedAssetId(id);
    } catch {
      setSelectedAssetId(id);
    } finally {
      setOpeningIds((current) => {
        const updated = new Set(current);
        updated.delete(id);
        return updated;
      });
    }
  }, [applyAssetMedia]);

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  const selectedIndex = selectedAssetId
    ? state.items.findIndex((asset) => (asset.assetId ?? asset.id) === selectedAssetId)
    : -1;
  const selectedAsset = selectedIndex >= 0 ? state.items[selectedIndex] : null;

  return (
    <DashboardFrame title="Assets" description="Generated and uploaded media across all projects in this workspace.">
      <Toolbar>
        <ToolbarField label="Kind">
          <select value={kind} onChange={(event) => setKind(event.target.value as AssetKindFilter)}>
            {ASSET_KINDS.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        </ToolbarField>
        <ToolbarField label="Source">
          <select value={source} onChange={(event) => setSource(event.target.value as AssetSourceFilter)}>
            {ASSET_SOURCES.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        </ToolbarField>
      </Toolbar>
      {state.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!state.loading && state.error ? (
        <ErrorState
          title="Unable to load assets"
          body="We couldn’t load media assets for this workspace."
          error={state.error}
          onRetry={() => void load(null)}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          title="No assets match this filter"
          body="Upload source media or generate assets in the studio to build the workspace library."
          action={<ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className={styles.grid}>
            {state.items.map((asset) => {
              const id = asset.assetId ?? asset.id;
              const isPrivate = asset.visibility === "private";
              return (
                <div className={styles.card} key={id}>
                  <button
                    className={styles.cardButton}
                    type="button"
                    disabled={openingIds.has(id)}
                    onClick={() => void openAsset(asset)}
                    aria-label={`View ${asset.title ?? asset.filename ?? id}`}
                  >
                    <AssetPreview asset={asset} />
                    <div className={styles.cardBody}>
                      <div><span className={styles.rowTitle}>{asset.title ?? asset.filename ?? asset.id}</span><span className={styles.rowSub}>{asset.projectName}</span></div>
                      <div className={styles.cardMeta}><span>{titleCase(asset.kind)}</span><span>{titleCase(asset.source === "upload" ? "uploaded" : asset.source)}</span><StatusChip status={asset.status} /></div>
                    </div>
                  </button>
                  <div className={styles.cardActions}>
                    <ButtonLink
                      variant="ghost"
                      size="sm"
                      to={projectCollectionPath(asset.projectId, { assetId: id })}
                    >
                      Project
                    </ButtonLink>
                    <span className={styles.visibilityLabel} data-private={isPrivate}>
                      {isPrivate ? "Private" : "Public"}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pendingIds.has(id)}
                      onClick={() => void toggleVisibility(asset)}
                    >
                      {isPrivate ? "Make public" : "Make private"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <LoadMore hasMore={Boolean(state.nextCursor)} loading={state.loadingMore} onClick={() => void load(state.nextCursor)} />
        </>
      ) : null}
      <MediaViewer
        item={selectedAsset ? assetViewerItem(selectedAsset) : null}
        hasPrevious={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < state.items.length - 1}
        onClose={() => setSelectedAssetId(null)}
        onPrevious={() => {
          if (selectedIndex > 0) setSelectedAssetId(state.items[selectedIndex - 1].assetId ?? state.items[selectedIndex - 1].id);
        }}
        onNext={() => {
          if (selectedIndex >= 0 && selectedIndex < state.items.length - 1) {
            setSelectedAssetId(state.items[selectedIndex + 1].assetId ?? state.items[selectedIndex + 1].id);
          }
        }}
        onRefresh={async (item) => {
          const next = await v1Api.refreshAssetMedia(item.id);
          applyAssetMedia(item.id, next);
          return next;
        }}
      />
    </DashboardFrame>
  );
}

function AssetPreview({ asset }: { asset: WorkspaceAsset }) {
  const src = asset.thumbnailUrl ?? asset.url;
  if (src && asset.kind === "image") return <img className={styles.media} src={src} alt="" loading="lazy" />;
  if (src && asset.kind === "video") return <video className={styles.media} src={src} muted playsInline preload="metadata" />;
  return <div className={`${styles.media} ${styles.mediaEmpty}`}><span>{titleCase(asset.kind)}</span></div>;
}

export function OutputsPage() {
  const [state, setState] = useState<LoadState<WorkspaceOutput>>(initialState<WorkspaceOutput>);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (cursor?: string | null, signal?: AbortSignal) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, loading: !cursor, loadingMore: Boolean(cursor), error: null }));

    try {
      const workspaceId = state.workspaceId ?? (await v1Api.me()).workspaceId;
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      const payload = await v1Api.listWorkspaceOutputs(workspaceId, { limit: PAGE_SIZE, cursor }, signal);
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ workspaceId, items: cursor ? [...current.items, ...payload.outputs] : payload.outputs, nextCursor: payload.pagination.nextCursor, loading: false, loadingMore: false, error: null }));
    } catch (error) {
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: error instanceof Error ? error : new Error(String(error)) }));
    }
  }, [state.workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  const selectedIndex = selectedOutputId
    ? state.items.findIndex((output) => output.artifactId === selectedOutputId)
    : -1;
  const selectedOutput = selectedIndex >= 0 ? state.items[selectedIndex] : null;

  return (
    <DashboardFrame title="Outputs" description="Finished exported videos from every project in the active workspace.">
      {state.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!state.loading && state.error ? (
        <ErrorState
          title="Unable to load outputs"
          body="We couldn’t load exported videos for this workspace."
          error={state.error}
          onRetry={() => void load(null)}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          title="No finished outputs yet"
          body="Exports appear here after a video finishes rendering successfully."
          action={<ButtonLink variant="secondary" to="/studio">Create a video</ButtonLink>}
        />
      ) : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className={`${styles.grid} ${styles.gridOutputs}`}>
            {state.items.map((output) => {
              const playbackUrl = output.playbackUrl ?? output.url;
              return (
                <article className={styles.card} key={output.artifactId}>
                  <button
                    className={styles.cardButton}
                    type="button"
                    onClick={() => setSelectedOutputId(output.artifactId)}
                    aria-label={`View ${output.projectName} output`}
                  >
                  <div className={styles.outputMedia}>
                    {playbackUrl ? <video className={styles.media} src={playbackUrl} poster={output.thumbnailUrl} muted playsInline preload="metadata" /> : output.thumbnailUrl ? <img className={styles.media} src={output.thumbnailUrl} alt="" loading="lazy" /> : <div className={`${styles.media} ${styles.mediaEmpty}`}><span>Output</span></div>}
                  </div>
                  <div className={styles.cardBody}>
                    <div><span className={styles.rowTitle}>{output.projectName}</span><span className={styles.rowSub}>Exported {formatDate(output.createdAt)}</span></div>
                    <div className={styles.cardMeta}>{output.format ? <span>{output.format.toUpperCase()}</span> : null}{formatDuration(output.durationSec) ? <span>{formatDuration(output.durationSec)}</span> : null}{output.timelineId ? <span>Timeline</span> : <span>Project</span>}</div>
                  </div>
                  </button>
                  <div className={styles.cardActions}>
                    <ButtonLink
                      variant="ghost"
                      size="sm"
                      to={projectCollectionPath(output.projectId, { timelineId: output.timelineId })}
                    >
                      Project
                    </ButtonLink>
                    <ButtonLink
                      variant="ghost"
                      size="sm"
                      to={projectWatchPath(output.projectId)}
                    >
                      Watch
                    </ButtonLink>
                  </div>
                </article>
              );
            })}
          </div>
          <LoadMore hasMore={Boolean(state.nextCursor)} loading={state.loadingMore} onClick={() => void load(state.nextCursor)} />
        </>
      ) : null}
      <MediaViewer
        item={selectedOutput ? outputViewerItem(selectedOutput) : null}
        hasPrevious={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < state.items.length - 1}
        onClose={() => setSelectedOutputId(null)}
        onPrevious={() => {
          if (selectedIndex > 0) setSelectedOutputId(state.items[selectedIndex - 1].artifactId);
        }}
        onNext={() => {
          if (selectedIndex >= 0 && selectedIndex < state.items.length - 1) {
            setSelectedOutputId(state.items[selectedIndex + 1].artifactId);
          }
        }}
      />
    </DashboardFrame>
  );
}
