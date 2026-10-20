import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@lcode/services";
import { resolveComposerModelEmphasis } from "./composerModelEmphasis.js";

function catalog(ids: string[], levels = ["disabled", "low", "high"]) {
  return {
    revision: 1,
    providers: [
      {
        providerId: "fixture",
        models: ids.map((modelId) => ({
          modelId,
          config: { enabled: true, optionSpecs: { reasoningLevel: { values: levels } } },
        })),
      },
    ],
  } as unknown as ModelSelectionView;
}

function selection(modelId = "custom-model", reasoningLevel = "low", providerId = "fixture") {
  return { providerId, modelId, options: { reasoningLevel, speed: "fast" } };
}

test("最高思考档位来自当前模型目录，未知名称仍可触发且不修改选择", () => {
  const view = catalog(["custom-model"], ["off", "economy", "deep"]);
  const chosen = selection("custom-model", "deep");
  const before = JSON.stringify({ view, chosen });
  assert.equal(resolveComposerModelEmphasis(chosen, view), 1);
  assert.equal(resolveComposerModelEmphasis(selection("custom-model", "economy"), view), 0);
  assert.equal(JSON.stringify({ view, chosen }), before);
});

test("空、非法、关闭和单一开启档位不构成最高思考", () => {
  for (const value of ["", "missing", "disabled"]) {
    assert.equal(
      resolveComposerModelEmphasis(selection("custom-model", value), catalog(["custom-model"])),
      0,
    );
  }
  for (const levels of [["enabled"], ["off", "enabled"], ["low", "off"]]) {
    assert.equal(
      resolveComposerModelEmphasis(
        selection("custom-model", levels.at(-1)),
        catalog(["custom-model"], levels),
      ),
      0,
    );
  }
});

test("目录、模型或供应商不匹配时不强调，禁用模型也不触发", () => {
  const chosen = selection("custom-model", "high");
  assert.equal(resolveComposerModelEmphasis(chosen, null), 0);
  assert.equal(resolveComposerModelEmphasis(null, catalog(["custom-model"])), 0);
  assert.equal(resolveComposerModelEmphasis(chosen, catalog(["other"])), 0);
  assert.equal(
    resolveComposerModelEmphasis(
      selection("custom-model", "high", "other"),
      catalog(["custom-model"]),
    ),
    0,
  );
  const view = catalog(["custom-model"]);
  const disabled = {
    ...view,
    providers: [
      {
        ...view.providers[0]!,
        models: [
          {
            ...view.providers[0]!.models[0]!,
            config: { ...view.providers[0]!.models[0]!.config, enabled: false },
          },
        ],
      },
    ],
  };
  assert.equal(resolveComposerModelEmphasis(chosen, disabled), 0);
});

test("已知高端系列比较版本与同版等级，不使用展示顺序或轻量模型", () => {
  const cases = [
    ["gpt-6.1-sol", ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-mini"]],
    ["gpt-6-astra", ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-pro"]],
    ["claude-fable-5-1", ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5"]],
    ["claude-opus-5", ["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"]],
    [
      "google/gemini-3.1-pro-preview",
      ["google/gemini-3-pro", "google/gemini-3.1-pro-preview", "gemini-3.8-flash"],
    ],
    ["GLM-5.3", ["GLM-5.2", "GLM-5.3", "GLM-5.3-Flash"]],
    ["kimi-k3", ["kimi-k2.7-code", "kimi-k3"]],
    ["MiniMax-M3", ["MiniMax-M2.7", "MiniMax-M3"]],
    ["deepseek-v4-pro", ["deepseek-v3.2", "deepseek-v4-pro", "deepseek-v4.1-flash"]],
    ["qwen/qwen3.8-max", ["qwen/qwen3.7-max", "qwen/qwen3.8-max", "qwen/qwen3.8-flash"]],
    ["mimo-v2.5-pro", ["mimo-v2.5", "mimo-v2.5-pro"]],
    ["grok-4.7", ["grok-4.6", "grok-4.7", "grok-4.7-fast"]],
  ] as const;
  for (const [flagship, ids] of cases) {
    const view = catalog([...ids]);
    for (const modelId of ids) {
      assert.equal(
        resolveComposerModelEmphasis(selection(modelId), view) > 0,
        modelId === flagship,
        modelId,
      );
    }
  }
});

test("网关中各厂商独立比较，日期别名等价，其他供应商不影响当前旗舰", () => {
  const view = catalog(["anthropic/claude-opus-5", "claude-opus-5-20261001", "openai/gpt-6-astra"]);
  for (const model of view.providers[0]!.models) {
    assert.ok(resolveComposerModelEmphasis(selection(model.modelId), view) > 0);
  }
  const isolated = {
    ...view,
    providers: [
      ...view.providers,
      {
        ...view.providers[0]!,
        providerId: "other",
        models: catalog(["gpt-99-astra"]).providers[0]!.models,
      },
    ],
  };
  assert.ok(resolveComposerModelEmphasis(selection("openai/gpt-6-astra"), isolated) > 0);
});

test("同一旗舰的关闭、低、高、最高档逐级增强，任意目录长度均按相对进度投影", () => {
  const ids = ["gpt-6.1-sol"];
  for (const levels of [
    ["disabled", "low", "high", "ultra"],
    ["off", "economy", "balanced", "deep", "maximum"],
  ]) {
    const view = catalog(ids, levels);
    const before = JSON.stringify(view);
    const strengths = levels.map((level) =>
      resolveComposerModelEmphasis(selection(ids[0], level), view),
    );
    assert.equal(strengths[0], 0.28);
    assert.equal(strengths.at(-1), 1);
    for (let index = 1; index < strengths.length; index++) {
      assert.ok(strengths[index]! > strengths[index - 1]!);
    }
    assert.equal(resolveComposerModelEmphasis(selection(ids[0], "invalid"), view), 0.28);
    assert.equal(JSON.stringify(view), before);
  }
});
