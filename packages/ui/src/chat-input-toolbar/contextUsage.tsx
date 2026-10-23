/* eslint-disable max-lines -- context 面板聚合 Context windows、Coding Plan 和 Start Plan 三段紧耦合展示；后续拆分需要单独梳理弹层状态边界。 */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  type LCodeContextUsageBreakdownItem,
  type LCodeProvider,
} from "@lcode/shared";
import {
  Context,
  ContextContentBody,
  ContextContent,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import { Button } from "@/components/ui/button.js";
import { Dialog } from "@/components/ui/dialog.js";
import { SessionContextTrendContent } from "@/v4/composer/SessionContextTrend.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { getContextBreakdownTone } from "@/chat-input-toolbar/contextUsagePalette.js";
import { buildSessionUsageGroupModel } from "@/chat-input-toolbar/sessionUsageGroups.js";
import type { SessionUsageState } from "@lcode/shared/lcode-protocol-v4";
import {
  readDisplayableSessionTokenTotal,
  readSessionTokenTotal,
  type ChildSessionUsage,
} from "@/v4/composer/sessionTokenStats.js";
import { combineOutputSpeeds, type SessionOutputSpeed } from "@/v4/composer/sessionOutputSpeed.js";
import { SessionOutputSpeedValue } from "@/v4/composer/SessionOutputSpeedValue.js";
type ContextUsageBreakdownSource = LCodeContextUsageBreakdownItem["source"];

interface ContextUsageBreakdownSegment {
  chars: number;
  percent: number;
  source: ContextUsageBreakdownSource;
}

const PERCENT_MAX = 100;
const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78;

function formatContextUsageTokenCount(
  value: number,
  locale: string,
  options: { maximumFractionDigits?: number } = {},
): string {
  return formatCompactTokenNumber(locale, value, options);
}

function formatContextUsageSummary({
  locale,
  percent,
  size,
  used,
}: {
  locale: string;
  percent: number;
  size: number;
  used: number;
}): string {
  const percentageFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  });
  return `${formatContextUsageTokenCount(used, locale)}/${formatContextUsageTokenCount(
    size,
    locale,
    {
      maximumFractionDigits: 0,
    },
  )} (${percentageFormatter.format(percent)})`;
}

function formatContextCacheHitRateLabel(
  hitRate: number | null | undefined,
  locale: string,
  options: { showBelowThreshold?: boolean } = {},
): string | null {
  if (hitRate === null || hitRate === undefined || !Number.isFinite(hitRate)) {
    return null;
  }

  // 生产面板只露出明显缓存收益，避免低命中率分散对上下文容量的注意力；
  // 开发环境需要观察 provider 的真实低命中值，因此允许绕过 78% 展示阈值。
  if (!options.showBelowThreshold && hitRate < CACHE_HIT_RATE_DISPLAY_THRESHOLD) {
    return null;
  }

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, hitRate));
}

function getBreakdownToneStyle(source: ContextUsageBreakdownSource): CSSProperties {
  return {
    backgroundColor: getContextBreakdownTone(source),
  };
}

const BREAKDOWN_SOURCE_LABEL_ID: Record<ContextUsageBreakdownSource, string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {
  messages: 0,
  system_prompt: 1,
  meta_user_context: 2,
  skills: 3,
  tool_prompt: 4,
  system_tool_schemas: 5,
  mcp_tool_schemas: 6,
};

function buildContextUsageBreakdownSegments(
  breakdown: readonly LCodeContextUsageBreakdownItem[] | undefined,
): ContextUsageBreakdownSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of breakdown ?? []) {
    if (!Number.isFinite(item.chars) || item.chars <= 0) {
      continue;
    }
    charsBySource.set(item.source, (charsBySource.get(item.source) ?? 0) + item.chars);
  }

  const totalChars = [...charsBySource.values()].reduce((sum, chars) => sum + chars, 0);
  if (totalChars <= 0) {
    return [];
  }

  return [...charsBySource.entries()]
    .map(([source, chars]) => ({
      chars,
      percent: chars / totalChars,
      source,
    }))
    .sort(
      (left, right) =>
        right.chars - left.chars ||
        BREAKDOWN_SOURCE_ORDER[left.source] - BREAKDOWN_SOURCE_ORDER[right.source],
    );
}

