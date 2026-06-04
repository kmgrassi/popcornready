import { Router } from "express";
import { route } from "@/core/adapter";

export const meRouter = Router();

meRouter.get(
  "/me",
  route(async ({ auth }) => ({
    status: 200,
    body: {
      actor: auth.actor,
      workspaceId: auth.workspaceId,
      authMode: auth.mode,
      isLocal: auth.isLocal,
    },
  }))
);
