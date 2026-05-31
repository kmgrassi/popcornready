"use client";

import { Suspense, useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Editor } from "@/components/Editor";
import { RunProgress } from "@/components/RunProgress";

const PROJECT_ID = "default";

function StudioInner() {
  const params = useSearchParams();
  const router = useRouter();
  const goal = params.get("goal") ?? "";
  const length = Number(params.get("length")) || 30;
  const runId = params.get("runId");

  // The progress view stays mounted until the run has terminally succeeded.
  // Once it does, the editor takes over and reads the resulting project from
  // the existing /api/project endpoint that the run-execution code already
  // saved into.
  const [handedOff, setHandedOff] = useState(false);

  const onRunReady = useCallback(() => {
    setHandedOff(true);
    // Drop the runId so a subsequent refresh goes straight to the editor.
    router.replace("/studio");
  }, [router]);

  if (runId && !handedOff) {
    return (
      <RunProgress projectId={PROJECT_ID} runId={runId} onReady={onRunReady} />
    );
  }

  return <Editor initialGoal={goal} initialLength={length} />;
}

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioInner />
    </Suspense>
  );
}