function buildContextUsageProgressSegments(segments: readonly ContextUsageBreakdownSegment[]) {
  return segments.map((segment) => ({
    id: segment.source,
    percent: segment.percent,
    style: getBreakdownToneStyle(segment.source),
  }));
}

export function getRenderableTaskUsage<T extends { used: number; size: number }>(
  taskUsage: T | null,
): T | null {
  if (!taskUsage) {
    return null;
  }

  // LCode Protocol 迁移后会单独补齐真实 contextUsed/contextWindow。
  // used=0 或非法值不代表可展示的上下文占用，避免把初始化/异常兜底渲染成误导性的 0%。
  if (
    !Number.isFinite(taskUsage.used) ||
    !Number.isFinite(taskUsage.size) ||
    taskUsage.used <= 0 ||
    taskUsage.size <= 0
  ) {
    return null;
  }

  return taskUsage;
}

export function getContextCompressionCommand(_provider: LCodeProvider): string {
  return "/compact";
}

// 自动/运营完成（startedAt 为空）当前生效的 used_at；手动完成不进入触发器交互。
export function ChatContextUsage({
  taskUsage,
  contextTrend,
  sessionUsage,
  liveOutputRate = null,
  outputSpeed,
  childUsage,
  childCount = 0,
  childCurrentOutputTokens = null,
  childLiveOutputRate = null,
  childOutputSpeed,
  summaryMode = "all",
  selectedProvider: _selectedProvider,
  intl,
  locale,
}: {
  taskUsage: {
    used: number;
    size: number;
    cache?: { hitRate: number | null };
    breakdown?: LCodeContextUsageBreakdownItem[];
  } | null;
  contextTrend?: SessionUsageState["contextTrend"];
  sessionUsage?: SessionUsageState["cumulative"];
  liveOutputRate?: number | null;
  outputSpeed?: SessionOutputSpeed;
  childUsage?: ChildSessionUsage;
  childCount?: number;
  childCurrentOutputTokens?: number | null;
  childLiveOutputRate?: number | null;
  childOutputSpeed?: SessionOutputSpeed;
  /** 状态栏拥有累计与速度；旧上下文入口仅保留容量/额度摘要。 */
  summaryMode?: "all" | "context";
  selectedProvider: LCodeProvider;
  intl: ReturnType<typeof useLCodeIntl>["intl"];
  locale: string;
  onSendCompressionCommand?: (command: string) => void;
  compressionDisabled?: boolean;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [trendOpen, setTrendOpen] = useState(false);
  const contextUsageTriggerRef = useRef<HTMLElement | null>(null);
  const handleContextOpenChange = setContextOpen;
  const renderableTaskUsage = getRenderableTaskUsage(taskUsage);
  const contextPanelWidthClass = "!w-[min(20rem,calc(100dvw-1rem))]";
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const ownSessionTotal = readSessionTokenTotal(sessionUsage ?? null, taskUsage?.used);
  const childTokenTotal = (childUsage?.inputTokens ?? 0) + (childUsage?.outputTokens ?? 0);
  const sessionTokenTotal = readDisplayableSessionTokenTotal(ownSessionTotal, childTokenTotal);
  const incompleteTotal = (childUsage?.unknownCount ?? 0) > 0;
  const mainSpeed = outputSpeed ?? { liveRate: liveOutputRate, average: null, pending: false };
  const childSpeed = childOutputSpeed ?? {
    liveRate: childLiveOutputRate,
    average: null,
    pending: false,
  };
  const combinedOutputSpeed = combineOutputSpeeds([mainSpeed, childSpeed]);
  const hasOutputSpeed =
    combinedOutputSpeed.liveRate !== null ||
    combinedOutputSpeed.average !== null ||
    combinedOutputSpeed.pending;
  const contextUsageLabel = useMemo(() => {
    if (!renderableTaskUsage) {
      return null;
    }

    return intl.formatMessage(
      { id: "chat.contextUsage" },
      {
        used: numberFormatter.format(renderableTaskUsage.used),
        total: numberFormatter.format(renderableTaskUsage.size),
      },
    );
  }, [intl, numberFormatter, renderableTaskUsage]);
  const cacheHitRateLabel = useMemo(() => {
    return formatContextCacheHitRateLabel(renderableTaskUsage?.cache?.hitRate, locale, {
      showBelowThreshold: import.meta.env.DEV,
    });
  }, [locale, renderableTaskUsage]);
  const breakdownSegments = useMemo(
    () => buildContextUsageBreakdownSegments(renderableTaskUsage?.breakdown),
    [renderableTaskUsage?.breakdown],
  );
  const progressSegments = useMemo(
    () => buildContextUsageProgressSegments(breakdownSegments),
    [breakdownSegments],
  );
  const percentageFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 1,
        style: "percent",
      }),
    [locale],
  );

  if (
    (!renderableTaskUsage || !contextUsageLabel) &&
    (summaryMode === "context" || sessionTokenTotal === null) &&
    !contextTrend?.samples.length &&
    (summaryMode === "context" || !hasOutputSpeed)
  ) {
    return null;
  }

  const usagePercent = renderableTaskUsage
    ? Math.min(Math.max(renderableTaskUsage.used / renderableTaskUsage.size, 0), 1)
    : 0;
  const compactTokenUsageLabel = renderableTaskUsage
    ? formatContextUsageSummary({
        locale,
        percent: usagePercent,
        size: renderableTaskUsage.size,
        used: renderableTaskUsage.used,
      })
    : null;
  const triggerLabel = contextUsageLabel ?? intl.formatMessage({ id: "chat.contextTrend.title" });
  const sessionUsageGroups = buildSessionUsageGroupModel(childCount);
  const sessionSummaryLabel =
    sessionTokenTotal === null
      ? null
      : intl.formatMessage(
          { id: incompleteTotal ? "chat.sessionUsage.partial" : "chat.sessionUsage.summary" },
          { total: numberFormatter.format(sessionTokenTotal) },
        );
  const contextUsedTokens = renderableTaskUsage?.used ?? 0;
  const contextMaxTokens = renderableTaskUsage?.size ?? 1;

  return (
    <>
      <Context
        usedTokens={contextUsedTokens}
        maxTokens={contextMaxTokens}
        open={contextOpen}
        onOpenChange={handleContextOpenChange}
      >
        <span ref={contextUsageTriggerRef} className="inline-flex shrink-0">
          <ContextTrigger
            aria-label={[
              summaryMode === "all" ? sessionSummaryLabel : null,
              summaryMode === "context"
                ? null
                : combinedOutputSpeed.liveRate !== null
                  ? intl.formatMessage({ id: "chat.sessionUsage.speed" })
                  : combinedOutputSpeed.average !== null
                    ? intl.formatMessage({ id: "chat.sessionUsage.averageSpeed" })
                    : combinedOutputSpeed.pending
                      ? intl.formatMessage({ id: "chat.sessionUsage.speedPending" })
                      : null,
              triggerLabel,
            ]
              .filter(Boolean)
              .join(", ")}
            className="text-foreground-subtle"
            data-chat-toolbar-popover-trigger="true"
            data-testid={TID_CHAT_CONTEXT_USAGE_TRIGGER}
            summary={
              summaryMode === "context" ? (
                renderableTaskUsage ? (
                  <span className="font-mono text-ui-xs tabular-nums">
                    {intl.formatMessage({ id: "chat.tokenUsageStatusBar.context" })}{" "}
                    {percentageFormatter.format(usagePercent)}
                  </span>
                ) : undefined
              ) : sessionTokenTotal === null && !hasOutputSpeed ? undefined : (
                <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-ui-xs tabular-nums">
                  {sessionTokenTotal === null ? null : (
                    <span>
                      {incompleteTotal ? "≥" : ""}
                      {formatCompactTokenNumber(locale, sessionTokenTotal)}
                    </span>
                  )}
                  <SessionOutputSpeedValue
                    speed={combinedOutputSpeed}
                    intl={intl}
                    locale={locale}
                    compact
                  />
                </span>
              )
            }
            onPointerDown={(event) => {
              // Radix HoverCard 会在 touchstart 中阻止后续 click，手机端无法打开面板；
              // 在触摸 pointerdown 阶段先打开，桌面端继续保持原有 hover/focus 语义。
              if (
                !event.defaultPrevented &&
                event.pointerType === "touch" &&
                typeof window !== "undefined" &&
                window.matchMedia?.("(hover: none)").matches
              ) {
                // 触摸与桌面共用受控面板状态。
                if (!contextOpen) {
                  handleContextOpenChange(true);
                }
              }
            }}
          />
        </span>

        <ContextContent
          className={cn(
            contextPanelWidthClass,
            "!rounded-xl !shadow-md",
            summaryMode === "context" && "token-usage-detail token-usage-tone",
          )}
          data-usage-tone={summaryMode === "context" ? "context" : undefined}
          side="top"
          sideOffset={2}
        >
          <ContextContentBody className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
            {/* 默认 ai-elements Header 会硬编码标题并把摘要拆到独立头部。
          工具栏上下文 hover 只需要一块紧凑信息面板，摘要和明细统一放在 body 里。 */}
            {summaryMode === "all" &&
            (sessionTokenTotal !== null || hasOutputSpeed) &&
            sessionUsage ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-ui-base font-medium text-foreground">
                    <span>
                      {intl.formatMessage({
                        id: incompleteTotal
                          ? "chat.sessionUsage.partialTitle"
                          : "chat.sessionUsage.title",
                      })}
                    </span>
                    <span className="font-mono tabular-nums">
                      {incompleteTotal ? "≥" : ""}
                      {sessionTokenTotal === null ? "-" : numberFormatter.format(sessionTokenTotal)}
                    </span>
                  </div>
                </div>
                <div className="space-y-2 border-t border-border pt-3">
                  <div className="flex items-center gap-2 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-[var(--color-usage-chart-1)]"
                    />
                    <span>{intl.formatMessage({ id: "chat.sessionUsage.mainGroup" })}</span>
                  </div>
                  <div className="space-y-1.5 pl-4">
                    <div className="flex items-center justify-between gap-3 text-ui-sm text-foreground-subtle">
                      <span>{intl.formatMessage({ id: "chat.sessionUsage.mainInput" })}</span>
                      <span className="font-mono tabular-nums">
                        {numberFormatter.format(sessionUsage.inputTokens)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-ui-sm text-foreground-subtle">
                      <span>{intl.formatMessage({ id: "chat.sessionUsage.mainOutput" })}</span>
                      <span className="font-mono tabular-nums">
                        {numberFormatter.format(sessionUsage.outputTokens)}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
                      <span>{intl.formatMessage({ id: "chat.sessionUsage.mainSpeed" })}</span>
                      {mainSpeed.liveRate === null &&
                      mainSpeed.average === null &&
                      !mainSpeed.pending ? (
                        "-"
                      ) : (
                        <SessionOutputSpeedValue speed={mainSpeed} intl={intl} locale={locale} />
                      )}
                    </div>
                  </div>
                </div>
                {sessionUsageGroups.child ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex items-center gap-2 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full bg-[var(--color-usage-chart-2)]"
                      />
                      <span>
                        {intl.formatMessage(
                          { id: "chat.sessionUsage.childGroup" },
                          { count: childCount },
                        )}
                      </span>
                    </div>
                    <div className="space-y-1.5 pl-4">
                      <div className="flex items-center justify-between gap-3 text-ui-sm text-foreground-subtle">
                        <span>{intl.formatMessage({ id: "chat.sessionUsage.subagents" })}</span>
                        <span className="font-mono tabular-nums">
                          {numberFormatter.format(childTokenTotal)}
                        </span>
                      </div>
                      {childCurrentOutputTokens !== null ? (
                        <div className="flex items-center justify-between gap-3 text-ui-sm text-foreground-subtle">
                          <span>
                            {intl.formatMessage({ id: "chat.sessionUsage.childCurrentOutput" })}
                          </span>
                          <span className="font-mono tabular-nums">
                            {numberFormatter.format(childCurrentOutputTokens)}
                          </span>
                        </div>
                      ) : null}
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
                        <span>{intl.formatMessage({ id: "chat.sessionUsage.childSpeed" })}</span>
                        {childSpeed.liveRate === null &&
                        childSpeed.average === null &&
                        !childSpeed.pending ? (
                          "-"
                        ) : (
                          <SessionOutputSpeedValue speed={childSpeed} intl={intl} locale={locale} />
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {renderableTaskUsage && compactTokenUsageLabel ? (
              <div
                className={cn(
                  "space-y-2",
                  sessionTokenTotal !== null && "border-t border-border pt-3",
                )}
              >
                {/* 窄屏与大字号下标题、完整摘要可换行；不能让两个 shrink-0 项越过浮层边界。 */}
                <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: "chat.contextUsage.title" })}
                  </span>
                  <span className="ml-auto min-w-0 max-w-full text-right font-mono text-ui-sm text-foreground-subtle">
                    {compactTokenUsageLabel}
                  </span>
                </div>
                <Progress
                  className="h-2 bg-surface"
                  indicatorClassName="min-w-2"
                  segments={progressSegments}
                  value={usagePercent * PERCENT_MAX}
                />
              </div>
            ) : null}
            {renderableTaskUsage && (breakdownSegments.length > 0 || cacheHitRateLabel) ? (
              <>
                {breakdownSegments.length > 0 ? (
                  <div
                    aria-label={intl.formatMessage({
                      id: "chat.contextUsage.breakdown",
                    })}
                    className="space-y-1.5"
                  >
                    <div className="grid gap-1.5">
                      {breakdownSegments.map((segment) => (
                        <div
                          className="flex min-w-0 items-center gap-2 text-ui-sm"
                          key={segment.source}
                        >
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-sm border border-border"
                            style={getBreakdownToneStyle(segment.source)}
                          />
                          <span className="min-w-0 truncate text-foreground-subtle">
                            {intl.formatMessage({
                              id: BREAKDOWN_SOURCE_LABEL_ID[segment.source],
                            })}
                          </span>
                          {/* breakdown 行只展示占比，分项 token 数会和顶部总量口径混在一起造成误读。*/}
                          <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
                            {percentageFormatter.format(segment.percent)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {cacheHitRateLabel ? (
                  <div
                    className={cn(
                      "flex items-center justify-between gap-3 text-ui-sm",
                      breakdownSegments.length > 0 && "border-t border-border pt-3",
                    )}
                  >
                    <span className="text-foreground-subtle">
                      {intl.formatMessage({
                        id: "chat.contextUsage.cacheHitRate",
                      })}
                    </span>
                    <span className="font-mono text-ui-sm text-foreground">
                      {cacheHitRateLabel}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-ui-sm"
              onClick={() => {
                setContextOpen(false);
                setTrendOpen(true);
              }}
            >
              {intl.formatMessage({ id: "chat.contextTrend.title" })}
            </Button>
          </ContextContentBody>
        </ContextContent>
      </Context>
      <Dialog open={trendOpen} onOpenChange={setTrendOpen}>
        {trendOpen ? (
          <SessionContextTrendContent
            trend={contextTrend}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = contextUsageTriggerRef.current;
              (trigger?.querySelector("button") ?? trigger)?.focus();
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}
