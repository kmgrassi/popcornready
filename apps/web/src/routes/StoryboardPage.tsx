import { useEffect, useState } from "react";
import { StoryboardView } from "../components/storyboard/StoryboardView";
import { v1Api, type StoryboardData } from "../lib/api-client";

// Route surface for the read-only Storyboard view (storyboard-scenes PR5).
// Loads the current studio project's plan + pooled assets and hands them to
// StoryboardView, which renders Scenes → beat tiles.
export function StoryboardPage() {
  const [data, setData] = useState<StoryboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    v1Api
      .getStoryboard()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return;
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to load the storyboard."
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <StoryboardView
      plan={data?.plan ?? null}
      assets={data?.assets ?? []}
      loading={loading}
      error={error}
    />
  );
}
