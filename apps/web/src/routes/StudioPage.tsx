import { useSearchParams } from "react-router-dom";
import { Editor } from "../components/Editor";

export function StudioPage() {
  const [params] = useSearchParams();
  const goal = params.get("goal") ?? "";
  const length = Number(params.get("length")) || 30;

  return <Editor initialGoal={goal} initialLength={length} />;
}
