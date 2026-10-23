import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
import { CodeHighlightCache } from "./codeHighlightCache.js";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

const cache = new CodeHighlightCache<
  TokenizedCode,
  HighlighterGeneric<BundledLanguage, BundledTheme>
>({
  maxEntries: 128,
  maxBytes: 8 * 1024 * 1024,
  maxEngines: 4,
  createEngine: async (language, theme) =>
    createHighlighter({ langs: [language as BundledLanguage], themes: [theme as BundledTheme] }),
  tokenize: (engine, code, language, theme) => {
    const result = engine.codeToTokens(code, {
      lang: language as BundledLanguage,
      theme: theme as BundledTheme,
    });
    return { bg: "transparent", fg: result.fg ?? "inherit", tokens: result.tokens };
  },
  estimateBytes: (key, result) =>
    key.length * 2 +
    result.tokens.reduce(
      (sum, line) =>
        sum +
        24 +
        line.reduce(
          (bytes, token) => bytes + 96 + token.content.length * 2 + (token.color?.length ?? 0) * 2,
          0,
        ),
      0,
    ),
  onError: (error) => logger.warn("[ShikiHighlighter] 代码高亮失败", error),
});
uiMemoryDiagnosticsRegistry.register("shiki", () => {
  const stats = cache.stats();
  return {
    tokensCache: stats.entries,
    highlighters: stats.engines,
    estimatedBytes: stats.bytes,
    inflight: stats.inflight,
    subscribers: stats.subscribers,
    evictions: stats.evictions,
  };
});

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  return cache.highlight(code, resolvedLanguage, resolvedTheme, callback);
};

/** 释放当前组件的回调，不取消其他预览正在使用的同键高亮。 */
export function unsubscribeHighlightCode(
  code: string,
  language: string,
  theme: BundledTheme | undefined,
  callback: (result: TokenizedCode) => void,
): void {
  cache.unsubscribe(code, normalizeCodeLanguage(language), getResolvedCodeTheme(theme), callback);
}
