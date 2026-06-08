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
import "../styles/dashboard-collections.css";

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

function StatusChip({ status }: { status: GenerationRunStatus | WorkspaceAsset["status"] }) {
  return <span className={`dash-chip status-${status}`}>{titleCase(status)}</span>;
}

function DashboardFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <main className="dashboard-page">
      <div className="dashboard-head">
        <div>
          <p className="dashboard-kicker">Dashboard</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <Link className="dashboard-primary-action" to="/studio">New video</Link>
      </div>
      {children}
    </main>
  );
}

function DashboardError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const apiError = error instanceof ApiClientError ? error : null;
  return (
    <div className="dashboard-state dashboard-error-state" role="alert">
      <h2>Unable to load this view</h2>
      <p>{error.message}</p>
      {apiError ? (
        <dl>
          <div><dt>Code</dt><dd>{apiError.code}</dd></div>
          {apiError.requestId ? <div><dt>Request</dt><dd>{apiError.requestId}</dd></div> : null}
        </dl>
      ) : null}
      <button type="button" className="secondary" onClick={onRetry}>Retry</button>
    </div>
  );
}

function DashboardEmpty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="dashboard-state"><h2>{title}</h2><p>{body}</p>{action}</div>;
}

function DashboardSkeleton({ variant = "rows" }: { variant?: "rows" | "grid" }) {
  return (
    <div className={variant === "grid" ? "dashboard-grid" : "dashboard-list"} aria-hidden="true">
      {Array.from({ length: variant === "grid" ? 8 : 5 }, (_, index) => (
        <div className={`dashboard-skeleton ${variant}`} key={index}><span /><span /><span /></div>
      ))}
    </div>
  );
}

function LoadMore({ hasMore, loading, onClick }: { hasMore: boolean; loading: boolean; onClick: () => void }) {
  if (!hasMore) return null;
  return <div className="dashboard-load-more"><button type="button" className="secondary" disabled={loading} onClick={onClick}>{loading ? "Loading..." : "Load more"}</button></div>;
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
    <DashboardFrame title="Runs" description="Every generation run in the active workspace, newest first.">
      <div className="dashboard-toolbar">
        <label>
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as RunStatusFilter)}>
            {RUN_STATUSES.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        </label>
      </div>
      {state.loading ? <DashboardSkeleton /> : null}
      {!state.loading && state.error ? <DashboardError error={state.error} onRetry={() => void load(null)} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? <DashboardEmpty title="No runs match this filter" body="Start a new video or choose another status to see past generation work." action={<Link className="dashboard-link-button" to="/studio">Open studio</Link>} /> : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className="dashboard-list">
            {state.items.map((run) => (
              <Link className="dashboard-run-row" to={`/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.runId)}`} key={run.runId}>
                <div>
                  <span className="dashboard-row-title">{run.projectName}</span>
                  <span className="dashboard-row-sub">{run.currentStageType ? titleCase(run.currentStageType) : "Preparing"} - updated {formatDate(run.updatedAt)}</span>
                </div>
                <div className="dashboard-progress" aria-label={`${run.progressPercent ?? 0}% complete`}>
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
      <div className="dashboard-toolbar two">
        <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as AssetKindFilter)}>{ASSET_KINDS.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</select></label>
        <label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value as AssetSourceFilter)}>{ASSET_SOURCES.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</select></label>
      </div>
      {state.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!state.loading && state.error ? <DashboardError error={state.error} onRetry={() => void load(null)} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? <DashboardEmpty title="No assets match this filter" body="Upload source media or generate assets in the studio to build the workspace library." action={<Link className="dashboard-link-button" to="/studio">Open studio</Link>} /> : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className="dashboard-grid">
            {state.items.map((asset) => (
              <Link className="dashboard-asset-card" to={projectCollectionPath(asset.projectId, { assetId: asset.assetId ?? asset.id })} key={asset.assetId ?? asset.id}>
                <AssetPreview asset={asset} />
                <div className="dashboard-card-body">
                  <div><span className="dashboard-row-title">{asset.title ?? asset.filename ?? asset.id}</span><span className="dashboard-row-sub">{asset.projectName}</span></div>
                  <div className="dashboard-card-meta"><span>{titleCase(asset.kind)}</span><span>{titleCase(asset.source === "upload" ? "uploaded" : asset.source)}</span><StatusChip status={asset.status} /></div>
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
  if (src && asset.kind === "image") return <img className="dashboard-media" src={src} alt="" loading="lazy" />;
  if (src && asset.kind === "video") return <video className="dashboard-media" src={src} muted playsInline preload="metadata" />;
  return <div className="dashboard-media dashboard-media-empty"><span>{titleCase(asset.kind)}</span></div>;
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
      {!state.loading && state.error ? <DashboardError error={state.error} onRetry={() => void load(null)} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? <DashboardEmpty title="No finished outputs yet" body="Exports appear here after a video finishes rendering successfully." action={<Link className="dashboard-link-button" to="/studio">Create a video</Link>} /> : null}
      {!state.loading && !state.error && state.items.length > 0 ? (
        <>
          <div className="dashboard-grid outputs">
            {state.items.map((output) => {
              const playbackUrl = output.playbackUrl ?? output.url;
              return (
                <Link className="dashboard-output-card" to={projectCollectionPath(output.projectId, { timelineId: output.timelineId })} key={output.artifactId}>
                  <div className="dashboard-output-media">
                    {playbackUrl ? <video className="dashboard-media" src={playbackUrl} poster={output.thumbnailUrl} controls preload="metadata" /> : output.thumbnailUrl ? <img className="dashboard-media" src={output.thumbnailUrl} alt="" loading="lazy" /> : <div className="dashboard-media dashboard-media-empty"><span>Output</span></div>}
                  </div>
                  <div className="dashboard-card-body">
                    <div><span className="dashboard-row-title">{output.projectName}</span><span className="dashboard-row-sub">Exported {formatDate(output.createdAt)}</span></div>
                    <div className="dashboard-card-meta">{output.format ? <span>{output.format.toUpperCase()}</span> : null}{formatDuration(output.durationSec) ? <span>{formatDuration(output.durationSec)}</span> : null}{output.timelineId ? <span>Timeline</span> : <span>Project</span>}</div>
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
