const NODE_WARNING_LOG_PATTERN =
  /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u;

export function shouldReportHostConsoleError(args: unknown[]): boolean {
  const message = args
    .map((arg) => stringifyHostLogArg(arg))
    .join(" ")
    .trimStart();
  return !NODE_WARNING_LOG_PATTERN.test(message);
}

export function stringifyHostLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  try {
    // Error 可嵌套在 phase details/cause/AggregateError 中，普通 JSON.stringify 会丢失诊断。
    return JSON.stringify(serializeHostLogValue(arg, new WeakSet())) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function serializeHostLogValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    // 保留 Date/Buffer 等既有 JSON 表示；只补充 Error 字段，不能改变普通诊断值的形态。
    const jsonValue = value as { toJSON?: () => unknown };
    if (!(value instanceof Error) && typeof jsonValue.toJSON === "function") {
      const projected = jsonValue.toJSON();
      if (projected !== value) return serializeHostLogValue(projected, ancestors);
    }
    if (Array.isArray(value)) return value.map((item) => serializeHostLogValue(item, ancestors));
    const fields: Record<string, unknown> = { ...value };
    if (value instanceof Error) {
      Object.assign(fields, { name: value.name, message: value.message, stack: value.stack });
      if (value.cause !== undefined) fields.cause = value.cause;
      if (value instanceof AggregateError) fields.errors = value.errors;
    }
    return Object.fromEntries(
      Object.entries(fields).map(([key, item]) => [key, serializeHostLogValue(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}
