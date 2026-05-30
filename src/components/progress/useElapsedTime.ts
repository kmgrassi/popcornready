"use client";

import { useEffect, useState } from "react";

// Returns the elapsed time between `startedAt` and either `completedAt` (if
// set) or "now", ticking once per second while the run is in flight. Returns
// null on the first render so server and client agree on the initial HTML.
export function useElapsedTime(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | null {
  const startMs = startedAt ? Date.parse(startedAt) : null;
  const endMs = completedAt ? Date.parse(completedAt) : null;

  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (endMs !== null || startMs === null) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startMs, endMs]);

  if (startMs === null) return null;
  if (endMs !== null) return Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (now === null) return null;
  return Math.max(0, Math.floor((now - startMs) / 1000));
}

export function formatElapsed(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    const restMm = mm % 60;
    return `${hh}h ${restMm}m ${ss}s`;
  }
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}
