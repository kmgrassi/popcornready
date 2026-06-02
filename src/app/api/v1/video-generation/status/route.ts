import { NextResponse } from "next/server";
import { authMode } from "@/lib/api/v1/auth";
import { newRequestId } from "@/lib/api/v1/ids";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = newRequestId();
  const configured = Boolean(process.env.NVIDIA_API_KEY);
  const model =
    process.env.NVIDIA_VIDEO_GENERATION_MODEL || "nvidia/cosmos3-nano";
  const baseUrl =
    process.env.NVIDIA_VIDEO_GENERATION_BASE_URL ||
    "https://ai.api.nvidia.com/v1/genai";

  return NextResponse.json(
    {
      provider: {
        id: "nvidia_api_catalog",
        configured,
        model,
        baseUrl,
        capabilities: ["text_to_video", "image_to_video"],
      },
      authMode: authMode(),
      time: new Date().toISOString(),
    },
    { headers: { "X-Request-Id": requestId } }
  );
}
