import { useCallback, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { GenerationRunStatus } from "@popcorn/shared/v1/types";
import {
  type WorkspaceAsset,
  type WorkspaceAssetSource,
  type WorkspaceOutput,
} from "../lib/api-client";
import { useAuth } from "../components/auth/AuthProvider";
import { PageHeader } from "../components/ui/PageHeader";
import { Toolbar, ToolbarField } from "../components/ui/Toolbar";
import { Button, ButtonLink } from "../components/ui/Button";
import { EmptyState, ErrorState } from "../components/ui/StateCard";
import { MediaViewer, type MediaViewerItem } from "../components/media/MediaViewer";
import {
  useAssetMediaMutation,
  useAssetVisibilityMutation,
  useDashboardAssetsQuery,
  useDashboardOutputsQuery,
  useDashboardProjectsQuery,
  useDashboardRunsQuery,
} from "../lib/v1/dashboard/query";
import styles from "./DashboardCollections.module.css";

const PAGE_SIZE = 24;
const DEV_AUTOPILOT = import.meta.env.DEV;
const RUN_STATUSES = ["all", "queued", "running", "succeeded", "failed", "canceled"] as const;
const ASSET_KINDS = ["all", "image", "video", "audio"] as const;
const ASSET_SOURCES = ["all", "uploaded", "generated"] as const;

type RunStatusFilter = (typeof RUN_STATUSES)[number];
type AssetKindFilter = (typeof ASSET_KINDS)[number];
type AssetSourceFilter = (typeof ASSET_SOURCES)[number];

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

function useDashboardAuthScope() {
  const auth = useAuth();
  return auth.user?.id ?? (DEV_AUTOPILOT ? "dev-autopilot" : auth.status);
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
  const authScope = useDashboardAuthScope();
  const projectId = searchParams.get("projectId") ?? undefined;
  const [status, setStatus] = useState<RunStatusFilter>("all");
  const runsQuery = useDashboardRunsQuery(authScope, {
    status,
    projectId,
    limit: PAGE_SIZE,
  });

  return (
    <DashboardFrame title="Runs" description="Track generation runs in this workspace.">
      <Toolbar>
        <ToolbarField label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value as RunStatusFilter)}>
            {RUN_STATUSES.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        </ToolbarField>
      </Toolbar>
      {runsQuery.loading ? <DashboardSkeleton /> : null}
      {!runsQuery.loading && runsQuery.error ? (
        <ErrorState
          title="Unable to load runs"
          body="We couldn’t load generation runs for this workspace."
          error={runsQuery.error}
          onRetry={runsQuery.refetch}
        />
      ) : null}
      {!runsQuery.loading && !runsQuery.error && runsQuery.items.length === 0 ? (
        <EmptyState
          title="No runs match this filter"
          body="Start a new video or choose another status to see past generation work."
          action={<ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>}
        />
      ) : null}
      {!runsQuery.loading && !runsQuery.error && runsQuery.items.length > 0 ? (
        <>
          <div className={styles.list}>
            {runsQuery.items.map((run) => (
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
          <LoadMore hasMore={runsQuery.hasMore} loading={runsQuery.loadingMore} onClick={() => void runsQuery.fetchNextPage()} />
        </>
      ) : null}
    </DashboardFrame>
  );
}

// Poster art with a graceful fallback: rows can reference media whose bytes
// are gone (e.g. pre-storage-cutover dev assets), so a failed image load
// degrades to the initial-letter placeholder instead of a broken-image glyph.
// The failure is keyed to the URL that failed, not a sticky flag, so a
// refreshed URL on the same mounted card retries automatically.
function ProjectPoster({ name, posterUrl }: { name: string; posterUrl?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (posterUrl && posterUrl !== failedUrl) {
    return (
      <img
        className={styles.poster}
        src={posterUrl}
        alt=""
        loading="lazy"
        onError={() => setFailedUrl(posterUrl)}
      />
    );
  }
  return (
    <div className={`${styles.poster} ${styles.posterEmpty}`} aria-hidden="true">
      <span>{name.trim().charAt(0).toUpperCase() || "?"}</span>
    </div>
  );
}

export function ProjectsPage() {
  const authScope = useDashboardAuthScope();
  const projectsQuery = useDashboardProjectsQuery(authScope, PAGE_SIZE);

  return (
    <DashboardFrame title="Projects" description="All active video projects in this workspace.">
      {projectsQuery.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!projectsQuery.loading && projectsQuery.error ? (
        <ErrorState
          title="Unable to load projects"
          body="We couldn’t load projects for this workspace."
          error={projectsQuery.error}
          onRetry={projectsQuery.refetch}
        />
      ) : null}
      {!projectsQuery.loading && !projectsQuery.error && projectsQuery.items.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Create a video to start building your project library."
          action={<ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>}
        />
      ) : null}
      {!projectsQuery.loading && !projectsQuery.error && projectsQuery.items.length > 0 ? (
        <>
          <div className={`${styles.grid} ${styles.gridProjects}`}>
            {projectsQuery.items.map((project) => (
              <article className={styles.projectCard} key={project.id}>
                <Link
                  className={styles.cardLink}
                  to={`/projects/${encodeURIComponent(project.id)}/storyboard`}
                  aria-label={`Open ${project.name}`}
                >
                  <ProjectPoster name={project.name} posterUrl={project.posterUrl} />
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
          <LoadMore hasMore={projectsQuery.hasMore} loading={projectsQuery.loadingMore} onClick={() => void projectsQuery.fetchNextPage()} />
        </>
      ) : null}
    </DashboardFrame>
  );
}

export function AssetsPage() {
  const authScope = useDashboardAuthScope();
  const [kind, setKind] = useState<AssetKindFilter>("all");
  const [source, setSource] = useState<AssetSourceFilter>("all");
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [openingIds, setOpeningIds] = useState<Set<string>>(() => new Set());
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const assetFilters = { kind, source, limit: PAGE_SIZE };
  const assetsQuery = useDashboardAssetsQuery(authScope, assetFilters);
  const visibilityMutation = useAssetVisibilityMutation(authScope, assetFilters);
  const mediaMutation = useAssetMediaMutation(authScope, assetFilters);

  const toggleVisibility = useCallback(async (asset: WorkspaceAsset) => {
    const id = asset.assetId ?? asset.id;
    const previous = asset.visibility === "private" ? "private" : "public";
    const next = previous === "private" ? "public" : "private";
    setPendingIds((current) => new Set(current).add(id));
    try {
      await visibilityMutation.mutateAsync({ asset, visibility: next });
    } finally {
      setPendingIds((current) => {
        const updated = new Set(current);
        updated.delete(id);
        return updated;
      });
    }
  }, [visibilityMutation]);

  const openAsset = useCallback(async (asset: WorkspaceAsset) => {
    const id = asset.assetId ?? asset.id;
    if (asset.url || asset.thumbnailUrl) {
      setSelectedAssetId(id);
      return;
    }

    setOpeningIds((current) => new Set(current).add(id));
    try {
      await mediaMutation.mutateAsync(id);
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
  }, [mediaMutation]);

  const selectedIndex = selectedAssetId
    ? assetsQuery.items.findIndex((asset) => (asset.assetId ?? asset.id) === selectedAssetId)
    : -1;
  const selectedAsset = selectedIndex >= 0 ? assetsQuery.items[selectedIndex] : null;

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
      {assetsQuery.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!assetsQuery.loading && assetsQuery.error ? (
        <ErrorState
          title="Unable to load assets"
          body="We couldn’t load media assets for this workspace."
          error={assetsQuery.error}
          onRetry={assetsQuery.refetch}
        />
      ) : null}
      {!assetsQuery.loading && !assetsQuery.error && assetsQuery.items.length === 0 ? (
        <EmptyState
          title="No assets match this filter"
          body="Upload source media or generate assets in the studio to build the workspace library."
          action={<ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>}
        />
      ) : null}
      {!assetsQuery.loading && !assetsQuery.error && assetsQuery.items.length > 0 ? (
        <>
          <div className={styles.grid}>
            {assetsQuery.items.map((asset) => {
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
          <LoadMore hasMore={assetsQuery.hasMore} loading={assetsQuery.loadingMore} onClick={() => void assetsQuery.fetchNextPage()} />
        </>
      ) : null}
      <MediaViewer
        item={selectedAsset ? assetViewerItem(selectedAsset) : null}
        hasPrevious={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < assetsQuery.items.length - 1}
        onClose={() => setSelectedAssetId(null)}
        onPrevious={() => {
          if (selectedIndex > 0) setSelectedAssetId(assetsQuery.items[selectedIndex - 1].assetId ?? assetsQuery.items[selectedIndex - 1].id);
        }}
        onNext={() => {
          if (selectedIndex >= 0 && selectedIndex < assetsQuery.items.length - 1) {
            setSelectedAssetId(assetsQuery.items[selectedIndex + 1].assetId ?? assetsQuery.items[selectedIndex + 1].id);
          }
        }}
        onRefresh={async (item) => {
          return mediaMutation.mutateAsync(item.id);
        }}
      />
    </DashboardFrame>
  );
}

function AssetPreview({ asset }: { asset: WorkspaceAsset }) {
  // Rows can reference media whose bytes are gone (pre-storage-cutover dev
  // assets); degrade to the kind placeholder instead of a broken-image glyph.
  // Failures are keyed to the URL that failed (not a sticky flag) so a
  // refreshed signed URL on the same mounted card retries automatically, and
  // a failed video src still falls through to its thumbnail.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageSrc = asset.thumbnailUrl ?? asset.url;
  if (asset.kind === "image" && imageSrc && imageSrc !== failedSrc) {
    return <img className={styles.media} src={imageSrc} alt="" loading="lazy" onError={() => setFailedSrc(imageSrc)} />;
  }
  if (asset.kind === "video" && asset.url && asset.url !== failedSrc) {
    return <video className={styles.media} src={asset.url} poster={asset.thumbnailUrl} muted playsInline preload="metadata" onError={() => setFailedSrc(asset.url ?? null)} />;
  }
  if (asset.kind === "video" && asset.thumbnailUrl && asset.thumbnailUrl !== failedSrc) {
    return <img className={styles.media} src={asset.thumbnailUrl} alt="" loading="lazy" onError={() => setFailedSrc(asset.thumbnailUrl ?? null)} />;
  }
  return <div className={`${styles.media} ${styles.mediaEmpty}`}><span>{titleCase(asset.kind)}</span></div>;
}

export function OutputsPage() {
  const authScope = useDashboardAuthScope();
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const outputsQuery = useDashboardOutputsQuery(authScope, PAGE_SIZE);

  const selectedIndex = selectedOutputId
    ? outputsQuery.items.findIndex((output) => output.artifactId === selectedOutputId)
    : -1;
  const selectedOutput = selectedIndex >= 0 ? outputsQuery.items[selectedIndex] : null;

  return (
    <DashboardFrame title="Outputs" description="Finished exported videos from every project in the active workspace.">
      {outputsQuery.loading ? <DashboardSkeleton variant="grid" /> : null}
      {!outputsQuery.loading && outputsQuery.error ? (
        <ErrorState
          title="Unable to load outputs"
          body="We couldn’t load exported videos for this workspace."
          error={outputsQuery.error}
          onRetry={outputsQuery.refetch}
        />
      ) : null}
      {!outputsQuery.loading && !outputsQuery.error && outputsQuery.items.length === 0 ? (
        <EmptyState
          title="No finished outputs yet"
          body="Exports appear here after a video finishes rendering successfully."
          action={<ButtonLink variant="secondary" to="/studio">Create a video</ButtonLink>}
        />
      ) : null}
      {!outputsQuery.loading && !outputsQuery.error && outputsQuery.items.length > 0 ? (
        <>
          <div className={`${styles.grid} ${styles.gridOutputs}`}>
            {outputsQuery.items.map((output) => {
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
          <LoadMore hasMore={outputsQuery.hasMore} loading={outputsQuery.loadingMore} onClick={() => void outputsQuery.fetchNextPage()} />
        </>
      ) : null}
      <MediaViewer
        item={selectedOutput ? outputViewerItem(selectedOutput) : null}
        hasPrevious={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < outputsQuery.items.length - 1}
        onClose={() => setSelectedOutputId(null)}
        onPrevious={() => {
          if (selectedIndex > 0) setSelectedOutputId(outputsQuery.items[selectedIndex - 1].artifactId);
        }}
        onNext={() => {
          if (selectedIndex >= 0 && selectedIndex < outputsQuery.items.length - 1) {
            setSelectedOutputId(outputsQuery.items[selectedIndex + 1].artifactId);
          }
        }}
      />
    </DashboardFrame>
  );
}
