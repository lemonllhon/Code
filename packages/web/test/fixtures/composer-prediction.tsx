import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { appSettingsSchema, type IPlatformService } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useComposerPrediction } from "@/hooks/useComposerPrediction.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { LexicalChatInput } from "@/LexicalChatInput.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import "@lcode/ui/styles.css";

let enabled = true;
let release: (() => void) | undefined;
const bridge = {
  calls: 0,
  settled: 0,
  submits: [] as string[],
  drafts: [] as string[],
  held: false,
};
Object.assign(window, { __prediction: bridge });
const listeners = new Set<() => void>();
const services = {
  settingService: {
    get: async () => appSettingsSchema.parse({ composerPredictionsEnabled: enabled }),
    update: async (patch: { composerPredictionsEnabled?: boolean }) => {
      enabled = patch.composerPredictionsEnabled ?? enabled;
    },
  },
  lcodeAgentService: {
    generateWorkspaceText: async () => {
      bridge.calls++;
      if (bridge.held)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      bridge.settled++;
      return { text: "补充断线重连的回归验证", finishReason: "stop" };
    },
  },
} as unknown as IServiceAccessor;
const platform = {
  onSettingsChanged: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  syncAppSettings: () => listeners.forEach((listener) => listener()),
} as unknown as IPlatformService;

function Fixture() {
  const [phase, setPhase] = useState(
    new URLSearchParams(location.search).has("recovery") ? "completedSuccess" : "running",
  );
  const [liveUpdate, setLiveUpdate] = useState(true);
  const [round, setRound] = useState(1);
  const [session, setSession] = useState("session-one");
  const [workspace, setWorkspace] = useState("/fixture-workspace");
  const [text, setText] = useState("");
  const [active, setActive] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const { settings, update } = useSettings();
  const snapshot = useMemo(
    () =>
      ({
        sessionId: session,
        control: { phase, canStop: phase === "running" },
        config: { modelSelection: { providerId: "fixture", modelId: "model" } },
        queue: { items: blocked ? [{}] : [] },
        pendingInteractions: [],
        pendingCommands: [],
        backgroundWorks: [],
        goal: null,
        rows: {
          window: [
            {
              kind: "turnHeader",
              turnId: `turn-${round}`,
              origin: "userInput",
              executionKind: "agent",
              state: phase,
            },
            {
              kind: "assistantText",
              turnId: `turn-${round}`,
              entityId: `assistant-${round}`,
              state: phase === "running" ? "streaming" : "complete",
              text: "Fixed.",
            },
          ],
        },
      }) as ConversationSnapshot,
    [blocked, phase, round, session],
  );
  const prediction = useComposerPrediction({
    liveUpdate,
    workspacePath: workspace,
    sessionId: session,
    snapshot,
    active,
    hasDraft: text.length > 0,
  });
  return (
    <main className="min-h-dvh bg-background p-4 text-ui-base text-foreground" data-fixture-ready>
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => {
            setLiveUpdate(true);
            setRound((value) => value + 1);
            setPhase("running");
          }}
          data-testid="start"
        >
          Start
        </button>
        <button onClick={() => setPhase("completedSuccess")} data-testid="complete">
          Complete
        </button>
        <button
          data-testid="recover"
          onClick={() => {
            setLiveUpdate(false);
            setPhase("completedSuccess");
          }}
        >
          Recovery snapshot
        </button>
        <button
          onClick={() => {
            bridge.held = !bridge.held;
          }}
          data-testid="hold"
        >
          Hold
        </button>
        <button onClick={() => release?.()} data-testid="release">
          Release
        </button>
        <button
          onClick={() =>
            setSession((value) => (value === "session-one" ? "session-two" : "session-one"))
          }
          data-testid="switch-session"
        >
          Session
        </button>
        <button
          onClick={() =>
            setWorkspace((value) =>
              value === "/fixture-workspace" ? "/other-workspace" : "/fixture-workspace",
            )
          }
          data-testid="switch-workspace"
        >
          Workspace
        </button>
        <button onClick={() => setActive((value) => !value)} data-testid="active">
          Active
        </button>
        <button onClick={() => setBlocked((value) => !value)} data-testid="queue">
          Queue
        </button>
        <button
          onClick={() =>
            void update({ composerPredictionsEnabled: !settings?.composerPredictionsEnabled })
          }
          data-testid="setting"
        >
          Setting: {String(settings?.composerPredictionsEnabled)}
        </button>
      </div>
      <div className="relative max-w-xl rounded-lg border border-border p-3">
        <LexicalChatInput
          workspacePath={workspace}
          taskId={session}
          inputTestId="prediction-editor"
          placeholder="输入消息"
          enableMentionPanel={false}
          enableSlashPanel={false}
          predictionText={prediction.text}
          onPredictionDismiss={prediction.dismiss}
          onChange={(value) => {
            setText(value);
            bridge.drafts.push(value);
          }}
          onSubmit={(value) => {
            bridge.submits.push(value);
            return false;
          }}
        />
      </div>
      <output data-testid="draft">{text}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <TabStoreProvider>
        <LCodeIntlProvider initialLocale="zh-CN">
          <Fixture />
        </LCodeIntlProvider>
      </TabStoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
