const NO_THOUGHT_LEVEL_VALUES = new Set([
  "disabled",
  "false",
  "no",
  "none",
  "nothink",
  "no-think",
  "no_think",
  "off",
]);

// 关闭档位的判断独立于标签渲染，供滑块与输入框的纯视觉投影共用。
export function isNoThoughtLevel(entry: { value: string }): boolean {
  return NO_THOUGHT_LEVEL_VALUES.has(entry.value.trim().toLowerCase());
}
