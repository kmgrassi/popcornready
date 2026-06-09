import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AssetKind, GenerationRunStatus } from "@popcorn/shared/v1/types";
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
  return `/projects?${params.toString()}`;
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

function DashboardFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Dashboard"
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
      const payload = await v1Api.listWorkspaceGenerationRuns(workspaceId, { status, limit: PAGE_SIZE, cursor }, signal);
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ workspaceId, items: cursor ? [...current.items, ...payload.runs] : payload.runs, nextCursor: payload.pagination.nextCursor, loading: false, loadingMore: false, error: null }));
    } catch (error) {
      if (isStaleRequest(signal, requestId, requestIdRef.current)) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: error instanceof Error ? error : new Error(String(error)) }));
    }
  }, [state.workspaceId, status]);

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

export function AssetsPage() {
  const [kind, setKind] = useState<AssetKindFilter>("all");
  const [source, setSource] = useState<AssetSourceFilter>("all");
  const [state, setState] = useState<LoadState<WorkspaceAsset>>(initialState<WorkspaceAsset>);
  const requestIdRef = useRef(0);

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

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

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
            {state.items.map((asset) => (
              <Link className={styles.card} to={projectCollectionPath(asset.projectId, { assetId: asset.assetId ?? asset.id })} key={asset.assetId ?? asset.id}>
                <AssetPreview asset={asset} />
                <div className={styles.cardBody}>
                  <div><span className={styles.rowTitle}>{asset.title ?? asset.filename ?? asset.id}</span><span className={styles.rowSub}>{asset.projectName}</span></div>
                  <div className={styles.cardMeta}><span>{titleCase(asset.kind)}</span><span>{titleCase(asset.source === "upload" ? "uploaded" : asset.source)}</span><StatusChip status={asset.status} /></div>
                </div>
              </Link>
            ))}
          </div>
          <LoadMore hasMore={Boolean(state.nextCursor)} loading={state.loadingMore} onClick={() => void load(state.nextCursor)} />
        </>
      ) : null}
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
                <Link className={styles.card} to={projectCollectionPath(output.projectId, { timelineId: output.timelineId })} key={output.artifactId}>
                  <div className={styles.outputMedia}>
                    {playbackUrl ? <video className={styles.media} src={playbackUrl} poster={output.thumbnailUrl} controls preload="metadata" /> : output.thumbnailUrl ? <img className={styles.media} src={output.thumbnailUrl} alt="" loading="lazy" /> : <div className={`${styles.media} ${styles.mediaEmpty}`}><span>Output</span></div>}
                  </div>
                  <div className={styles.cardBody}>
                    <div><span className={styles.rowTitle}>{output.projectName}</span><span className={styles.rowSub}>Exported {formatDate(output.createdAt)}</span></div>
                    <div className={styles.cardMeta}>{output.format ? <span>{output.format.toUpperCase()}</span> : null}{formatDuration(output.durationSec) ? <span>{formatDuration(output.durationSec)}</span> : null}{output.timelineId ? <span>Timeline</span> : <span>Project</span>}</div>
                  </div>
                </Link>
              );
            })}
          </div>
          <LoadMore hasMore={Boolean(state.nextCursor)} loading={state.loadingMore} onClick={() => void load(state.nextCursor)} />
        </>
      ) : null}
    </DashboardFrame>
  );
}
