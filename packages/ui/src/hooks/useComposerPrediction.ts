import { useCallback, useEffect, useRef, useState } from "react";
import { CancellationToken } from "@lcode/rpc";
import {
  isComposerPredictionText,
  COMPOSER_PREDICTION_QUERY_SOURCE,
  COMPOSER_PREDICTION_TIMEOUT_MS,
} from "@lcode/shared";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { useSettings } from "./useSettingService.js";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { composerPredictionBoundary } from "@/v4/composer/composerPredictionPolicy.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { logger } from "@/logger.js";

export function useComposerPrediction(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  active: boolean;
  liveUpdate: boolean;
  hasDraft: boolean;
}) {
  const { settings } = useSettings();
  const resolution = useWorkspaceServicesResolution(
    input.workspacePath,
    input.remoteSessionId,
    input.workspaceIdentity,
  );
  const service = resolution.services.lcodeAgentService;
  const enabled = settings?.composerPredictionsEnabled === true;
  const scope = JSON.stringify([
    input.workspaceIdentity?.trim() || input.workspacePath,
    resolution.remoteSessionId,
    input.sessionId,
  ]);
  const boundary = composerPredictionBoundary(input.snapshot);
  const phase = input.snapshot?.control.phase;
  const selection = input.snapshot?.config.modelSelection;
  const eligible =
    enabled &&
    input.liveUpdate &&
    input.active &&
    !input.hasDraft &&
    resolution.rpcReady &&
    Boolean(selection && boundary);
  const [suggestion, setSuggestion] = useState<{
    scope: string;
    boundary: string;
    text: string;
  } | null>(null);
  const previous = useRef({ scope, phase, boundary, active: input.active });
  const flight = useRef<AbortController | null>(null);
  const current = useRef({ scope, boundary, eligible });
  current.current = { scope, boundary, eligible };
  const dismiss = useCallback(() => {
    flight.current?.abort();
    flight.current = null;
    setSuggestion(null);
  }, []);

  useEffect(() => {
    const last = previous.current;
    previous.current = { scope, phase, boundary, active: input.active };
    if (!eligible || scope !== last.scope) {
      dismiss();
      return;
    }
    if (boundary !== last.boundary) dismiss();
    if (
      !last.active ||
      last.phase !== "running" ||
      phase !== "completedSuccess" ||
      document.visibilityState !== "visible" ||
      !selection ||
      !input.sessionId ||
      !boundary
    )
      return;
    dismiss();
    const controller = new AbortController();
    flight.current = controller;
    const revision = getComposerDraftRevision(input.workspacePath, input.workspaceIdentity);
    void service
      .generateWorkspaceText(
        {
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
          selection,
          composerPrediction: { sessionId: input.sessionId, boundaryMessageId: boundary },
          querySource: COMPOSER_PREDICTION_QUERY_SOURCE,
          requestTimeoutMs: COMPOSER_PREDICTION_TIMEOUT_MS + 5000,
        },
        CancellationToken.fromAbortSignal(controller.signal),
      )
      .then((result) => {
        if (
          controller.signal.aborted ||
          flight.current !== controller ||
          current.current.scope !== scope ||
          current.current.boundary !== boundary ||
          !current.current.eligible ||
          document.visibilityState !== "visible" ||
          revision !== getComposerDraftRevision(input.workspacePath, input.workspaceIdentity)
        )
          return;
        const text = result.text.trim();
        if (!result.toolCalls?.length && isComposerPredictionText(text))
          setSuggestion(text ? { scope, boundary, text } : null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          logger.debug("Composer prediction unavailable", {
            code: error instanceof Error ? error.name : "unknown",
          });
      });
  }, [
    boundary,
    dismiss,
    eligible,
    input.active,
    input.sessionId,
    input.workspaceIdentity,
    input.workspacePath,
    phase,
    resolution.remoteSessionId,
    scope,
    selection,
    service,
  ]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") dismiss();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      dismiss();
    };
  }, [dismiss, scope, service]);
  return {
    text:
      eligible && suggestion?.scope === scope && suggestion.boundary === boundary
        ? suggestion.text
        : "",
    dismiss,
  };
}
