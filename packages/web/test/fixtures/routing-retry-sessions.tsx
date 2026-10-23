import { useEffect, useState } from "react";
import {
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type TopicFrameDeliveryKind,
} from "@lcode/shared/lcode-protocol-v4";
import { SessionDataLayer, type SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { Button } from "@/components/ui/button.js";

const sessions = ["parent", "independent", "child"];
const snapshots = new Map<string, ConversationSnapshot>();
const subscriptions = new Map<string, string>();
const listeners = new Set<
  (frame: ConversationTopicFrame, context: { deliveryKind: TopicFrameDeliveryKind }) => void
>();
let nextSubscription = 0;
for (const [index, sessionId] of sessions.entries()) {
  snapshots.set(
    sessionId,
    conversationSnapshotSchema.parse({
      protocolVersion: 1,
      sessionId,
      logEpoch: "epoch",
      seq: 1,
      revision: 1,
      control: {
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [],
        lastError: null,
        apiRetry: {
          attempt: 5 + index * 2,
          maxAttempts: 11,
          nextRetryAt: 1000,
          reasonCode: "fault.network.unreachable",
        },
      },
      availability: Object.fromEntries(
        [
          "fork",
          "compact",
          "switchModelConfig",
          "setFollowupMode",
          "queueEdit",
          "sendQueuedNow",
          "pauseGoal",
          "resumeGoal",
        ].map((key) => [key, { allowed: true }]),
      ),
      inputRouting: { mode: "enqueue" },
      config: { provider: "fixture", model: "fixture", thought: "", followupMode: "queue" },
      usage: {
        contextWindow: null,
        cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      rows: {
        totalCount: 2,
        firstRowId: 1,
        window: [
          {
            kind: "turnHeader",
            rowId: 1,
            turnId: `turn-${sessionId}`,
            origin: "userInput",
            state: "running",
            startedAt: 1,
            createdAt: 1,
            createdAtSeq: 1,
          },
          {
            kind: "userInput",
            rowId: 2,
            turnId: `turn-${sessionId}`,
            origin: "realUser",
            text: sessionId,
            createdAt: 1,
            createdAtSeq: 1,
          },
        ],
      },
      queue: { items: [], autoDrain: true },
      pendingCommands: [],
      pendingInteractions: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
    }),
  );
}
function emit(subscriptionId: string, initial: boolean) {
  const topic = subscriptions.get(subscriptionId)!;
  const current = snapshots.get(topic.slice("conversation/".length))!;
  const frame = conversationTopicFrameSchema.parse({
    topic,
    subscriptionId,
    fromSeq: 0,
    toSeq: current.seq,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot: current },
  });
  for (const listener of listeners)
    listener(frame, { deliveryKind: initial ? "initial" : "online" });
}
const transport = {
  async subscribe({ topic }: { topic: string }) {
    const subscriptionId = `sub-${++nextSubscription}`;
    subscriptions.set(subscriptionId, topic);
    return { ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch" } };
  },
  activate: (id: string) => emit(id, true),
  async unsubscribe(id: string) {
    subscriptions.delete(id);
  },
  onFrame(listener: typeof listeners extends Set<infer T> ? T : never) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onAssemblyFault: () => () => {},
  onRuntimeRestart: () => () => {},
  plans: async () => ({ plans: [], atSeq: 1, atLogEpoch: "epoch" }),
} as unknown as ConversationTransport;
const layer = new SessionDataLayer({ transport });
const rowContext = {
  workspacePath: "/fixture",
  theme: "system" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};

export function RoutingRetrySessionsFixture() {
  const [leases, setLeases] = useState<SessionLease[]>([]);
  const [selected, setSelected] = useState("parent");
  useEffect(() => {
    const active = sessions.map((id) => layer.acquire(id));
    setLeases(active);
    return () => {
      active.forEach((lease) => lease.release());
      layer.dispose();
    };
  }, []);
  const lease = leases.find((entry) => entry.sessionId === selected) ?? null;
  const { snapshot } = useConversationProjection(lease);
  Object.assign(globalThis, {
    __retrySessions: {
      update(sessionId: string, attempt: number | null) {
        const previous = snapshots.get(sessionId)!;
        snapshots.set(sessionId, {
          ...previous,
          seq: previous.seq + 1,
          revision: previous.revision + 1,
          control: {
            ...previous.control,
            apiRetry:
              attempt === null
                ? null
                : {
                    attempt,
                    maxAttempts: 11,
                    nextRetryAt: 1000,
                    reasonCode: "fault.network.unreachable",
                  },
          },
        });
        for (const [id, topic] of subscriptions)
          if (topic === `conversation/${sessionId}`) emit(id, false);
      },
      subscriptions: () => nextSubscription,
    },
  });
  return (
    <main className="@container/conversation flex h-dvh min-w-0 flex-col text-ui-base">
      <nav className="flex flex-wrap gap-2 p-3">
        {sessions.map((id) => (
          <Button key={id} data-testid={`view-${id}`} onClick={() => setSelected(id)}>
            {id}
          </Button>
        ))}
      </nav>
      <output data-testid="view-session">{snapshot?.sessionId ?? "loading"}</output>
      {snapshot ? (
        <ConversationTimeline
          key={selected}
          rows={snapshot.rows.window}
          totalCount={snapshot.rows.totalCount}
          sessionKey={selected}
          rowContext={rowContext}
          sessionPhase={snapshot.control.phase}
          apiRetry={snapshot.control.apiRetry}
          canLoadOlder={false}
        />
      ) : null}
    </main>
  );
}
