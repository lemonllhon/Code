import type { PipSessionEvent, PipSessionSnapshot } from "@lcode/lcode-cua/pip-session";
import {
  createPipSessionClient,
  type PipSessionClient,
  type PipSessionClientOptions,
} from "@lcode/lcode-cua/pip-session/node";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { CuaPipSessionService } from "./cuaPipSession.js";

type FocusEvent = Extract<PipSessionEvent, { kind: "focus-changed" }>;
type TurnStartedEvent = Extract<PipSessionEvent, { kind: "turn-started" }>;

export interface CuaPipPresentationCredentials {
  pipSocketPath: string;
  capability: string;
  generation: number;
}

type PipSessionClientResolution =
  | { client: PipSessionClient; skipReason?: never }
  | {
      client: null;
      skipReason:
        | "service-disabled"
        | "service-disposed"
        | "credentials-unavailable"
        | "transport-disabled"
        | "reconnect-backoff"
        | "reconnect-expired";
    };

const MAX_SNAPSHOT_TURNS = 256;
const RECONNECT_RETRY_MS = 250;
const RECONNECT_DEADLINE_MS = 30_000;

function eventLogContext(event: PipSessionEvent): Record<string, unknown> {
  if (event.kind === "focus-changed") {
    return {
      kind: event.kind,
      revision: event.revision,
      sessionId: event.sessionId,
      sourceWindowId: event.sourceWindowId,
    };
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    sequenceNumber: event.sequenceNumber,
    sessionId: event.sessionId,
    ...(event.kind === "session-closed" ? {} : { turnId: event.turnId }),
    ...(event.kind === "turn-ended" ? { outcome: event.outcome } : {}),
  };
}

function sameCredentials(
  left: CuaPipPresentationCredentials | null,
  right: CuaPipPresentationCredentials,
): boolean {
  return (
    left?.pipSocketPath === right.pipSocketPath &&
    left.capability === right.capability &&
    left.generation === right.generation
  );
}

function copyCredentials(
  credentials: CuaPipPresentationCredentials,
): CuaPipPresentationCredentials {
  return { ...credentials };
}

function redactCapability(message: unknown, ...capabilities: Array<string | undefined>): string {
  let safeMessage = message instanceof Error ? message.message : String(message);
  for (const capability of capabilities) {
    if (capability) safeMessage = safeMessage.replaceAll(capability, "[redacted]");
  }
  return safeMessage;
}

