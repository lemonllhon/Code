import { useMemo, useRef, useState } from "react";
import type { IModelSelectionService, ModelSelectionView } from "@lcode/services";
import type { CommandAck, SessionConfigState } from "@lcode/shared/lcode-protocol-v4";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { usePermissionModeSwitch } from "@/v4/composer/usePermissionModeSwitch.js";
import {
  createComposerSubmissionConfig,
  isComposerPermissionSubmissionCurrent,
} from "@/v4/composer/composerSubmissionConfig.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { persistV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

const fixture = {
  requests: [] as { sessionId: string | null; mode: string }[],
  sends: [] as unknown[],
  errors: [] as string[],
  hold: false,
  fail: false,
  project: true,
  release: () => {},
  holdSend: false,
  releaseSend: () => {},
  prepared: 0,
  changeScope: () => {},
  changeOwner: () => {},
  seedLegacyDraft: () => {},
  externalMode: (_mode: "build" | "edit" | "yolo") => {},
  grant: (_mode: "build" | "edit" | "yolo", _id: string) => {},
};
Object.assign(globalThis, { __permissions: fixture });

/** 使用真实 Draft owner、权限请求 hook 和 Composer，只替换 Host 网络响应。 */
export function PermissionModeFixture({
  view,
  existing,
}: {
  view: ModelSelectionView;
  existing: boolean;
}) {
  const workspacePath = "/fixture/permission-switch";
  const selection = {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "high", speed: "fast" },
  };
  const [sessionId, setSessionId] = useState<string | null>(existing ? "existing" : null);
  const [owner, setOwner] = useState({});
  const [config, setConfig] = useState<Partial<SessionConfigState>>({
    mode: "build",
    permissionModeVersion: "initial",
    modelSelection: selection,
  });
  const modelService = useMemo(
    () =>
      ({
        getView: async (input?: { selection?: unknown }) => ({
          ...view,
          effectiveSelection: input?.selection ?? selection,
        }),
        onDidChange: () => ({ dispose() {} }),
      }) as unknown as IModelSelectionService,
    [view],
  );
  const draft = useDraftConfigControl({
    workspacePath,
    sessionId,
    sessionConfig: config,
    agentStartupAllowed: false,
    modelSelectionService: modelService,
  });
  const pendingRef = useRef(false);
  const currentBinding = useRef({ sessionId, owner });
  currentBinding.current = { sessionId, owner };
  const barrier = useMemo(() => createConfigCommandBarrier(), []);
  const permission = usePermissionModeSwitch({
    scopeKey: JSON.stringify([workspacePath, sessionId]),
    owner,
    pendingRef,
    barrier,
    commit: sessionId
      ? async (mode) => {
          fixture.requests.push({ sessionId, mode });
          if (fixture.hold)
            await new Promise<void>((resolve) => {
              fixture.release = resolve;
            });
          if (
            !fixture.fail &&
            fixture.project &&
            currentBinding.current.sessionId === sessionId &&
            currentBinding.current.owner === owner
          ) {
            setConfig((current) => ({
              ...current,
              mode,
              permissionModeVersion: `menu-${fixture.requests.length}`,
            }));
          }
          return { status: fixture.fail ? "failed" : "accepted" } as CommandAck;
        }
      : null,
    onCommitted: draft.handleDraftSwitchMode,
    onError: (error) => {
      fixture.errors.push(String(error));
    },
  });
  fixture.changeScope = () => {
    setConfig({ mode: "build", modelSelection: selection });
    setSessionId("other");
  };
  fixture.changeOwner = () => {
    setOwner({});
  };
  fixture.grant = (mode, interactionId) =>
    setConfig((current) => ({
      ...current,
      ...(current.permissionGrant?.interactionId === interactionId
        ? {}
        : { mode, permissionModeVersion: interactionId }),
      permissionGrant: { mode, interactionId },
    }));
  fixture.seedLegacyDraft = () =>
    persistV4ComposerDraft(workspacePath, undefined, "existing", {
      text: "",
      mode: "yolo",
      modelSelection: selection,
    });
  fixture.externalMode = (mode) =>
    setConfig((current) => ({
      ...current,
      mode,
      permissionModeVersion: `${current.permissionModeVersion}-external`,
      permissionGrant: undefined,
    }));
  const submission = () =>
    pendingRef.current ? null : createComposerSubmissionConfig(draft.draftConfigRef.current, view);
  return (
    <main className="flex h-dvh flex-col justify-end bg-background text-foreground">
      <output data-testid="permission-draft">
        {JSON.stringify({
          mode: draft.draftConfig.mode,
          plan: draft.draftConfig.planEnabled,
          pending: permission.pending,
          sessionId,
        })}
      </output>
      <ConversationComposer
        workspacePath={workspacePath}
        sessionId={sessionId}
        draftMode={!sessionId}
        draftConfig={draft.draftConfig}
        composerDraft={draft.composerDraft}
        updateComposerContent={draft.updateComposerContent}
        replaceComposerDraft={draft.replaceComposerDraft}
        createSubmissionFromComposer={submission}
        submissionReady={!permission.pending && submission() !== null}
        permissionModePending={permission.pending}
        modelSelectionView={view}
        modelSelectionState={{ status: "ready", view }}
        onSwitchMode={(mode) => {
          if (mode === "build" || mode === "edit" || mode === "yolo") permission.switchMode(mode);
          else draft.handleDraftSwitchMode(mode);
        }}
        onSendText={async (_text, options) => {
          fixture.prepared++;
          if (fixture.holdSend)
            await new Promise<void>((resolve) => {
              fixture.releaseSend = resolve;
            });
          if (!isComposerPermissionSubmissionCurrent(options?.submission, submission()))
            return "blocked";
          fixture.sends.push(options?.submission);
          if (!sessionId) {
            setConfig((current) => ({
              ...current,
              mode: options!.submission!.mode,
              permissionModeVersion: "first-send",
            }));
            draft.promoteComposerDraft("created");
            setSessionId("created");
          }
        }}
        onStop={() => {}}
        onSelectModel={() => {}}
        onSelectThought={() => {}}
        onSelectSpeed={() => {}}
      />
    </main>
  );
}
