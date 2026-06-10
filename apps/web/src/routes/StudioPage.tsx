import { useSearchParams } from "react-router-dom";
import { StudioShell } from "../components/studio/StudioShell";
import type { BriefDraft } from "../components/studio/useStudioFlow";

/**
 * StudioPage — the single guided wizard surface. Renders the StudioShell, which
 * owns the `initial → generating → review` state machine. Any `?goal=`/`?length=`
 * query params (e.g. from Home CTAs) seed the brief draft.
 */
export function StudioPage() {
  const [params] = useSearchParams();
  const goal = params.get("goal") ?? "";
  const length = Number(params.get("length"));
  const draftId = params.get("draft");

  const initialBrief: Partial<BriefDraft> = {
    ...(goal ? { goal } : {}),
    ...(Number.isFinite(length) && length > 0 ? { targetLengthSec: length } : {}),
  };

  return <StudioShell initialBrief={initialBrief} draftId={draftId} />;
}