export function createCuaPipSessionService(options: {
  enabled: boolean;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
  createClient?: (options: PipSessionClientOptions) => PipSessionClient;
  logger?: ServiceLogger;
}): CuaPipSessionService {
  const logger = options.logger ?? createServiceLogger("cua-pip-session");
  const clientFactory = options.createClient ?? createPipSessionClient;
  const activeTurnBySession = new Map<string, TurnStartedEvent>();
  let latestFocus: FocusEvent | undefined;
  let current: {
    credentials: CuaPipPresentationCredentials;
    client: PipSessionClient;
  } | null = null;
  let disabledTransportCredentials: CuaPipPresentationCredentials | null = null;
  let lastResolvedCapability: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDeadline = 0;
  let reconnectExpired = false;
  let reconnectCredentials: CuaPipPresentationCredentials | null = null;
  let nextReconnectAttempt = 0;
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const getSnapshot = (): PipSessionSnapshot => ({
    turns: [...activeTurnBySession.values()].map((event) => ({ ...event })),
    ...(latestFocus ? { focus: { ...latestFocus } } : {}),
  });

  const eventIsNewerThanTurn = (
    event: Exclude<PipSessionEvent, FocusEvent>,
    turn: TurnStartedEvent,
  ): boolean =>
    event.sequenceNumber === undefined ||
    turn.sequenceNumber === undefined ||
    event.sequenceNumber > turn.sequenceNumber;

  const updateSnapshot = (event: PipSessionEvent): void => {
    if (event.kind === "focus-changed") {
      if (!latestFocus || event.revision > latestFocus.revision) latestFocus = { ...event };
      return;
    }
    if (event.kind === "turn-started") {
      const previous = activeTurnBySession.get(event.sessionId);
      if (previous && !eventIsNewerThanTurn(event, previous)) return;
      // 修复依据：快照必须有界且偏向最新产品事实；重复 set 不会更新 Map 顺序，
      // 所以同一 session 的新 turn 先删除再插入，容量淘汰才符合事件时序。
      activeTurnBySession.delete(event.sessionId);
      activeTurnBySession.set(event.sessionId, { ...event });
      while (activeTurnBySession.size > MAX_SNAPSHOT_TURNS) {
        const oldestSessionId = activeTurnBySession.keys().next().value;
        if (oldestSessionId === undefined) break;
        activeTurnBySession.delete(oldestSessionId);
      }
      return;
    }
    if (
      event.kind !== "turn-ended" &&
      event.kind !== "turn-completed" &&
      event.kind !== "turn-failed" &&
      event.kind !== "session-closed"
    ) {
      return;
    }
    const activeTurn = activeTurnBySession.get(event.sessionId);
    if (!activeTurn || !eventIsNewerThanTurn(event, activeTurn)) return;
    if (event.kind !== "session-closed" && event.turnId !== activeTurn.turnId) return;
    activeTurnBySession.delete(event.sessionId);
  };

  const cancelReconnectRetry = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const finishReconnectEpisode = (): void => {
    cancelReconnectRetry();
    reconnectDeadline = 0;
    reconnectExpired = false;
    nextReconnectAttempt = 0;
  };

  const recoveryExpired = (): boolean => {
    if (reconnectDeadline === 0 || Date.now() < reconnectDeadline) return false;
    if (!reconnectExpired)
      logger.warn(undefined, "[cua-pip-session] reconnect snapshot expired before transport", {
        activeTurnCount: activeTurnBySession.size,
      });
    reconnectExpired = true;
    cancelReconnectRetry();
    return true;
  };

  const getClient = async (): Promise<PipSessionClientResolution> => {
    if (!options.enabled) return { client: null, skipReason: "service-disabled" };
    if (disposed) return { client: null, skipReason: "service-disposed" };
    const resolvedCredentials = await options.resolveCredentials();
    // 凭据查询可能晚于 Host/服务关闭；迟到结果不能重新创建已释放的传输。
    if (disposed) return { client: null, skipReason: "service-disposed" };
    if (!resolvedCredentials)
      return {
        client: null,
        skipReason: recoveryExpired() ? "reconnect-expired" : "credentials-unavailable",
      };
    const credentials = copyCredentials(resolvedCredentials);
    lastResolvedCapability = credentials.capability;
    if (sameCredentials(disabledTransportCredentials, credentials)) {
      return { client: null, skipReason: "transport-disabled" };
    }
    disabledTransportCredentials = null;
    // timer 与 focus 必须走同一准入；旧实现仅限制 timer，焦点风暴仍会无限建连。
    if (!sameCredentials(reconnectCredentials, credentials)) {
      finishReconnectEpisode();
      reconnectCredentials = copyCredentials(credentials);
    }
    if (recoveryExpired()) return { client: null, skipReason: "reconnect-expired" };
    if (Date.now() < nextReconnectAttempt) return { client: null, skipReason: "reconnect-backoff" };
    if (sameCredentials(current?.credentials ?? null, credentials)) {
      const existing = current!;
      try {
        await existing.client.connect();
        if (disposed) return { client: null, skipReason: "service-disposed" };
        return { client: existing.client };
      } catch (error) {
        if ((error as { code?: unknown }).code === "version_mismatch") {
          disabledTransportCredentials = copyCredentials(existing.credentials);
          existing.client.close();
          if (current === existing) current = null;
        }
        throw error;
      }
    }
    current?.client.close();
    const client = clientFactory({
      socketPath: credentials.pipSocketPath,
      capability: credentials.capability,
      generation: credentials.generation,
      getSnapshot,
      onDiagnostic: (diagnostic) => {
        const safeMessage = redactCapability(diagnostic.message ?? "", credentials.capability);
        const message = `[cua-pip-session] ${diagnostic.code}: ${safeMessage}`;
        if (diagnostic.code === "version_mismatch") logger.warn(undefined, message);
        else logger.debug(undefined, message);
      },
    });
    current = { credentials: copyCredentials(credentials), client };
    try {
      await client.connect();
      if (disposed) return { client: null, skipReason: "service-disposed" };
      return { client };
    } catch (error) {
      if (current?.client === client) current = null;
      client.close();
      if ((error as { code?: unknown }).code === "version_mismatch") {
        disabledTransportCredentials = copyCredentials(credentials);
      }
      throw error;
    }
  };

  const scheduleReconnectRetry = (): void => {
    if (disposed) return;
    // 同一次断连只拥有一个期限和一个 timer；focus 风暴不能延长期限或饿死重试。
    if (reconnectDeadline === 0) reconnectDeadline = Date.now() + RECONNECT_DEADLINE_MS;
    if (recoveryExpired()) return;
    if (nextReconnectAttempt <= Date.now()) nextReconnectAttempt = Date.now() + RECONNECT_RETRY_MS;
    if (activeTurnBySession.size === 0) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed || activeTurnBySession.size === 0) return;
      const operation = tail.then(async () => {
        if (disposed || activeTurnBySession.size === 0) return;
        try {
          const resolution = await getClient();
          if (resolution.client) {
            finishReconnectEpisode();
            return;
          }
          if (
            resolution.skipReason === "transport-disabled" ||
            resolution.skipReason === "reconnect-expired"
          )
            return;
        } catch {
          if (disabledTransportCredentials) return;
          // Helper 冷启动期间连接失败是预期竞态；下一次有界轮询仍从同一快照恢复。
        }
        scheduleReconnectRetry();
      });
      tail = operation;
    }, RECONNECT_RETRY_MS);
    reconnectTimer.unref?.();
  };

  const publish = (event: PipSessionEvent): Promise<void> => {
    if (disposed) return Promise.resolve();
    // 产品事实先同步写入唯一镜像；网络 IO 仍串行。否则前一条慢请求会让终态滞留，
    // 期间发生的重连握手可能重新展示已经结束的 turn。
    const wasActive = activeTurnBySession.size > 0;
    updateSnapshot(event);
    if (
      (wasActive && activeTurnBySession.size === 0) ||
      (!wasActive && event.kind === "turn-started")
    )
      finishReconnectEpisode();
    const operation = tail.then(async () => {
      if (disposed) return;
      try {
        const resolution = await getClient();
        if (!resolution.client) {
          if (resolution.skipReason === "credentials-unavailable") {
            // 修复依据：Helper 晚于 turn-started 启动时不能只保存单条待补发事件；
            // focus 与多 session 状态必须作为同一握手快照原子恢复。
            scheduleReconnectRetry();
          }
          const level =
            resolution.skipReason === "service-disabled" ||
            resolution.skipReason === "service-disposed"
              ? "dropped"
              : "skipped";
          logger.debug(undefined, `[cua-pip-session] event delivery ${level}`, {
            ...eventLogContext(event),
            skipReason: resolution.skipReason,
          });
          return;
        }
        cancelReconnectRetry();
        const result = await resolution.client.send(event);
        if (disposed) return;
        finishReconnectEpisode();
        logger.info(undefined, "[cua-pip-session] event delivery acknowledged", {
          ...eventLogContext(event),
          applied: result.applied,
          reason: result.reason,
        });
      } catch (error) {
        // dispose 已清除旧 capability；迟到错误既无恢复权限，也不能越过脱敏生命周期写日志。
        if (disposed) return;
        if ((error as { code?: unknown }).code === "version_mismatch" && current) {
          disabledTransportCredentials = copyCredentials(current.credentials);
          current.client.close();
          current = null;
        }
        if ((error as { code?: unknown }).code !== "version_mismatch") scheduleReconnectRetry();
        logger.warn(undefined, "[cua-pip-session] event delivery failed", {
          ...eventLogContext(event),
          errorMessage: redactCapability(
            error,
            lastResolvedCapability,
            current?.credentials.capability,
            disabledTransportCredentials?.capability,
          ),
        });
      }
    });
    tail = operation;
    return operation;
  };

  return {
    publishFocus: publish,
    publishLifecycle: publish,
    dispose() {
      disposed = true;
      cancelReconnectRetry();
      activeTurnBySession.clear();
      latestFocus = undefined;
      current?.client.close();
      current = null;
      disabledTransportCredentials = null;
      reconnectCredentials = null;
      lastResolvedCapability = undefined;
    },
  };
}
